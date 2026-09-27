import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type FauxProviderRegistration, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionRunner } from "../../src/core/extensions/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createPersonalHarnessExtension } from "../../src/personal-harness/extension.ts";
import { PersonalMemoryStore } from "../../src/personal-harness/memory/index.ts";
import { branchIdForEntries } from "../../src/personal-harness/session-data.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { getMessageText } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

interface TurnEntryResult {
	entryId: string;
	entryType: string;
	contentStatus: string;
	content?: string;
	rawJson?: string;
}

interface TurnResult {
	status: "ready" | "not-found";
	entries: TurnEntryResult[];
}

interface SearchResult {
	status: string;
	candidates: { entryId: string; excerpt: string }[];
}

interface PersistentSession {
	session: AgentSession;
	sessionManager: SessionManager;
	fauxProvider: FauxProviderRegistration;
	memoryDatabasePath: string;
	dispose(): Promise<void>;
}

async function createPersistentSession(
	root: string,
	dataDir: string,
	sessionFile?: string,
): Promise<PersistentSession> {
	const cwd = join(root, "project");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });

	const fauxProvider = registerFauxProvider();
	fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: fauxProvider.api,
		models: fauxProvider.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			inputLimits: registeredModel.inputLimits,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});

	const sessionManager = sessionFile
		? SessionManager.open(sessionFile, sessionDir, cwd)
		: SessionManager.create(cwd, sessionDir, { id: "transcript-integration" });
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const extensionsResult = await createTestExtensionsResult(
		[createPersonalHarnessExtension({ dataDir, todoDebounceMs: 60_000 })],
		cwd,
	);
	const agent = new Agent({
		getApiKey: () => "faux-key",
		streamFn: streamSimple,
		initialState: { model, systemPrompt: "", tools: [] },
		convertToLlm,
		onPayload: async (payload) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) return payload;
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) return;
			await runner.emit({ type: "after_provider_response", status: response.status, headers: response.headers });
		},
		transformContext: async (messages: AgentMessage[]) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		allowedToolNames: ["eval", "memory", "recall", "notes"],
		extensionRunnerRef,
	});
	let disposed = false;
	return {
		session,
		sessionManager,
		fauxProvider,
		memoryDatabasePath: join(dataDir, "memory.sqlite"),
		async dispose(): Promise<void> {
			if (disposed) return;
			disposed = true;
			try {
				await session.dispose();
			} finally {
				fauxProvider.unregister();
			}
		},
	};
}

async function callMemoryTool<T>(fixture: PersistentSession, input: Parameters<typeof fauxToolCall>[1]): Promise<T> {
	fixture.fauxProvider.setResponses([
		fauxAssistantMessage([fauxToolCall("memory", input)], { stopReason: "toolUse" }),
		fauxAssistantMessage("Memory operation completed."),
	]);
	await fixture.session.prompt("Use the personal memory tool for this stored session operation.");
	const entry = fixture.sessionManager
		.getBranch()
		.findLast(
			(candidate) =>
				candidate.type === "message" &&
				candidate.message.role === "toolResult" &&
				candidate.message.toolName === "memory",
		);
	if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
		throw new Error("The memory tool result was not persisted");
	}
	const text = getMessageText(entry.message);
	if (entry.message.isError) throw new Error(`Memory tool returned an error: ${text}`);
	return JSON.parse(text) as T;
}

