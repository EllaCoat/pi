import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolResult } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const tinyBmp = (() => {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return { type: "image" as const, data: buffer.toString("base64"), mimeType: "image/bmp" };
})();

function textOf(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("Extension host-tool bridge", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs active tools through session hooks and validation without adding nested results to history", async () => {
		const beforeEvents: string[] = [];
		const afterEvents: string[] = [];
		const nestedResults: ExtensionToolResult[] = [];
		let api: ExtensionAPI | undefined;
		let denyEcho = false;
		let metadataIncludesEcho = false;
		const echoExecute = vi.fn(async (_toolCallId: string, input: unknown) => {
			const text =
				typeof input === "object" && input !== null && "text" in input && typeof input.text === "string"
					? input.text
					: "";
			return { content: [{ type: "text" as const, text }], details: { text } };
		});
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Return the supplied text",
			parameters: Type.Object({ text: Type.String() }),
			replay: "never",
			execute: echoExecute,
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("tool_call", async (event) => {
						beforeEvents.push(event.toolName);
						if (event.toolName === "echo" && denyEcho) return { block: true, reason: "User approval required" };
						return undefined;
					});
					pi.on("tool_result", async (event) => {
						afterEvents.push(event.toolName);
						if (event.toolName === "echo") {
							return { content: [tinyBmp], details: { changedBy: "tool_result" } };
						}
						return undefined;
					});
					pi.registerTool({
						name: "bridge",
						label: "Bridge",
						description: "Call active host tools",
						parameters: Type.Object({}),
						execute: async (_toolCallId, _input, signal, _onUpdate, ctx) => {
							const fromContext = await ctx.executeTool("echo", { text: "from ctx" }, { signal });
							nestedResults.push(fromContext);
							const fromApi = await api!.executeTool("echo", { text: "from pi" }, { signal });
							nestedResults.push(fromApi);

							denyEcho = true;
							nestedResults.push(await api!.executeTool("echo", { text: "blocked" }, { signal }));
							denyEcho = false;
							nestedResults.push(await api!.executeTool("echo", {}, { signal }));
							metadataIncludesEcho = api!.getAllTools().some((tool) => tool.name === "echo");
							api!.setActiveTools(["bridge"]);
							nestedResults.push(await api!.executeTool("echo", { text: "inactive" }, { signal }));
							return { content: [{ type: "text", text: "bridge complete" }], details: { completed: true } };
						},
					});
				},
			],
		});
		harnesses.push(harness);

		const apiBeforePrompt = api!;
		const messageCountBeforeUncontextualCall = harness.session.messages.length;
		const uncontextual = await apiBeforePrompt.executeTool("echo", { text: "no assistant message" });
		expect(uncontextual.isError).toBe(true);
		expect(textOf(uncontextual.content)).toContain("active assistant message");
		expect(echoExecute).not.toHaveBeenCalled();
		expect(harness.session.messages).toHaveLength(messageCountBeforeUncontextualCall);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bridge", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run the bridge");

		expect(beforeEvents).toEqual(["bridge", "echo", "echo", "echo"]);
		expect(afterEvents).toEqual(["echo", "echo", "bridge"]);
		expect(echoExecute).toHaveBeenCalledTimes(2);
		expect(nestedResults).toHaveLength(5);
		expect(nestedResults[0]?.isError).toBe(false);
		expect(nestedResults[1]?.isError).toBe(false);
		expect(nestedResults[0]?.toolCallId).toBeTruthy();
		expect(nestedResults[0]?.details).toEqual({ changedBy: "tool_result" });
		expect(nestedResults[0]?.content).toContainEqual(
			expect.objectContaining({ type: "image", mimeType: "image/png" }),
		);
		expect(textOf(nestedResults[0]!.content)).toContain("converted from image/bmp to image/png");
		expect(nestedResults[2]?.isError).toBe(true);
		expect(textOf(nestedResults[2]!.content)).toContain("User approval required");
		expect(nestedResults[3]?.isError).toBe(true);
		expect(textOf(nestedResults[3]!.content)).toContain('Validation failed for tool "echo"');
		expect(nestedResults[4]?.isError).toBe(true);
		expect(metadataIncludesEcho).toBe(true);
		expect(harness.session.getActiveToolNames()).toEqual(["bridge"]);
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("echo");
		expect(
			harness.session.messages.filter((message) => message.role === "toolResult").map((message) => message.toolName),
		).toEqual(["bridge"]);
	});

	it("passes cancellation to the active host tool and does not replay its side effect", async () => {
		const started = Promise.withResolvers<void>();
		const controller = new AbortController();
		const afterEvents: string[] = [];
		let nestedResult: ExtensionToolResult | undefined;
		const slowExecute = vi.fn(async (_toolCallId: string, _input: unknown, signal?: AbortSignal) => {
			started.resolve();
			const pending = Promise.withResolvers<never>();
			if (signal?.aborted) pending.reject(new Error("aborted"));
			else signal?.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
			return pending.promise;
		});
		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Wait for cancellation",
			parameters: Type.Object({}),
			replay: "never",
			execute: slowExecute,
		};
		const harness = await createHarness({
			tools: [slowTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async (event) => {
						afterEvents.push(event.toolName);
						return undefined;
					});
					pi.registerTool({
						name: "cancel_bridge",
						label: "Cancel bridge",
						description: "Call a cancellable host tool",
						parameters: Type.Object({}),
						execute: async (_toolCallId, _input, _signal, _onUpdate, ctx) => {
							nestedResult = await ctx.executeTool("slow", {}, { signal: controller.signal });
							return { content: nestedResult.content, details: nestedResult.details };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("cancel_bridge", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("cancelled"),
		]);

		const prompt = harness.session.prompt("cancel the nested tool");
		await started.promise;
		controller.abort();
		await prompt;

		expect(slowExecute).toHaveBeenCalledTimes(1);
		expect(nestedResult?.isError).toBe(true);
		expect(textOf(nestedResult!.content)).toContain("aborted");
		expect(afterEvents).toContain("slow");
	});
});
