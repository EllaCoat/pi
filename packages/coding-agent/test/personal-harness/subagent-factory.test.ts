import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createPiSubagentSessionFactory } from "../../src/personal-harness/subagent-factory.ts";
import { HarnessUsageLedger } from "../../src/personal-harness/usage.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";

const echo: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo a child request",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_id, args) => {
		if (typeof args !== "object" || args === null || !("text" in args) || typeof args.text !== "string")
			throw new Error("Invalid echo input");
		return { content: [{ type: "text", text: args.text }], details: {} };
	},
};

describe("Pi subagent session factory", () => {
	let harness: Harness | undefined;
	let dataDir: string | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.session.dispose();
			harness.cleanup();
			harness = undefined;
		}
		if (dataDir) {
			rmSync(dataDir, { recursive: true, force: true });
			dataDir = undefined;
		}
	});

	it("executes an idle parent's host tool with the child's message and preserves refusals as tool errors", async () => {
		let api: ExtensionAPI | undefined;
		let rejectEcho = false;
		const hostCalls: string[] = [];
		harness = await createHarness({
			tools: [echo],
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("tool_call", (event) => {
						if (event.toolName !== "echo") return;
						hostCalls.push(event.toolName);
						if (rejectEcho) return { block: true, reason: "Parent approval denied" };
					});
				},
			],
		});
		dataDir = mkdtempSync(join(tmpdir(), "pi-child-factory-"));
		const extensionApi = api;
		if (!extensionApi) throw new Error("Test extension did not load");
		const context = harness.session.extensionRunner.createContext();
		const factory = createPiSubagentSessionFactory({
			api: extensionApi,
			context,
			dataDir,
			evaluate: async () => {
				throw new Error("Jev hook is not used in this test");
			},
			ledger: new HarnessUsageLedger(),
		});
		const model = harness.getModel();
		const request = {
			task: "Inspect the fixture",
			provider: model.provider,
			model: model.id,
			thinking: "off" as const,
		};

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "from child while parent is idle" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Child completed the host call."),
		]);
		const child = await factory(request, new AbortController().signal);
		const childResult: ToolResultMessage[] = [];
		child.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "toolResult") childResult.push(event.message);
		});
		await child.prompt(request.task);
		expect(hostCalls).toEqual(["echo"]);
		expect(child.getLastAssistantText()).toBe("Child completed the host call.");
		expect(childResult[0]).toMatchObject({ toolName: "echo", isError: false });
		expect(getMessageText(childResult[0])).toBe("from child while parent is idle");
		await child.dispose();

		rejectEcho = true;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "must not run" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("I will report the denied call."),
		]);
		const deniedChild = await factory(request, new AbortController().signal);
		const deniedResult: ToolResultMessage[] = [];
		deniedChild.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "toolResult") deniedResult.push(event.message);
		});
		await deniedChild.prompt(request.task);
		expect(deniedResult[0]).toMatchObject({ toolName: "echo", isError: true });
		expect(getMessageText(deniedResult[0])).toContain("Parent approval denied");
		await deniedChild.dispose();
		expect(hostCalls).toEqual(["echo", "echo"]);
	});

	it("marks child eval exceptions as tool errors and includes execution receipts", async () => {
		let api: ExtensionAPI | undefined;
		harness = await createHarness({
			tools: [echo],
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerTool({
						name: "goal",
						label: "parent-only",
						description: "Parent-only control",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					});
				},
			],
		});
		dataDir = mkdtempSync(join(tmpdir(), "pi-child-eval-"));
		const extensionApi = api;
		if (!extensionApi) throw new Error("Test extension did not load");
		const context = harness.session.extensionRunner.createContext();
		const factory = createPiSubagentSessionFactory({
			api: extensionApi,
			context,
			dataDir,
			evaluate: async () => {
				throw new Error("Jev hook is not used in this test");
			},
			ledger: new HarnessUsageLedger(),
		});
		const model = harness.getModel();
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("eval", { language: "javascript", code: "display(await tool.tool_info({}));" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("eval", { language: "javascript", code: "throw new Error('child cell failed')" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The cell error was reported."),
		]);
		const child = await factory(
			{ task: "Run the cell", provider: model.provider, model: model.id, thinking: "off" },
			new AbortController().signal,
		);
		const evalResult: ToolResultMessage[] = [];
		child.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "toolResult") evalResult.push(event.message);
		});
		await child.prompt("Run the cell");
		expect(JSON.parse(getMessageText(evalResult[0])).map((tool: { name: string }) => tool.name)).toEqual([
			"echo",
			"eval",
			"tool_info",
		]);
		expect(evalResult[1]).toMatchObject({
			toolName: "eval",
			isError: true,
			details: { toolExecutions: [], harnessDerivedRecall: false },
		});
		expect(getMessageText(evalResult[1])).toContain("child cell failed");
		await child.dispose();
	});
});
