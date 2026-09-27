import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "../../src/core/extensions/types.ts";
import {
	applyContextProjection,
	CONTEXT_PRUNE_ENTRY,
	CONTEXT_PRUNE_MARKER,
	collectContextCandidates,
	evaluateContextCandidates,
	IMAGE_PROJECTION_ENTRY,
	LIGHT_COMPACT_ENTRY,
	legacyProjection,
	type ThinkingReplayCompatibility,
} from "../../src/personal-harness/hooks/context-prune.ts";
import { installHooks } from "../../src/personal-harness/hooks/index.ts";
import { buildAdviceContext } from "../../src/personal-harness/hooks/input-advice.ts";
import {
	isRecord,
	type JevAnswer,
	type JevEvaluationInput,
	type JevEvaluationResponse,
	type JevEvaluator,
} from "../../src/personal-harness/hooks/jev-types.ts";
import {
	collectRead,
	READ_ENTRY,
	type ReadObservationEvent,
	rankCandidates,
} from "../../src/personal-harness/hooks/reread.ts";
import { TODO_SESSION_ENTRY_TYPE } from "../../src/personal-harness/todo/state.ts";
import { HarnessUsageLedger } from "../../src/personal-harness/usage.ts";
import { createHarness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("personal harness hooks", () => {
	it("projects selected entry-bound spans and retains prior light/image projections", async () => {
		const messages = [
			{ role: "user", content: "Prior task." },
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "call-old", name: "read" },
					{ type: "toolCall", id: "call-new", name: "read" },
				],
			},
			{
				role: "toolResult",
				toolCallId: "call-old",
				toolName: "read",
				isError: false,
				content: [
					{
						type: "text",
						text: "an older result with useful detail and enough context to exceed the fixed omission marker safely",
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "call-new",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "the newest result remains visible" }],
			},
			{ role: "assistant", stopReason: "stop", content: [] },
			{ role: "user", content: "Keep this current request visible." },
		];
		const entryIds = ["old-user", "call-entry", "result-old", "result-new", "old-assistant-final", "latest-user"];
		const gathered = collectContextCandidates(messages, entryIds);
		expect(gathered.candidates).toHaveLength(1);
		const candidate = gathered.candidates[0]!;
		const evaluate: JevEvaluator = async (input: JevEvaluationInput): Promise<JevEvaluationResponse> => {
			const id = Object.keys(input.questions)[0]!;
			return {
				model: "jev-latest",
				answers: {
					[id]: {
						type: "choice",
						choice: "omit",
						confidence: 0.95,
						probabilities: { keep: 0.02, omit: 0.96, uncertain: 0.02 },
					},
				},
				usage: { input_tokens: 40, output_tokens: 3 },
			};
		};
		const decision = await evaluateContextCandidates(
			messages,
			entryIds,
			gathered.candidates,
			evaluate,
			new AbortController().signal,
		);
		expect(decision.selected.map((item) => item.id)).toEqual([candidate.id]);
		const projected = applyContextProjection(messages, entryIds, [candidate]);
		expect(projected[2]).toMatchObject({ content: [{ text: expect.stringContaining(CONTEXT_PRUNE_MARKER) }] });
		expect(messages[2]).toMatchObject({
			content: [
				{
					text: "an older result with useful detail and enough context to exceed the fixed omission marker safely",
				},
			],
		});

		const imageData = "iVBORw0KGgo=";
		const imageMessage = {
			role: "toolResult",
			toolCallId: "screen-call",
			toolName: "screen",
			content: [{ type: "image", mimeType: "image/png", data: imageData }],
		};
		const oldText = "older repeated output";
		const lightHash = createHash("sha256")
			.update(JSON.stringify([oldText]))
			.digest("hex");
		const imageHash = createHash("sha256").update("image/png").update("\0").update(imageData).digest("hex");
		const restored = legacyProjection(
			[
				{
					role: "toolResult",
					toolCallId: "move-call",
					toolName: "move",
					content: [{ type: "text", text: oldText }],
				},
				imageMessage,
			],
			[
				{
					type: "custom",
					customType: LIGHT_COMPACT_ENTRY,
					data: { version: 1, targets: [{ callId: "move-call", toolName: "move", fingerprint: lightHash }] },
				},
				{
					type: "custom",
					customType: IMAGE_PROJECTION_ENTRY,
					data: {
						version: 1,
						targets: [
							{
								callId: "screen-call",
								toolName: "screen",
								blockIndex: 0,
								hash: imageHash,
								replacement: "[image omitted: old screen]",
							},
						],
					},
				},
			],
		);
		expect(restored[0]).toMatchObject({ content: [{ text: "[omitted duplicate]" }] });
		expect(restored[1]).toMatchObject({ content: [{ text: "[image omitted: old screen]" }] });
	});

	it("keeps input advice bound to raw input and excludes likely credentials", () => {
		const expanded = "Use the skill body from C:\\skills\\test\\SKILL.md";
		const rawInput = "/skill:test inspect the handler";
		const entries = [{ type: "message", id: "user-entry", message: { role: "user", content: expanded } }];
		const prepared = buildAdviceContext(
			entries,
			"Please inspect the handler",
			5,
			false,
			new Map([["user-entry", rawInput]]),
		);
		expect(prepared.status).toBe("ready");
		if (prepared.status === "ready") {
			expect(prepared.input.questions).toHaveProperty("outcome");
			expect(JSON.stringify(prepared.input.state)).toContain(rawInput);
			expect(JSON.stringify(prepared.input.state)).not.toContain(expanded);
		}
		const unavailable = buildAdviceContext(entries, "Please inspect the handler");
		expect(unavailable.status).toBe("ready");
		if (unavailable.status === "ready") {
			expect(JSON.stringify(unavailable.input.state)).toContain("[本人入力の出自未確認");
			expect(JSON.stringify(unavailable.input.state)).not.toContain(expanded);
		}
		const sensitiveHistory = buildAdviceContext(
			entries,
			"Please inspect the handler",
			5,
			false,
			new Map([["user-entry", "api_key=sk-0123456789abcdefghijk"]]),
		);
		expect(JSON.stringify(sensitiveHistory)).not.toContain("sk-0123456789abcdefghijk");
		expect(buildAdviceContext([], "api_key=sk-0123456789abcdefghijk").status).toBe("sensitive");
	});

	it("stores only read metadata and ranks eligible rereads against the latest TODO", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-hook-reread-"));
		try {
			const sourcePath = join(root, "source.ts");
			const sourceText = "const important = 1;\nexport { important };";
			await writeFile(sourcePath, sourceText, "utf8");
			const event: ReadObservationEvent = {
				toolName: "read",
				toolCallId: "read-call",
				input: { path: "source.ts" },
				details: { resolvedPath: sourcePath, displayContent: { text: sourceText, lineNumbers: [1, 2] } },
				isError: false,
			};
			const observations = await collectRead(event, root, [root]);
			expect(observations).toHaveLength(1);
			expect(JSON.stringify(observations)).not.toContain(sourceText);
			const entries = [
				{ type: "message", id: "user-1", message: { role: "user", content: "Investigate the module safely" } },
				{
					type: "custom",
					id: "todo-1",
					customType: TODO_SESSION_ENTRY_TYPE,
					data: { items: [{ id: "todo-1", title: "Check the module contract", status: "in_progress" }] },
				},
				{ type: "custom", id: "read-1", customType: READ_ENTRY, data: observations[0] },
			] as unknown as SessionEntry[];
			const evaluate: JevEvaluator = async (input: JevEvaluationInput): Promise<JevEvaluationResponse> => {
				const id = Object.keys(input.questions)[0]!;
				return {
					model: "jev-latest",
					answers: {
						[id]: { type: "score", score: 4, legend: { low: "not needed", high: "needed" }, confidence: 0.9 },
					},
					usage: { input_tokens: 20, output_tokens: 2 },
				};
			};
			const ranking = await rankCandidates({
				entries,
				snapshot: "read-1",
				roots: [root],
				evaluate,
				signal: new AbortController().signal,
			});
			expect(ranking.status).toBe("ranked");
			expect(ranking.selections).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

it("runs jev-compact only when explicitly invoked and applies entry-bound results", async () => {
	const handlers = new Map<string, unknown[]>();
	const commands = new Map<string, RegisteredCommand["handler"]>();
	const branch: SessionEntry[] = [];
	const messages: AgentMessage[] = [
		{
			role: "user",
			content: "This was a completed earlier topic with enough detail to assess independently.",
			timestamp: 1,
		},
		{ role: "user", content: "Keep the current task and its constraints in view.", timestamp: 2 },
	];
	branch.push(
		{
			type: "message",
			id: "old-user",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			message: messages[0]!,
		},
		{
			type: "message",
			id: "leaf-1",
			parentId: "old-user",
			timestamp: new Date(2).toISOString(),
			message: messages[1]!,
		},
	);
	const appendEntry = vi.fn((customType: string, data: unknown) => {
		branch.push({
			type: "custom",
			customType,
			data,
			id: "prune-entry",
			parentId: "leaf-1",
			timestamp: new Date(3).toISOString(),
		});
	});
	const pi = {
		on(name: string, handler: unknown) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
			return () => undefined;
		},
		registerCommand(name: string, options: { handler: RegisteredCommand["handler"] }) {
			commands.set(name, options.handler);
		},
		appendEntry,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => undefined,
		sendUserMessage: () => undefined,
	} as unknown as ExtensionAPI;
	const release = vi.fn();
	const hold = vi.fn(() => release);
	let evaluatedInput: JevEvaluationInput | undefined;
	const evaluate: JevEvaluator = vi.fn(async (input: JevEvaluationInput): Promise<JevEvaluationResponse> => {
		evaluatedInput = input;
		const id = Object.keys(input.questions)[0]!;
		return {
			model: "jev-latest",
			answers: {
				[id]: {
					type: "choice",
					choice: "omit",
					confidence: 0.95,
					probabilities: { keep: 0.02, omit: 0.96, uncertain: 0.02 },
				},
			},
			usage: { input_tokens: 40, output_tokens: 3 },
		};
	});
	const projection = {
		entries: branch.map((sourceEntry, index) => ({ sourceEntry, messages: [messages[index]!] })),
		messages,
	};
	const context = {
		cwd: process.cwd(),
		ui: { notify: vi.fn() },
		sessionManager: {
			getSessionId: () => "session-1",
			getLeafId: () => "leaf-1",
			getBranch: () => branch,
			getHeader: () => null,
			buildSessionProjection: () => projection,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	installHooks(pi, { evaluate, hold, ledger: new HarnessUsageLedger() });

	const contextHandler = handlers.get("context")?.[0] as
		| ((event: ContextEvent, context: ExtensionContext) => ContextEventResult | undefined)
		| undefined;
	expect(contextHandler).toBeDefined();
	contextHandler?.({ type: "context", messages }, context);
	expect(evaluate).not.toHaveBeenCalled();

	expect(commands.has("light-compact")).toBe(false);
	const jevCompact = commands.get("jev-compact");
	expect(jevCompact).toBeDefined();
	await jevCompact?.("", context as unknown as ExtensionCommandContext);
	expect(evaluate).toHaveBeenCalledTimes(1);
	expect(appendEntry).toHaveBeenCalledWith(
		CONTEXT_PRUNE_ENTRY,
		expect.objectContaining({
			version: 2,
			sessionId: "session-1",
			sourceLeafId: "leaf-1",
			assessment: expect.objectContaining({
				evaluated: 1,
				omitted: 1,
				unjudged: expect.objectContaining({ count: 0 }),
			}),
		}),
	);
	expect(evaluatedInput).toBeDefined();
	const question = Object.values(evaluatedInput!.questions)[0];
	expect(question?.instructions).toMatch(/^Candidate ID: [a-f0-9]{24}\n/);
	const projected = contextHandler?.({ type: "context", messages }, context)?.messages;
	expect(projected?.[0]).toMatchObject({ content: expect.stringContaining(CONTEXT_PRUNE_MARKER) });
	expect(projected?.[1]).toEqual(messages[1]);
	expect(release).toHaveBeenCalledTimes(1);
});

it("reapplies repeated jev-compact ranges to the original SessionManager projection", async () => {
	const originalUserText = "A completed old user request contains enough detail to judge omission safely. ".repeat(
		180,
	);
	const oldReasoning = "This historical reasoning item is long enough to be assessed and removed as a whole.";
	const oldAnswer = "The earlier assistant answer has a useful conclusion that is no longer needed here.";
	const evaluatedInputs: JevEvaluationInput[][] = [[], []];
	const providerInputs: unknown[][] = [];
	const contextEvents: unknown[][] = [];
	let commandContext: ExtensionContext | undefined;
	let commandInvocation = 0;

	const evaluate: JevEvaluator = async (input) => {
		const evaluationIndex = commandInvocation;
		evaluatedInputs[evaluationIndex]!.push(input);
		const candidates =
			isRecord(input.state) && Array.isArray(input.state.candidates)
				? (input.state.candidates as unknown[]).filter(isRecord)
				: [];
		const answers: Record<string, JevAnswer> = {};
		for (const id of Object.keys(input.questions)) {
			const candidate = candidates.find((value) => value.id === id);
			const range = candidate && Array.isArray(candidate.characterRange) ? candidate.characterRange : [];
			const omit =
				(evaluationIndex === 0 &&
					((candidate?.role === "user" && range[0] === 0) || candidate?.kind === "thinking")) ||
				(evaluationIndex === 1 &&
					((candidate?.role === "user" && range[0] === 4096) ||
						(candidate?.role === "assistant" && candidate?.kind === "text" && candidate?.blockIndex === 1)));
			answers[id] = {
				type: "choice",
				choice: omit ? "omit" : "keep",
				confidence: 0.9,
				probabilities: omit
					? { keep: 0.05, omit: 0.9, uncertain: 0.05 }
					: { keep: 0.9, omit: 0.05, uncertain: 0.05 },
			};
		}
		return { model: "jev-fixture", answers, usage: { input_tokens: 20, output_tokens: 2 } };
	};

	const extensions = await createTestExtensionsResult([
		(pi) => {
			pi.on("context", (event, context) => {
				contextEvents.push(event.messages);
				commandContext = context;
			});
			installHooks(pi, { evaluate, hold: () => () => {}, ledger: new HarnessUsageLedger() });
		},
	]);
	const command = [...(extensions.extensions[0]?.commands.values() ?? [])].find(
		(registered) => registered.name === "jev-compact",
	);
	expect(command).toBeDefined();
	if (!command) throw new Error("The jev-compact command was not registered");

	const harness = await createHarness({
		resourceLoader: createTestResourceLoader({ extensionsResult: extensions }),
	});
	try {
		const systemEntryId = harness.sessionManager.appendMessage({
			role: "system",
			content: "SYSTEM_INSTRUCTION_SENTINEL: preserve this instruction.",
			timestamp: 1,
		});
		const oldUserEntryId = harness.sessionManager.appendMessage({
			role: "user",
			content: originalUserText,
			timestamp: 2,
		});
		const oldAssistantEntryId = harness.sessionManager.appendMessage({
			...fauxAssistantMessage(oldAnswer),
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-6-luna",
			content: [
				{ type: "thinking", thinking: oldReasoning, thinkingSignature: "opaque-reasoning-fixture" },
				{ type: "text", text: oldAnswer },
			],
		});
		const activeModel = harness.getModel();
		harness.sessionManager.appendModelChange(activeModel.provider, activeModel.id);
		harness.sessionManager.appendCompaction("Stored handoff summary.", oldUserEntryId, 12_000);

		harness.setResponses([
			(context) => {
				providerInputs.push(context.messages);
				return fauxAssistantMessage("Initial response.");
			},
			(context) => {
				providerInputs.push(context.messages);
				return fauxAssistantMessage("Response after jev-compact.");
			},
		]);
		await harness.session.prompt("CURRENT_TASK_SENTINEL: keep this live turn visible.");

		const projection = harness.sessionManager.buildSessionProjection();
		expect(projection.entries.some((entry) => entry.sourceEntry.id === systemEntryId)).toBe(false);
		expect(projection.messages[0]).toMatchObject({
			role: "system",
			content: expect.stringContaining("SYSTEM_INSTRUCTION_SENTINEL"),
		});
		expect(contextEvents[0]?.some((message) => isRecord(message) && message.role === "system")).toBe(false);
		expect(commandContext).toBeDefined();
		if (!commandContext) throw new Error("ExtensionRunner did not provide a command context");

		await command.handler("", commandContext as unknown as ExtensionCommandContext);
		commandInvocation = 1;
		await command.handler("", commandContext as unknown as ExtensionCommandContext);

		expect(evaluatedInputs.every((invocation) => invocation.length > 0)).toBe(true);
		const firstCandidates = evaluatedInputs[0]!.flatMap((input) =>
			isRecord(input.state) && Array.isArray(input.state.candidates)
				? (input.state.candidates as unknown[]).filter(isRecord)
				: [],
		);
		const secondCandidates = evaluatedInputs[1]!.flatMap((input) =>
			isRecord(input.state) && Array.isArray(input.state.candidates)
				? (input.state.candidates as unknown[]).filter(isRecord)
				: [],
		);
		expect
			.soft(firstCandidates.some((candidate) => candidate.kind === "thinking" && candidate.blockIndex === 0))
			.toBe(false);
		expect
			.soft(
				secondCandidates.some(
					(candidate) =>
						candidate.role === "user" &&
						Array.isArray(candidate.characterRange) &&
						candidate.characterRange[0] === 4096 &&
						!String(candidate.content).includes(CONTEXT_PRUNE_MARKER),
				),
			)
			.toBe(true);
		expect
			.soft(
				secondCandidates.some(
					(candidate) => candidate.role === "assistant" && candidate.kind === "text" && candidate.blockIndex === 1,
				),
			)
			.toBe(true);
		expect
			.soft(secondCandidates.every((candidate) => !String(candidate.content).includes(CONTEXT_PRUNE_MARKER)))
			.toBe(true);

		const pruneTargets = harness.sessionManager.getBranch().flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== CONTEXT_PRUNE_ENTRY || !isRecord(entry.data)) return [];
			return Array.isArray(entry.data.targets) ? entry.data.targets.filter(isRecord) : [];
		});
		const userTargets = pruneTargets.filter((target) => target.entryId === oldUserEntryId);
		expect.soft(userTargets.map((target) => [target.start, target.end])).toEqual([
			[0, 4096],
			[4096, 8192],
		]);
		const expectedUserFingerprint = createHash("sha256").update(`text\0${originalUserText}`).digest("hex");
		expect.soft(userTargets.every((target) => target.fingerprint === expectedUserFingerprint)).toBe(true);
		expect.soft(pruneTargets).toContainEqual(
			expect.objectContaining({
				entryId: oldAssistantEntryId,
				blockIndex: 1,
				kind: "text",
			}),
		);
		expect.soft(pruneTargets).not.toContainEqual(
			expect.objectContaining({
				entryId: oldAssistantEntryId,
				blockIndex: 0,
				kind: "thinking",
			}),
		);

		await harness.session.prompt("Next turn: retain the active task.");
		expect(providerInputs).toHaveLength(2);
		const nextProviderInput = JSON.stringify(providerInputs[1]);
		expect(nextProviderInput).toContain("SYSTEM_INSTRUCTION_SENTINEL");
		expect(nextProviderInput).toContain("Stored handoff summary.");
		expect(nextProviderInput).toContain("CURRENT_TASK_SENTINEL");
		expect(nextProviderInput).toContain(originalUserText.slice(8192, 8300));
		expect(nextProviderInput.split(CONTEXT_PRUNE_MARKER).length - 1).toBe(3);
		expect(nextProviderInput).toContain(oldReasoning);
		expect(nextProviderInput).not.toContain(oldAnswer);
		expect(harness.sessionManager.getEntry(oldUserEntryId)).toMatchObject({
			type: "message",
			message: { role: "user", content: originalUserText },
		});
		expect(harness.sessionManager.getEntry(oldAssistantEntryId)).toMatchObject({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: oldReasoning, thinkingSignature: "opaque-reasoning-fixture" },
					{ type: "text", text: oldAnswer },
				],
			},
		});
	} finally {
		harness.cleanup();
	}
});

