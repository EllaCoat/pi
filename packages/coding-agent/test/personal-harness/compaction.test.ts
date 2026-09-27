import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactEvent,
	SessionCompactFailedEvent,
} from "../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { runCompactionSession } from "../../src/personal-harness/compaction-session.ts";
import { installModelCompactionHook } from "../../src/personal-harness/hooks/compaction.ts";
import { type HarnessModelSelection, SOL_HIGH_FAST } from "../../src/personal-harness/model-call.ts";
import { HarnessUsageLedger } from "../../src/personal-harness/usage.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

vi.mock("../../src/personal-harness/compaction-session.ts", () => ({
	COMPACTION_SESSION_TIMEOUT_MS: 600_000,
	COMPACTION_SUMMARY_MAX_CHARACTERS: 30_000,
	runCompactionSession: vi.fn(),
}));

type StoredHandler = unknown;
type CompactionHandler = (
	event: SessionBeforeCompactEvent,
	context: ExtensionContext,
) => Promise<SessionBeforeCompactResult | undefined>;
type TerminalHandler = (event: SessionCompactEvent | SessionCompactFailedEvent, context: ExtensionContext) => void;

function branchEntries(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "source-1",
			parentId: null,
			timestamp: "2026-09-28T00:00:00.000Z",
			message: { role: "user", content: "compact-conversation-marker" },
		} as unknown as SessionEntry,
		{
			type: "message",
			id: "kept-1",
			parentId: "source-1",
			timestamp: "2026-09-28T00:00:01.000Z",
			message: { role: "user", content: "retained-request-marker" },
		} as unknown as SessionEntry,
	];
}

function setup(compactModel?: HarnessModelSelection) {
	const handlers = new Map<string, StoredHandler[]>();
	const pi = {
		on(name: string, handler: StoredHandler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
			return () => undefined;
		},
	} as unknown as ExtensionAPI;
	let releases = 0;
	const hold = vi.fn(() => {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			releases++;
		};
	});
	const notify = vi.fn();
	const currentBranch = branchEntries();
	const context = {
		ui: { notify },
		modelRegistry: {},
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/fixture/session.jsonl",
			getEntries: () => currentBranch,
			getBranch: () => currentBranch,
		},
	} as unknown as ExtensionContext;
	installModelCompactionHook(pi, { hold, ledger: new HarnessUsageLedger(), compactModel });
	return {
		handlers,
		hold,
		context,
		notify,
		currentBranch,
		get releases() {
			return releases;
		},
	};
}

function event(): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: [{ role: "user", content: "compact-conversation-marker", timestamp: 1 }],
			turnPrefixMessages: [],
			previousSummary: "compact-previous-summary-marker",
			tokensBefore: 20,
		},
		branchEntries: branchEntries(),
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		customInstructions: "compact-custom-instructions-marker",
	} as unknown as SessionBeforeCompactEvent;
}

const response: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "checkpoint" }],
	api: "openai-responses",
	provider: "openai-codex",
	model: "gpt-6-sol",
	stopReason: "stop",
	timestamp: 1,
	usage: {
		input: 10,
		output: 4,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 14,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	vi.clearAllMocks();
});

async function setupSession() {
	let releases = 0;
	const hold = vi.fn(() => {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			releases++;
		};
	});
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [(pi) => installModelCompactionHook(pi, { hold, ledger: new HarnessUsageLedger() })],
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("initial reply"), fauxAssistantMessage("fallback summary must not run")]);
	await harness.session.prompt("Keep this session history intact if compaction fails.");
	return {
		harness,
		hold,
		get releases() {
			return releases;
		},
	};
}

describe("Sol/high+Fast compaction hook in AgentSession", () => {
	it("saves the dedicated summary through Pi's compaction result and releases the hold after saving", async () => {
		vi.mocked(runCompactionSession).mockResolvedValueOnce({ summary: "checkpoint", usage: response.usage });
		const fixture = await setupSession();

		const result = await fixture.harness.session.compact();

		expect(result.summary).toContain("checkpoint");
		expect(result.summary).toContain("Transcript reader coverage");
		expect(fixture.harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
			1,
		);
		expect(fixture.hold).toHaveBeenCalledTimes(1);
		expect(fixture.releases).toBe(1);
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
	});

	it("cancels a failed dedicated compact without default fallback or history changes", async () => {
		vi.mocked(runCompactionSession).mockRejectedValueOnce(new Error("provider detail"));
		const fixture = await setupSession();
		const entriesBefore = JSON.stringify(fixture.harness.sessionManager.getEntries());

		await expect(fixture.harness.session.compact()).rejects.toThrow("Compaction cancelled");

		expect(JSON.stringify(fixture.harness.sessionManager.getEntries())).toBe(entriesBefore);
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
		expect(fixture.hold).toHaveBeenCalledTimes(1);
		expect(fixture.releases).toBe(1);
		expect(vi.mocked(runCompactionSession)).toHaveBeenCalledTimes(1);
	});
});