describe("personal harness persisted transcript integration", () => {
	const sessions: PersistentSession[] = [];
	const roots: string[] = [];

	afterEach(async () => {
		while (sessions.length > 0) await sessions.pop()!.dispose();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("mirrors saved turns independently from FTS failures, separates sibling leaves, and rebuilds on restore", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transcript-session-"));
		roots.push(root);
		const firstDataDir = join(root, "private-first");
		mkdirSync(firstDataDir, { recursive: true });
		const memoryDatabasePath = join(firstDataDir, "memory.sqlite");
		const seed = new PersonalMemoryStore({ databasePath: memoryDatabasePath });
		seed.close();
		const blockedIndex = new DatabaseSync(memoryDatabasePath);
		blockedIndex.exec(`
			CREATE TRIGGER block_transcript_fixture_index
			BEFORE INSERT ON memory_sources
			BEGIN
				SELECT RAISE(ABORT, 'fixture index failure');
			END;
		`);
		blockedIndex.close();

		const first = await createPersistentSession(root, firstDataDir);
		sessions.push(first);
		first.fauxProvider.setResponses([fauxAssistantMessage("The first answer carries recovery alpha marker.")]);
		await first.session.prompt("Record the first persisted user turn.");

		const firstBranch = first.sessionManager.getBranch();
		const firstUser = firstBranch.find((entry) => entry.type === "message" && entry.message.role === "user");
		const firstAssistant = firstBranch.findLast(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		if (!firstUser || firstUser.type !== "message" || !firstAssistant || firstAssistant.type !== "message") {
			throw new Error("The first user and assistant entries were not persisted");
		}

		const afterIndexFailure = await callMemoryTool<TurnResult>(first, {
			action: "read-turn",
			sessionId: first.sessionManager.getSessionId(),
			userTurnId: firstUser.id,
			leafEntryId: firstAssistant.id,
		});
		expect(afterIndexFailure.status).toBe("ready");
		const userEntryIndex = firstBranch.findIndex((entry) => entry.id === firstUser.id);
		const assistantEntryIndex = firstBranch.findIndex((entry) => entry.id === firstAssistant.id);
		const turnEntries = firstBranch.slice(userEntryIndex, assistantEntryIndex + 1);
		expect(afterIndexFailure.entries.map((entry) => entry.entryId)).toEqual(turnEntries.map((entry) => entry.id));
		expect(afterIndexFailure.entries.map((entry) => entry.entryType)).toEqual(turnEntries.map((entry) => entry.type));
		expect(afterIndexFailure.entries.every((entry) => entry.contentStatus === "not-indexed")).toBe(true);
		expect(afterIndexFailure.entries.find((entry) => entry.entryId === firstUser.id)).toMatchObject({
			contentStatus: "not-indexed",
		});
		expect(afterIndexFailure.entries.find((entry) => entry.entryId === firstAssistant.id)).toMatchObject({
			contentStatus: "not-indexed",
		});
		expect(afterIndexFailure.entries.some((entry) => "rawJson" in entry)).toBe(false);

		const unblockedIndex = new DatabaseSync(memoryDatabasePath);
		unblockedIndex.exec("DROP TRIGGER block_transcript_fixture_index;");
		unblockedIndex.close();
		first.fauxProvider.setResponses([fauxAssistantMessage("The follow-up turn confirms the retry path.")]);
		await first.session.prompt("Continue after the temporary index failure.");

		const recoveredSearch = await callMemoryTool<SearchResult>(first, {
			action: "search",
			query: "recovery alpha marker",
			sessionId: first.sessionManager.getSessionId(),
		});
		expect(recoveredSearch.status).toBe("matches");
		expect(recoveredSearch.candidates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					entryId: firstAssistant.id,
					excerpt: expect.stringContaining("recovery alpha marker"),
				}),
			]),
		);

		const branchA = first.sessionManager.getBranch();
		const secondUser = branchA.findLast((entry) => entry.type === "message" && entry.message.role === "user");
		const secondAssistant = branchA.findLast(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		if (!secondUser || secondUser.type !== "message" || !secondAssistant || secondAssistant.type !== "message") {
			throw new Error("The follow-up turn was not persisted");
		}

		first.sessionManager.branch(firstUser.id);
		const branchBAssistantId = first.sessionManager.appendMessage(
			fauxAssistantMessage("The sibling branch carries beta marker only."),
		);
		const branchBLineage = first.sessionManager.getBranch();
		const branchBTurnEntries = branchBLineage.slice(branchBLineage.findIndex((entry) => entry.id === firstUser.id));
		await first.session.navigateTree(secondAssistant.id, { summarize: false });
		const branchAId = branchIdForEntries(
			first.sessionManager.getEntries(),
			first.sessionManager.getBranch(),
			first.sessionManager.getSessionId(),
		);
		await first.session.navigateTree(branchBAssistantId, { summarize: false });
		const branchBId = branchIdForEntries(
			first.sessionManager.getEntries(),
			first.sessionManager.getBranch(),
			first.sessionManager.getSessionId(),
		);

		const branchARead = await callMemoryTool<TurnResult>(first, {
			action: "read-turn",
			sessionId: first.sessionManager.getSessionId(),
			userTurnId: firstUser.id,
			leafEntryId: secondAssistant.id,
		});
		const branchBRead = await callMemoryTool<TurnResult>(first, {
			action: "read-turn",
			sessionId: first.sessionManager.getSessionId(),
			userTurnId: firstUser.id,
			leafEntryId: branchBAssistantId,
		});
		expect(branchARead.entries.map((entry) => entry.entryId)).toEqual(
			firstBranch.slice(userEntryIndex).map((entry) => entry.id),
		);
		expect(branchARead.entries.map((entry) => entry.content).join("\n")).toContain("recovery alpha marker");
		expect(branchARead.entries.map((entry) => entry.content).join("\n")).not.toContain("beta marker");
		expect(branchBRead.entries.map((entry) => entry.entryId)).toEqual(branchBTurnEntries.map((entry) => entry.id));
		expect(branchBRead.entries.map((entry) => entry.content).join("\n")).toContain("beta marker only");
		expect(branchBRead.entries.map((entry) => entry.content).join("\n")).not.toContain("recovery alpha marker");
		for (const entry of [...branchARead.entries, ...branchBRead.entries]) {
			expect(entry).not.toHaveProperty("rawJson");
		}

		const branchASearch = await callMemoryTool<SearchResult>(first, {
			action: "search",
			query: "alpha marker",
			sessionId: first.sessionManager.getSessionId(),
			branchId: branchAId,
		});
		const branchBSearch = await callMemoryTool<SearchResult>(first, {
			action: "search",
			query: "beta marker",
			sessionId: first.sessionManager.getSessionId(),
			branchId: branchBId,
		});
		expect(branchASearch.candidates.map((entry) => entry.entryId)).toContain(firstAssistant.id);
		expect(branchASearch.candidates.map((entry) => entry.entryId)).not.toContain(branchBAssistantId);
		expect(branchBSearch.candidates.map((entry) => entry.entryId)).toContain(branchBAssistantId);
		expect(branchBSearch.candidates.map((entry) => entry.entryId)).not.toContain(firstAssistant.id);

		const customUser = first.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "message" && entry.message.role === "user");
		if (!customUser) throw new Error("No user turn precedes the final custom entry");
		first.sessionManager.appendCustomEntry("transcript-session-fixture-custom", { marker: "after-last-turn" });
		const customEntry = first.sessionManager.getBranch().at(-1);
		if (!customEntry || customEntry.type !== "custom") throw new Error("The non-message entry was not appended");
		const sessionFile = first.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("The persisted session file path is unavailable");
		await first.dispose();

		const savedLines = readFileSync(sessionFile, "utf8").trimEnd().split(/\r?\n/u);
		const savedCustomLine = savedLines.find((line) => {
			const entry = JSON.parse(line) as { id?: string };
			return entry.id === customEntry.id;
		});
		if (!savedCustomLine) throw new Error("The final custom entry is missing from the saved JSONL");
		const copied = new DatabaseSync(memoryDatabasePath);
		const rawRow = copied
			.prepare("SELECT raw_json FROM memory_transcript_entries WHERE session_id = ? AND entry_id = ?")
			.get(first.sessionManager.getSessionId(), customEntry.id) as { raw_json: string } | undefined;
		copied.close();
		expect(rawRow?.raw_json).toBe(savedCustomLine);

		const firstReader = new PersonalMemoryStore({ databasePath: memoryDatabasePath });
		try {
			const customTurn = firstReader.readTurn(first.sessionManager.getSessionId(), customUser.id, customEntry.id);
			expect(customTurn.entries).toContainEqual(
				expect.objectContaining({
					entryId: customEntry.id,
					entryType: "custom",
					contentStatus: "not-indexed",
				}),
			);
			expect(customTurn.entries.find((entry) => entry.entryId === customEntry.id)).not.toHaveProperty("rawJson");
		} finally {
			firstReader.close();
		}

		const restored = await createPersistentSession(root, join(root, "private-restored"), sessionFile);
		sessions.push(restored);
		restored.fauxProvider.setResponses([fauxAssistantMessage("Restored session is ready.")]);
		await restored.session.prompt("Open the saved session and verify reconstruction.");
		const restoredBranchASearch = await callMemoryTool<SearchResult>(restored, {
			action: "search",
			query: "alpha marker",
			sessionId: restored.sessionManager.getSessionId(),
			branchId: branchAId,
		});
		const restoredBranchBSearch = await callMemoryTool<SearchResult>(restored, {
			action: "search",
			query: "beta marker",
			sessionId: restored.sessionManager.getSessionId(),
			branchId: branchBId,
		});
		expect(restoredBranchASearch.candidates.map((entry) => entry.entryId)).toContain(firstAssistant.id);
		expect(restoredBranchASearch.candidates.map((entry) => entry.entryId)).not.toContain(branchBAssistantId);
		expect(restoredBranchBSearch.candidates.map((entry) => entry.entryId)).toContain(branchBAssistantId);
		expect(restoredBranchBSearch.candidates.map((entry) => entry.entryId)).not.toContain(firstAssistant.id);

		const rebuilt = await callMemoryTool<{ status: string }>(restored, { action: "rebuild-transcript" });
		expect(rebuilt.status).toBe("rebuilt");
		const restoredBranchBRead = await callMemoryTool<TurnResult>(restored, {
			action: "read-turn",
			sessionId: restored.sessionManager.getSessionId(),
			userTurnId: firstUser.id,
			leafEntryId: branchBAssistantId,
		});
		expect(restoredBranchBRead.entries.map((entry) => entry.entryId)).toEqual(
			branchBTurnEntries.map((entry) => entry.id),
		);
	});
});
