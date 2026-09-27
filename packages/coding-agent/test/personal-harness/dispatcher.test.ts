import type { AfterToolCallContext, AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { HarnessToolDispatcher } from "../../src/personal-harness/dispatcher.ts";

const assistant: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "openai-responses",
	provider: "test",
	model: "test",
	stopReason: "toolUse",
	timestamp: 1,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
const readParameters = Type.Object({ path: Type.String() });
const tool: AgentTool = {
	name: "read_test",
	label: "Read test",
	description: "Read an approved item",
	parameters: readParameters,
	execute: async (_id, args) => {
		const input = args as { path: string };
		return { content: [{ type: "text", text: input.path }], details: { path: input.path } };
	},
};

describe("HarnessToolDispatcher", () => {
	it("rejects unavailable tools and invalid inputs before invoking the host", async () => {
		const execute = vi.fn(tool.execute);
		const allowed = [{ ...tool, execute }];
		const dispatcher = new HarnessToolDispatcher({
			tools: () => allowed,
			context: () => ({ messages: [] }),
			assistantMessage: () => assistant,
		});
		expect((await dispatcher.execute("unknown", {})).isError).toBe(true);
		expect((await dispatcher.execute("read_test", {})).isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it("honors a blocking hook and never performs the side effect", async () => {
		const execute = vi.fn(tool.execute);
		const allowed = [{ ...tool, execute }];
		const before = vi.fn(async () => ({ block: true, reason: "User approval required" }));
		const after = vi.fn();
		const dispatcher = new HarnessToolDispatcher({
			tools: () => allowed,
			context: () => ({ messages: [] }),
			assistantMessage: () => assistant,
			beforeToolCall: before,
			afterToolCall: after,
		});
		const result = await dispatcher.execute("read_test", { path: "safe.txt" });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "User approval required" }]);
		expect(execute).not.toHaveBeenCalled();
		expect(before).toHaveBeenCalledTimes(1);
		expect(after).not.toHaveBeenCalled();
	});

	it("runs both hooks once and preserves structured data and image results", async () => {
		const before = vi.fn(async () => undefined);
		const after = vi.fn(async () => ({
			content: [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }],
			details: { reference: "artifact-1" },
		}));
		const dispatcher = new HarnessToolDispatcher({
			tools: () => [tool],
			context: () => ({ messages: [] }),
			assistantMessage: () => assistant,
			beforeToolCall: before,
			afterToolCall: after,
		});
		const result = await dispatcher.execute("read_test", { path: "image.png" });
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
		expect(result.details).toEqual({ reference: "artifact-1" });
		expect(before).toHaveBeenCalledTimes(1);
		expect(after).toHaveBeenCalledTimes(1);
	});

	it("does not execute a request canceled while waiting for approval", async () => {
		const controller = new AbortController();
		const execute = vi.fn(tool.execute);
		const allowed = [{ ...tool, execute }];
		const dispatcher = new HarnessToolDispatcher({
			tools: () => allowed,
			context: () => ({ messages: [] }),
			assistantMessage: () => assistant,
			beforeToolCall: async () => {
				controller.abort();
				return undefined;
			},
		});
		expect((await dispatcher.execute("read_test", { path: "a" }, { signal: controller.signal })).isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it.each(["revoke", "close"])("honors %s while approval is pending", async (action) => {
		const execute = vi.fn(tool.execute);
		let allowed: AgentTool[] = [{ ...tool, execute }];
		const dispatcher = new HarnessToolDispatcher({
			tools: () => allowed,
			context: () => ({ messages: [] }),
			assistantMessage: () => assistant,
			beforeToolCall: async () => {
				if (action === "revoke") allowed = [];
				else dispatcher.close();
				return undefined;
			},
		});
		expect((await dispatcher.execute("read_test", { path: "safe" })).isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it("keeps the host error visible to the result hook and caller", async () => {
		const failing = {
			...tool,
			execute: async () => {
				throw new Error("host denied access");
			},
		};
		const after = vi.fn(async (_context: AfterToolCallContext) => undefined);
		const dispatcher = new HarnessToolDispatcher({
			tools: () => [failing],
			context: () => ({ messages: [] }),
			assistantMessage: () => assistant,
			afterToolCall: after,
		});
		const result = await dispatcher.execute("read_test", { path: "a" });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "host denied access" }]);
		expect(after.mock.calls[0]?.[0]).toMatchObject({ isError: true });
	});
	it.each([
		["sequential", "parallel"],
		["parallel", "sequential"],
		["sequential", "sequential"],
	] as const)("isolates %s then %s in one caller batch", async (firstMode, secondMode) => {
		const gate = Promise.withResolvers<void>();
		const order: string[] = [];
		const first: AgentTool = {
			...tool,
			name: "first",
			executionMode: firstMode,
			execute: async () => {
				order.push("first-start");
				await gate.promise;
				order.push("first-end");
				return { content: [], details: {} };
			},
		};
		const second: AgentTool = {
			...tool,
			name: "second",
			executionMode: secondMode,
			execute: async () => {
				order.push("second");
				return { content: [], details: {} };
			},
		};
		const dispatcher = new HarnessToolDispatcher({
			tools: () => [first, second],
			context: () => ({ messages: [] }),
			assistantMessage: () => assistant,
		});
		const firstResult = dispatcher.execute("first", { path: "fixture" });
		await vi.waitFor(() => expect(order).toEqual(["first-start"]));
		const secondResult = dispatcher.execute("second", { path: "fixture" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const beforeRelease = [...order];
		gate.resolve();
		await Promise.all([firstResult, secondResult]);
		expect(beforeRelease).toEqual(["first-start"]);
		expect(order).toEqual(["first-start", "first-end", "second"]);
	});

	it("lets an independent child finish while its parent is awaiting it", async () => {
		const childDone = Promise.withResolvers<void>();
		const waitTool: AgentTool = {
			...tool,
			name: "wait_child",
			execute: async () => {
				await childDone.promise;
				return { content: [], details: {} };
			},
		};
		const childTool: AgentTool = {
			...tool,
			name: "child_step",
			executionMode: "sequential",
			execute: async () => {
				childDone.resolve();
				return { content: [], details: {} };
			},
		};
		const dispatcher = new HarnessToolDispatcher({
			tools: () => [waitTool, childTool],
			context: () => ({ messages: [] }),
			assistantMessage: () => assistant,
		});
		const parentResult = dispatcher.execute("wait_child", { path: "fixture" });
		const childResult = dispatcher.execute(
			"child_step",
			{ path: "fixture" },
			{ assistantMessage: { ...assistant, timestamp: 2 } },
		);
		expect((await childResult).isError).toBe(false);
		expect((await parentResult).isError).toBe(false);
	});

	it("isolates per-call child context and forwards the requesting assistant message", async () => {
		const childContext: AgentContext = { messages: [], tools: [tool] };
		const assistantMessages = [
			{ ...assistant, timestamp: 2 },
			{ ...assistant, timestamp: 3 },
		];
		const contexts: AgentContext[] = [];
		const receivedMessages: AssistantMessage[] = [];
		const before = vi.fn(
			async ({ context, assistantMessage }: { context: AgentContext; assistantMessage: AssistantMessage }) => {
				contexts.push(context);
				receivedMessages.push(assistantMessage);
				context.messages.push({ role: "user", content: "hook mutation", timestamp: 1 });
				return undefined;
			},
		);
		const dispatcher = new HarnessToolDispatcher({
			tools: () => [tool],
			context: () => ({ messages: [] }),
			assistantMessage: () => assistant,
			beforeToolCall: before,
		});

		await Promise.all([
			dispatcher.execute(
				"read_test",
				{ path: "first" },
				{ context: childContext, assistantMessage: assistantMessages[0] },
			),
			dispatcher.execute(
				"read_test",
				{ path: "second" },
				{ context: childContext, assistantMessage: assistantMessages[1] },
			),
		]);

		expect(childContext.messages).toEqual([]);
		expect(contexts).toHaveLength(2);
		expect(contexts[0]).not.toBe(contexts[1]);
		expect(contexts[0]?.messages).not.toBe(contexts[1]?.messages);
		expect(contexts[0]?.tools).not.toBe(contexts[1]?.tools);
		expect(contexts.map((context) => context.messages)).toEqual([
			[{ role: "user", content: "hook mutation", timestamp: 1 }],
			[{ role: "user", content: "hook mutation", timestamp: 1 }],
		]);
		expect(receivedMessages).toEqual(assistantMessages);
	});
});
