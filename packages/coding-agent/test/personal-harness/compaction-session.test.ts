import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	ModelsApiStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import { EventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../../src/core/model-registry.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { CompactionTranscriptReader } from "../../src/personal-harness/compaction-reader.ts";
import { runCompactionSession } from "../../src/personal-harness/compaction-session.ts";
import { SOL_HIGH_FAST } from "../../src/personal-harness/model-call.ts";
import { HarnessUsageLedger } from "../../src/personal-harness/usage.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected mock stream event");
			},
		);
		queueMicrotask(() => {
			this.push({ type: "start", partial: message });
			if (message.stopReason === "pending") throw new Error("Synthetic response must be complete");
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				this.push({ type: "error", reason: message.stopReason, error: message });
			} else this.push({ type: "done", reason: message.stopReason, message });
		});
	}
}

const usage: Usage = {
	input: 12,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model = {
	id: "gpt-6-sol",
	name: "GPT-6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid/codex",
	reasoning: true,
	thinkingLevelMap: { high: "high" },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 32_768,
} as Model<"openai-codex-responses">;

const sectionNames = [
	"Objective and latest request",
	"Requirements and corrections",
	"Scope and approvals",
	"Plan and task references",
	"Progress and TODO",
	"Adopted decisions",
	"Withdrawn options",
	"Verification",
	"Changed files and Git state",
	"Failed attempts",
	"Parent and child assignments",
	"Skills and tools",
	"Blockers and questions",
	"Next actions and source references",
];

function checkpoint(sectionCount = 14): string {
	return sectionNames
		.slice(0, sectionCount)
		.map(
			(name, index) =>
				`${index + 1}. ${name}\n   Synthetic checkpoint fact ${index + 1} is confirmed in the fixture.`,
		)
		.join("\n\n");
}

function codexResponse(message: AssistantMessage): AssistantMessage {
	return { ...message, api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-sol", usage };
}

function readerAndContext() {
	const sourceText = "synthetic source text needed for the compact tool loop";
	const entries = [
		{
			type: "message",
			id: "source-1",
			parentId: null,
			timestamp: "2026-09-28T00:00:01.000Z",
			message: { role: "user", content: sourceText },
		},
		{
			type: "message",
			id: "kept-2",
			parentId: "source-1",
			timestamp: "2026-09-28T00:00:02.000Z",
			message: { role: "user", content: "new request retained after compact" },
		},
	] as unknown as SessionEntry[];
	const reader = new CompactionTranscriptReader({
		sessionId: "session-agent-fixture",
		branchId: "branch-agent-fixture",
		sessionFile: "/fixture/agent-session.jsonl",
		branchEntries: entries,
		firstKeptEntryId: "kept-2",
	});
	return {
		reader,
		sourceText,
		initialContext: reader.initialContext({
			previousSummary: "Synthetic previous summary.",
			currentGoal: { objective: "Synthetic goal", status: "active" },
			currentTodo: { items: [{ title: "Check source", status: "in_progress" }] },
		}),
	};
}

function registryWithResponses(
	responses: AssistantMessage[],
	options: {
		model?: Model<"openai-codex-responses">;
		observedContexts?: Context[];
		observedFastOptions?: ModelsApiStreamOptions<"openai-codex-responses">[];
	} = {},
) {
	const availableModel = options.model ?? model;
	const registry = {
		find: vi.fn(() => availableModel),
		stream: vi.fn(
			(
				_requestModel: Model<"openai-codex-responses">,
				context: Context,
				streamOptions: ModelsApiStreamOptions<"openai-codex-responses">,
			) => {
				options.observedContexts?.push(context);
				options.observedFastOptions?.push(streamOptions);
				const response = responses.shift();
				if (!response) throw new Error("No synthetic response remains");
				return new MockAssistantStream(response);
			},
		),
		streamSimple: vi.fn(),
	} as unknown as ModelRegistry;
	return registry;
}

function setupRun(responses: AssistantMessage[], signal = new AbortController().signal) {
	const source = readerAndContext();
	const ledger = new HarnessUsageLedger();
	const registry = registryWithResponses(responses);
	const result = runCompactionSession({
		registry,
		selection: SOL_HIGH_FAST,
		ledger,
		sessionId: "session-agent-fixture",
		reader: source.reader,
		initialContext: source.initialContext,
		signal,
	});
	return { result, source, registry, ledger };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("dedicated compact Agent session", () => {
	it("accepts factual bodies inline after bold numbered section titles", async () => {
		const text = sectionNames
			.map(
				(name, index) =>
					`${index + 1}. **${name}.** Synthetic checkpoint fact ${index + 1} is established in this fixture.`,
			)
			.join("\n\n");
		const run = setupRun([codexResponse(fauxAssistantMessage(text, { stopReason: "stop" }))]);
		await expect(run.result).resolves.toMatchObject({ summary: text });
	});

	it("uses only read-only transcript tools and routes Sol/high+Fast through registry.stream", async () => {
		const source = readerAndContext();
		const observedContexts: Context[] = [];
		const observedFastOptions: ModelsApiStreamOptions<"openai-codex-responses">[] = [];
		const responses = [
			codexResponse(
				fauxAssistantMessage(
					[
						fauxToolCall("transcript_read", {
							entries: [{ entryId: "source-1", start: 0, end: source.sourceText.length }],
						}),
					],
					{ stopReason: "toolUse" },
				),
			),
			codexResponse(fauxAssistantMessage(checkpoint(), { stopReason: "stop" })),
		];
		const registry = registryWithResponses(responses, { observedContexts, observedFastOptions });
		const ledger = new HarnessUsageLedger();

		const result = await runCompactionSession({
			registry,
			selection: SOL_HIGH_FAST,
			ledger,
			sessionId: "session-agent-fixture",
			reader: source.reader,
			initialContext: source.initialContext,
			signal: new AbortController().signal,
		});

		expect(result.summary).toContain("14. Next actions and source references");
		expect(registry.stream).toHaveBeenCalledTimes(2);
		expect(registry.streamSimple).not.toHaveBeenCalled();
		expect(observedFastOptions).toHaveLength(2);
		for (const options of observedFastOptions) {
			expect(options).toMatchObject({ reasoningEffort: "high", serviceTier: "priority", maxTokens: 32_768 });
		}
		const firstSystem = observedContexts[0]?.messages.find((message) => message.role === "system");
		if (!firstSystem || firstSystem.role !== "system") throw new Error("Compact system message is missing");
		const systemText =
			typeof firstSystem.content === "string"
				? firstSystem.content
				: firstSystem.content.map((part) => part.text).join("\n");
		expect(systemText).toContain("Create a factual handover checkpoint");
		expect(systemText).not.toContain("You are an expert coding assistant");
		expect(systemText).not.toContain("Pi documentation");
		expect(firstSystem.toolsAdded?.map((tool) => tool.name)).toEqual([
			"transcript_list",
			"transcript_search",
			"transcript_read",
		]);
		const secondContext = observedContexts[1];
		const readResult = secondContext?.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "transcript_read",
		);
		expect(JSON.stringify(readResult)).toContain(source.sourceText);
		expect(ledger.snapshot().compact).toMatchObject({ calls: 1, failed: 0, input: 24, output: 16 });
	});

	it("rejects a truncated-length response and leaves the compact ledger failed", async () => {
		const truncated = codexResponse(fauxAssistantMessage(checkpoint(), { stopReason: "length" }));
		const run = setupRun([truncated]);

		await expect(run.result).rejects.toThrow(/length|output/i);

		expect(run.ledger.snapshot().compact).toMatchObject({ calls: 1, failed: 1 });
	});

	it("rejects a checkpoint that omits any of the 14 required sections", async () => {
		const malformed = codexResponse(fauxAssistantMessage(checkpoint(13), { stopReason: "stop" }));
		const run = setupRun([malformed]);

		await expect(run.result).rejects.toThrow("all 14 numbered handover sections");

		expect(run.ledger.snapshot().compact).toMatchObject({ calls: 1, failed: 1 });
	});

	it("does not try the model when cancellation is already requested", async () => {
		const controller = new AbortController();
		controller.abort();
		const run = setupRun([], controller.signal);

		await expect(run.result).rejects.toThrow();

		expect(run.registry.find).not.toHaveBeenCalled();
		expect(run.ledger.snapshot().compact).toMatchObject({ calls: 1, failed: 1 });
	});
});