it("reapplies saved thinking targets only while the destination is verified", () => {
	const source: ThinkingReplayCompatibility = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-6-luna",
	};
	const verified: ThinkingReplayCompatibility[] = [
		source,
		{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-sol" },
		{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-astra" },
	];
	const thinking = "The selected historical reasoning remains available to other destinations.";
	const answer = "The old answer has enough ordinary text to remain independently prunable.";
	const messages: AgentMessage[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: "An earlier completed user request." },
				{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
			],
			timestamp: 1,
		},
		{
			...fauxAssistantMessage([
				{ type: "thinking", thinking, thinkingSignature: "opaque-signature" },
				{ type: "text", text: answer },
			]),
			api: source.api,
			provider: source.provider,
			model: source.model,
		},
		{ role: "user", content: "The current task follows the earlier one.", timestamp: 2 },
	];
	const entryIds = ["old-user", "old-assistant", "current-user"];
	const targets = collectContextCandidates(messages, entryIds, [], verified, source).candidates.map(
		({ entryId, role, blockIndex, fingerprint, kind, start, end }) => ({
			entryId,
			role,
			blockIndex,
			fingerprint,
			kind,
			start,
			end,
		}),
	);
	expect(targets.some((target) => target.kind === "thinking")).toBe(true);
	const messageEntries: SessionEntry[] = messages.map((message, index) => ({
		type: "message",
		id: entryIds[index]!,
		parentId: index === 0 ? null : entryIds[index - 1]!,
		timestamp: new Date(index + 1).toISOString(),
		message,
	}));
	const pruneEntry: SessionEntry = {
		type: "custom",
		id: "prune-entry",
		parentId: entryIds[1]!,
		timestamp: new Date(4).toISOString(),
		customType: CONTEXT_PRUNE_ENTRY,
		data: { version: 2, targets },
	};
	const branch: SessionEntry[] = [...messageEntries, pruneEntry];
	const projection = {
		entries: branch.map((sourceEntry, index) => ({
			sourceEntry,
			messages: index < messages.length ? [messages[index]!] : [],
		})),
		messages,
	};
	const handlers = new Map<string, unknown[]>();
	const pi = {
		on(name: string, handler: unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => undefined;
		},
		registerCommand: vi.fn(),
		appendEntry: vi.fn(),
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => undefined,
		sendUserMessage: () => undefined,
	} as unknown as ExtensionAPI;
	installHooks(pi, {
		evaluate: async () => {
			throw new Error("The context projection does not evaluate candidates.");
		},
		hold: () => () => {},
		ledger: new HarnessUsageLedger(),
	});
	const context = {
		model: { api: "faux-api", provider: "faux", id: "faux-1" },
		sessionManager: {
			getBranch: () => branch,
			buildSessionProjection: () => projection,
		},
	} as unknown as ExtensionContext;
	const contextHandler = handlers.get("context")?.[0] as
		| ((event: ContextEvent, context: ExtensionContext) => ContextEventResult | undefined)
		| undefined;
	expect(contextHandler).toBeDefined();
	if (!contextHandler) throw new Error("The context projection handler was not registered");

	const unverifiedProjection = contextHandler({ type: "context", messages }, context)?.messages;
	expect(unverifiedProjection?.[1]).toMatchObject({
		content: expect.arrayContaining([
			expect.objectContaining({ type: "thinking", thinking }),
			expect.objectContaining({ type: "text", text: expect.stringContaining(CONTEXT_PRUNE_MARKER) }),
		]),
	});
	expect(JSON.stringify(unverifiedProjection?.[1]).split(CONTEXT_PRUNE_MARKER).length - 1).toBe(1);
	expect(unverifiedProjection?.[0]).not.toMatchObject({
		content: expect.arrayContaining([expect.objectContaining({ type: "image" })]),
	});

	context.model = { api: source.api, provider: source.provider, id: source.model } as NonNullable<
		ExtensionContext["model"]
	>;
	const verifiedProjection = contextHandler({ type: "context", messages }, context)?.messages;
	expect(verifiedProjection?.[1]).not.toMatchObject({
		content: expect.arrayContaining([expect.objectContaining({ type: "thinking", thinking })]),
	});
	expect(JSON.stringify(verifiedProjection?.[1])).toContain(CONTEXT_PRUNE_MARKER);
	expect(messages[1]).toMatchObject({
		content: expect.arrayContaining([expect.objectContaining({ type: "thinking", thinking })]),
	});
});