describe("Sol/high+Fast compaction hook", () => {
	it("passes the frozen original-record source, current context, and dedicated model to the session", async () => {
		vi.mocked(runCompactionSession).mockResolvedValueOnce({ summary: "checkpoint" });
		const fixture = setup();
		const handleBeforeCompact = fixture.handlers.get("session_before_compact")?.[0] as unknown as CompactionHandler;

		const result = await handleBeforeCompact(event(), fixture.context);

		expect(result).toMatchObject({
			compaction: { firstKeptEntryId: "kept-1", tokensBefore: 20 },
		});
		const request = vi.mocked(runCompactionSession).mock.calls[0]?.[0];
		expect(request?.selection).toEqual(SOL_HIGH_FAST);
		expect(request?.sessionId).toBe("session-1");
		expect(request?.reader.sourcePath).toBe("/fixture/session.jsonl");
		expect(request?.reader.targetEndEntryId).toBe("source-1");
		expect(request?.reader.firstKeptEntryId).toBe("kept-1");
		expect(JSON.stringify(request?.initialContext)).toContain("compact-previous-summary-marker");
		expect(JSON.stringify(request?.initialContext)).toContain("compact-custom-instructions-marker");
		expect(JSON.stringify(request?.initialContext)).toContain("compact-conversation-marker");
		expect(JSON.stringify(request?.initialContext)).toContain("retained-request-marker");
		expect(JSON.stringify(request?.initialContext)).not.toContain("COMPACTION_SYSTEM_PROMPT");
		expect(fixture.releases).toBe(0);

		const success = fixture.handlers.get("session_compact")?.[0] as unknown as TerminalHandler;
		success({ type: "session_compact" } as unknown as SessionCompactEvent, fixture.context);
		expect(fixture.releases).toBe(1);
	});

	it("cancels instead of falling back to standard compaction and releases on failure", async () => {
		vi.mocked(runCompactionSession).mockRejectedValueOnce(new Error("provider detail"));
		const fixture = setup();
		const handleBeforeCompact = fixture.handlers.get("session_before_compact")?.[0] as unknown as CompactionHandler;
		expect(await handleBeforeCompact(event(), fixture.context)).toEqual({ cancel: true });
		expect(fixture.releases).toBe(0);
		const failed = fixture.handlers.get("session_compact_failed")?.[0] as unknown as TerminalHandler;
		failed(
			{ type: "session_compact_failed", reason: "manual", aborted: true } as unknown as SessionCompactFailedEvent,
			fixture.context,
		);
		expect(fixture.releases).toBe(1);
		expect(fixture.notify).toHaveBeenCalledTimes(1);
	});

	it("rejects a changed target before returning a saveable compaction result", async () => {
		const fixture = setup();
		vi.mocked(runCompactionSession).mockImplementationOnce(async () => {
			const first = fixture.currentBranch[0];
			if (first?.type !== "message") throw new Error("Missing synthetic source entry");
			first.message = { role: "user", content: "changed-after-snapshot", timestamp: 1 };
			return { summary: "checkpoint" };
		});
		const handleBeforeCompact = fixture.handlers.get("session_before_compact")?.[0] as unknown as CompactionHandler;

		expect(await handleBeforeCompact(event(), fixture.context)).toEqual({ cancel: true });
		expect(fixture.notify).toHaveBeenCalledTimes(1);
	});

	it("uses an explicitly configured compact-purpose model", async () => {
		vi.mocked(runCompactionSession).mockResolvedValueOnce({ summary: "checkpoint" });
		const compactModel = { provider: "openai-codex", model: "gpt-6-sol", thinking: "low" } as const;
		const fixture = setup(compactModel);
		const handleBeforeCompact = fixture.handlers.get("session_before_compact")?.[0] as unknown as CompactionHandler;

		await handleBeforeCompact(event(), fixture.context);

		expect(vi.mocked(runCompactionSession).mock.calls[0]?.[0]).toMatchObject({
			selection: compactModel,
			sessionId: "session-1",
		});
	});
});
