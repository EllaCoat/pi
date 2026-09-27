import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIDialogOptions,
} from "../../src/core/extensions/types.ts";
import { registerHarnessAsk } from "../../src/personal-harness/ask.ts";

interface TestOption {
	value: string;
	label: string;
	description?: string;
	recommended?: boolean;
}

interface TestQuestion {
	id: string;
	label?: string;
	prompt: string;
	options?: TestOption[];
	allowOther?: boolean;
	multiple?: boolean;
}

interface TestAskTool {
	execute(
		toolCallId: string,
		params: { questions: TestQuestion[] },
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>>;
}

interface SelectCall {
	title: string;
	options: string[];
	signal: AbortSignal | undefined;
	resolve(value: string | undefined): void;
}

interface InputCall {
	title: string;
	placeholder: string | undefined;
	signal: AbortSignal | undefined;
	resolve(value: string | undefined): void;
}

interface DeliveredMessage {
	message: unknown;
	options: unknown;
}

function createAskHarness(options: { mode?: "tui" | "rpc"; resolveOnAbort?: boolean } = {}) {
	const selects: SelectCall[] = [];
	const inputs: InputCall[] = [];
	const delivered: DeliveredMessage[] = [];
	const handlers = new Map<string, () => void>();
	let sessionId = "main-session";
	let askTool: TestAskTool | undefined;

	const pi = {
		on(event: string, handler: unknown) {
			handlers.set(event, handler as () => void);
			return () => handlers.delete(event);
		},
		registerTool(tool: unknown) {
			askTool = tool as TestAskTool;
		},
		sendMessage(message: unknown, sendOptions: unknown) {
			delivered.push({ message, options: sendOptions });
		},
	} as unknown as ExtensionAPI;
	registerHarnessAsk(pi);

	const ui = {
		select(title: string, choiceList: string[], dialogOptions?: ExtensionUIDialogOptions) {
			return new Promise<string | undefined>((resolve) => {
				const call: SelectCall = {
					title,
					options: [...choiceList],
					signal: dialogOptions?.signal,
					resolve,
				};
				selects.push(call);
				if (options.resolveOnAbort === false) return;
				if (call.signal?.aborted) {
					resolve(undefined);
				} else {
					call.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}
			});
		},
		input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions) {
			return new Promise<string | undefined>((resolve) => {
				const call: InputCall = {
					title,
					placeholder,
					signal: dialogOptions?.signal,
					resolve,
				};
				inputs.push(call);
				if (options.resolveOnAbort === false) return;
				if (call.signal?.aborted) {
					resolve(undefined);
				} else {
					call.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}
			});
		},
	};
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: (options.mode ?? "tui") === "tui",
		sessionManager: { getSessionId: () => sessionId },
		ui,
	} as unknown as ExtensionContext;

	return {
		get tool(): TestAskTool {
			if (!askTool) throw new Error("ask tool was not registered");
			return askTool;
		},
		ctx,
		selects,
		inputs,
		delivered,
		handlers,
		setSessionId(id: string) {
			sessionId = id;
		},
	};
}

function resultDetails(result: AgentToolResult<unknown>): Record<string, unknown> {
	if (typeof result.details !== "object" || result.details === null) throw new Error("Expected result details");
	return result.details as Record<string, unknown>;
}