it("injects lifecycle context without starting a model turn and keeps time after user input", async () => {
	const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
	const sendMessage = vi.fn();
	const api = {
		on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: vi.fn(),
		sendMessage,
	} as unknown as ExtensionAPI;
	const lifecycleContext = vi.fn((event: "session_start" | "session_compact") => `Lifecycle: ${event}`);
	installHooks(api, {
		evaluate: async () => {
			throw new Error("not used");
		},
		hold: () => () => {},
		ledger: new HarnessUsageLedger(),
		lifecycleContext,
		dynamicTurnContext: () => "Current time fixture",
	});
	const context = { sessionManager: { getHeader: () => null } } as unknown as ExtensionContext;
	for (const name of ["session_start", "session_compact"]) await handlers.get(name)![0]({}, context);
	expect(sendMessage.mock.calls).toEqual([
		[
			{ customType: "personal-harness-lifecycle-context", content: "Lifecycle: session_start", display: false },
			{ triggerTurn: false },
		],
		[
			{ customType: "personal-harness-lifecycle-context", content: "Lifecycle: session_compact", display: false },
			{ triggerTurn: false },
		],
	]);
	const turn = await handlers.get("before_agent_start")![0]({ systemPromptOptions: {} }, context);
	expect(turn).toEqual({
		message: { customType: "personal-harness-turn-context", content: "Current time fixture", display: false },
	});
});
