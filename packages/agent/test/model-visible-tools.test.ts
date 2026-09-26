import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getCurrentTools,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentTool, type StreamFn } from "../src/index.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => {
			if (message.stopReason === "error" || message.stopReason === "aborted")
				this.push({ type: "error", reason: message.stopReason, error: message });
			else if (message.stopReason === "pending")
				throw new Error("Mock stream requires a finalized assistant message");
			else this.push({ type: "done", reason: message.stopReason, message });
		});
	}
}

const model: Model<"openai-responses"> = {
	id: "test",
	name: "test",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
};

function createTool(name: string, execute: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute,
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: Parameters<Agent["convertToLlm"]>[0]): Message[] {
	return messages.filter(
		(message) =>
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult",
	) as Message[];
}

describe("Agent model-visible tools", () => {
	it("filters provider declarations without changing executable tools and only declares changes when needed", async () => {
		let hiddenExecutions = 0;
		let disabledExecutions = 0;
		const hiddenTool = createTool("hidden", async () => {
			hiddenExecutions++;
			return { content: [{ type: "text", text: "hidden executed" }], details: {} };
		});
		const visibleTool = createTool("visible", async () => ({ content: [], details: {} }));
		const _disabledTool = createTool("disabled", async () => {
			disabledExecutions++;
			return { content: [], details: {} };
		});
		const requests: Array<{ tools: string[]; toolChanges: string[] }> = [];
		let streamCalls = 0;
		const streamFn: StreamFn = (_requestModel, context) => {
			streamCalls++;
			requests.push({
				tools: getCurrentTools(context.messages).map((tool) => tool.name),
				toolChanges: context.messages.flatMap((message) =>
					message.role === "system" && (message.toolsAdded !== undefined || message.toolsRemoved !== undefined)
						? [
								`+${(message.toolsAdded ?? []).map((tool) => tool.name).join(",")}/-${(message.toolsRemoved ?? []).map((tool) => tool.name).join(",")}`,
							]
						: [],
				),
			});
			const message =
				streamCalls === 1
					? assistantMessage(
							[
								{
									type: "toolCall",
									id: "hidden-call",
									name: "hidden",
									arguments: {},
								},
								{
									type: "toolCall",
									id: "disabled-call",
									name: "disabled",
									arguments: {},
								},
							],
							"toolUse",
						)
					: assistantMessage([{ type: "text", text: "done" }], "stop");
			return new MockAssistantStream(message);
		};
		const agent = new Agent({
			initialState: {
				systemPrompt: "Test system",
				model,
				tools: [visibleTool, hiddenTool],
			},
			convertToLlm: identityConverter,
			streamFn,
		});

		agent.setModelVisibleTools(["visible"]);
		const visibleNames = agent.getModelVisibleTools();
		visibleNames?.push("disabled");
		expect(agent.getModelVisibleTools()).toEqual(["visible"]);

		await agent.prompt(userMessage("first"));
		expect(requests.slice(0, 2).map((request) => request.tools)).toEqual([["visible"], ["visible"]]);
		expect(agent.state.tools.map((tool) => tool.name)).toEqual(["visible", "hidden"]);
		expect(hiddenExecutions).toBe(1);
		expect(disabledExecutions).toBe(0);

		agent.setModelVisibleTools(["hidden"]);
		await agent.prompt(userMessage("toggle visibility"));
		await agent.prompt(userMessage("same visibility"));
		expect(requests[2]?.tools).toEqual(["hidden"]);
		expect(requests[3]?.tools).toEqual(["hidden"]);
		expect(requests[3]?.toolChanges).toEqual(requests[2]?.toolChanges);

		agent.setModelVisibleTools(undefined);
		await agent.prompt(userMessage("show all active tools"));
		await agent.prompt(userMessage("all remains stable"));
		expect(requests[4]?.tools.slice().sort()).toEqual(["hidden", "visible"]);
		expect(requests[5]?.tools.slice().sort()).toEqual(["hidden", "visible"]);
		expect(requests[5]?.toolChanges).toEqual(requests[4]?.toolChanges);
	});
});