async function settleBackgroundWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("personal harness ask tool", () => {
	afterEach(() => vi.restoreAllMocks());
	it.each([
		[
			{ id: "same", prompt: "First?" },
			{ id: "same", prompt: "Second?" },
		],
		[
			{
				id: "value",
				prompt: "Choose?",
				options: [
					{ value: "a", label: "First" },
					{ value: "a", label: "Second" },
				],
			},
		],
		[{ id: "blank", prompt: "Choose?", options: [{ value: " ", label: "Label" }] }],
	] satisfies TestQuestion[][])("rejects ambiguous identifiers before opening UI: %j", async (...questions) => {
		const harness = createAskHarness();
		const result = await harness.tool.execute("invalid", { questions }, undefined, undefined, harness.ctx);
		expect(resultDetails(result).harnessError).toBe(true);
		expect(harness.selects).toHaveLength(0);
		expect(harness.inputs).toHaveLength(0);
	});

	it("returns a pending receipt before UI answers, then delivers grouped choice and free-text answers", async () => {
		const harness = createAskHarness();
		const result = await harness.tool.execute(
			"ask-call",
			{
				questions: [
					{
						id: "language",
						label: "Implementation",
						prompt: "Which language should the sample use?",
						options: [
							{
								value: "ts",
								label: "TypeScript",
								description: "Use the existing project idiom",
								recommended: true,
							},
							{ value: "js", label: "JavaScript" },
						],
					},
					{
						id: "constraint",
						prompt: "Any constraint to keep in mind?",
						options: [{ value: "none", label: "No additional constraint" }],
					},
				],
			},
			undefined,
			undefined,
			harness.ctx,
		);

		expect(resultDetails(result)).toMatchObject({ status: "pending", questionIds: ["language", "constraint"] });
		expect(harness.selects).toHaveLength(1);
		expect(harness.selects[0]?.options).toContain("1. TypeScript (recommended) — Use the existing project idiom");
		expect(harness.delivered).toHaveLength(0);

		harness.selects[0]?.resolve("1. TypeScript (recommended) — Use the existing project idiom");
		await vi.waitFor(() => expect(harness.selects).toHaveLength(2));
		harness.selects[1]?.resolve("2. Other (write an answer)");
		await vi.waitFor(() => expect(harness.inputs).toHaveLength(1));
		harness.inputs[0]?.resolve("Keep the public API unchanged");
		await vi.waitFor(() => expect(harness.delivered).toHaveLength(1));

		const requestId = resultDetails(result).requestId;
		expect(harness.delivered[0]).toMatchObject({
			message: {
				customType: "personal-harness-ask-answer",
				content: expect.stringContaining("permissions explicitly granted by these answers"),
				details: {
					requestId,
					questionIds: ["language", "constraint"],
					status: "answered",
					answers: [
						{ questionId: "language", selections: [{ value: "ts", label: "TypeScript", source: "option" }] },
						{
							questionId: "constraint",
							selections: [{ value: "Keep the public API unchanged", source: "other" }],
						},
					],
				},
			},
			options: { triggerTurn: true, deliverAs: "followUp" },
		});
	});

	it("supports multiple choices and a done action", async () => {
		const harness = createAskHarness();
		const result = await harness.tool.execute(
			"ask-call",
			{
				questions: [
					{
						id: "scope",
						prompt: "Which areas should be included?",
						multiple: true,
						options: [
							{ value: "ui", label: "UI" },
							{ value: "tests", label: "Tests" },
							{ value: "docs", label: "Documentation" },
						],
					},
				],
			},
			undefined,
			undefined,
			harness.ctx,
		);
		expect(resultDetails(result).status).toBe("pending");
		harness.selects[0]?.resolve("1. UI");
		await vi.waitFor(() => expect(harness.selects).toHaveLength(2));
		expect(harness.selects[1]?.options).not.toContain("1. UI");
		harness.selects[1]?.resolve("2. Tests");
		await vi.waitFor(() => expect(harness.selects).toHaveLength(3));
		harness.selects[2]?.resolve("5. Done selecting");
		await vi.waitFor(() => expect(harness.delivered).toHaveLength(1));
		expect(harness.delivered[0]).toMatchObject({
			message: {
				details: {
					status: "answered",
					answers: [
						{
							questionId: "scope",
							selections: [
								{ value: "ui", label: "UI", source: "option" },
								{ value: "tests", label: "Tests", source: "option" },
							],
						},
					],
				},
			},
		});
	});

	it("delivers an explicit UI cancellation with the originating request and question ids", async () => {
		const harness = createAskHarness();
		const result = await harness.tool.execute(
			"ask-call",
			{ questions: [{ id: "tone", prompt: "Which tone?", options: [{ value: "plain", label: "Plain" }] }] },
			undefined,
			undefined,
			harness.ctx,
		);
		harness.selects[0]?.resolve(undefined);
		await vi.waitFor(() => expect(harness.delivered).toHaveLength(1));
		expect(harness.delivered[0]).toMatchObject({
			message: {
				details: {
					requestId: resultDetails(result).requestId,
					questionIds: ["tone"],
					status: "cancelled",
				},
			},
		});
	});

	it("does not replace an unresolved question request", async () => {
		const harness = createAskHarness();
		const params = { questions: [{ id: "first", prompt: "First?", options: [{ value: "yes", label: "Yes" }] }] };
		const first = await harness.tool.execute("ask-one", params, undefined, undefined, harness.ctx);
		const second = await harness.tool.execute("ask-two", params, undefined, undefined, harness.ctx);
		expect(resultDetails(first).status).toBe("pending");
		expect(resultDetails(second).harnessError).toBe(true);
		expect(second.content).toMatchObject([{ text: expect.stringContaining(String(resultDetails(first).requestId)) }]);
		expect(harness.selects).toHaveLength(1);
	});

	it("returns unavailable immediately in non-TUI modes without creating a pending request", async () => {
		const harness = createAskHarness({ mode: "rpc" });
		const result = await harness.tool.execute(
			"ask-call",
			{ questions: [{ id: "decision", prompt: "Choose?", options: [{ value: "a", label: "A" }] }] },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(resultDetails(result).harnessError).toBe(true);
		expect(result.content).toMatchObject([
			{ text: expect.stringContaining("unavailable outside interactive TUI mode") },
		]);
		expect(resultDetails(result).status).toBe("unavailable");
		expect(harness.selects).toHaveLength(0);
		expect(harness.delivered).toHaveLength(0);
	});

	it("cancels the active UI on explicit tool abort and ignores a late answer", async () => {
		const harness = createAskHarness({ resolveOnAbort: false });
		const controller = new AbortController();
		const receipt = await harness.tool.execute(
			"ask-call",
			{ questions: [{ id: "mode", prompt: "Which mode?", options: [{ value: "safe", label: "Safe" }] }] },
			controller.signal,
			undefined,
			harness.ctx,
		);
		controller.abort();
		expect(harness.selects[0]?.signal?.aborted).toBe(true);
		harness.selects[0]?.resolve("1. Safe");
		await settleBackgroundWork();
		expect(resultDetails(receipt).status).toBe("pending");
		expect(harness.delivered).toHaveLength(0);
	});

	it.each([
		"session_abort",
		"session_before_switch",
		"session_before_fork",
		"session_before_tree",
		"session_tree",
		"session_shutdown",
	])("isolates a late UI response after %s", async (event) => {
		const harness = createAskHarness({ resolveOnAbort: false });
		const receipt = await harness.tool.execute(
			"ask-call",
			{ questions: [{ id: "choice", prompt: "Choose?", options: [{ value: "a", label: "A" }] }] },
			undefined,
			undefined,
			harness.ctx,
		);
		harness.setSessionId("replacement-session");
		harness.handlers.get(event)?.();
		expect(harness.selects[0]?.signal?.aborted).toBe(true);
		harness.selects[0]?.resolve("1. A");
		await settleBackgroundWork();
		expect(resultDetails(receipt).status).toBe("pending");
		expect(harness.delivered).toHaveLength(0);
	});
});
