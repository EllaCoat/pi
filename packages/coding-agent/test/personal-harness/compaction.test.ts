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
import { installModelCompactionHook } from "../../src/personal-harness/hooks/compaction.ts";
import {
	completeHarnessTask,
	type HarnessModelSelection,
	harnessResponseText,
	LUNA_MAX,
} from "../../src/personal-harness/model-call.ts";
import { HarnessUsageLedger } from "../../src/personal-harness/usage.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

vi.mock("../../src/personal-harness/model-call.ts", () => ({
	completeHarnessTask: vi.fn(),
	harnessResponseText: vi.fn(),
	LUNA_MAX: { provider: "openai-codex", model: "gpt-6-luna", thinking: "max" },
}));

type StoredHandler = unknown;
type CompactionHandler = (
	event: SessionBeforeCompactEvent,
	context: ExtensionContext,
) => Promise<SessionBeforeCompactResult | undefined>;
type TerminalHandler = (event: SessionCompactEvent | SessionCompactFailedEvent, context: ExtensionContext) => void;

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
	const context = {
		ui: { notify },
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
	installModelCompactionHook(pi, { hold, ledger: new HarnessUsageLedger(), compactModel });
	return {
		handlers,
		hold,
		context,
		notify,
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
		branchEntries: [],
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
	model: "gpt-6-luna",
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

describe("Luna/max compaction hook in AgentSession", () => {
	it("uses the extension summary in the real session and releases the TODO hold after saving", async () => {
		vi.mocked(completeHarnessTask).mockResolvedValueOnce(response);
		vi.mocked(harnessResponseText).mockReturnValue("checkpoint");
		const fixture = await setupSession();

		const result = await fixture.harness.session.compact();

		expect(result.summary).toBe("checkpoint");
		expect(fixture.harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
			1,
		);
		expect(fixture.hold).toHaveBeenCalledTimes(1);
		expect(fixture.releases).toBe(1);
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
	});

	it("cancels a failed manual extension compact without default fallback or history changes", async () => {
		vi.mocked(completeHarnessTask).mockRejectedValueOnce(new Error("provider detail"));
		const fixture = await setupSession();
		const entriesBefore = JSON.stringify(fixture.harness.sessionManager.getEntries());

		await expect(fixture.harness.session.compact()).rejects.toThrow("Compaction cancelled");

		expect(JSON.stringify(fixture.harness.sessionManager.getEntries())).toBe(entriesBefore);
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
		expect(fixture.hold).toHaveBeenCalledTimes(1);
		expect(fixture.releases).toBe(1);
		expect(vi.mocked(completeHarnessTask)).toHaveBeenCalledTimes(1);
	});
});

describe("Luna/max compaction hook", () => {
	it("returns the successful Pi compaction result and holds TODO saves until success", async () => {
		vi.mocked(completeHarnessTask).mockResolvedValueOnce(response);
		vi.mocked(harnessResponseText).mockReturnValue("checkpoint");
		const fixture = setup();
		const handleBeforeCompact = fixture.handlers.get("session_before_compact")?.[0] as unknown as CompactionHandler;
		const result = await handleBeforeCompact(event(), fixture.context);
		expect(result).toMatchObject({
			compaction: { summary: "checkpoint", firstKeptEntryId: "kept-1", tokensBefore: 20 },
		});
		expect(vi.mocked(completeHarnessTask).mock.calls[0]?.[0]).toMatchObject({
			selection: LUNA_MAX,
			purpose: "compact",
		});
		expect(fixture.releases).toBe(0);
		const request = vi.mocked(completeHarnessTask).mock.calls[0]?.[0];
		expect(request?.selection).toEqual(LUNA_MAX);
		expect(request?.context.systemPrompt).toContain("structured checkpoint");
		expect(request?.context.systemPrompt).not.toContain("compact-conversation-marker");
		expect(request?.context.systemPrompt).not.toContain("compact-previous-summary-marker");
		expect(request?.context.systemPrompt).not.toContain("compact-custom-instructions-marker");
		const userMessage = request?.context.messages[0];
		if (!userMessage || userMessage.role !== "user" || typeof userMessage.content !== "string") {
			throw new Error("Compaction model input was not a single user data message");
		}
		const userData = JSON.parse(userMessage.content) as {
			conversation: string;
			previousSummary: string;
			customInstructions: string;
		};
		expect(userData.previousSummary).toBe("compact-previous-summary-marker");
		expect(userData.customInstructions).toBe("compact-custom-instructions-marker");
		expect(userData.conversation).toContain("compact-conversation-marker");
		const success = fixture.handlers.get("session_compact")?.[0] as unknown as TerminalHandler;
		success({ type: "session_compact" } as unknown as SessionCompactEvent, fixture.context);
		expect(fixture.releases).toBe(1);
	});

	it("cancels instead of falling back to standard compaction and releases on failure", async () => {
		vi.mocked(completeHarnessTask).mockRejectedValueOnce(new Error("provider detail"));
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
});
it("uses an explicit compact-purpose model selection", async () => {
	vi.mocked(completeHarnessTask).mockResolvedValueOnce(response);
	vi.mocked(harnessResponseText).mockReturnValue("checkpoint");
	const compactModel = { provider: "openai-codex", model: "gpt-6-sol", thinking: "low" } as const;
	const fixture = setup(compactModel);
	const handleBeforeCompact = fixture.handlers.get("session_before_compact")?.[0] as unknown as CompactionHandler;

	await handleBeforeCompact(event(), fixture.context);

	expect(vi.mocked(completeHarnessTask).mock.calls[0]?.[0]).toMatchObject({
		selection: compactModel,
		purpose: "compact",
	});
});
