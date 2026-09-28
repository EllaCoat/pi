import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createPiSubagentSessionFactory } from "../../src/personal-harness/subagent-factory.ts";
import {
	type HarnessChildSession,
	type HarnessSubagentCallbacks,
	HarnessSubagents,
} from "../../src/personal-harness/subagents.ts";
import { HarnessUsageLedger } from "../../src/personal-harness/usage.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";

const noChildMessages: HarnessSubagentCallbacks = { onMessage: async () => undefined };

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

const blocked: AgentTool = {
	name: "blocked",
	label: "Blocked",
	description: "A tool excluded from one child",
	parameters: Type.Object({ text: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "must not execute" }], details: {} }),
};

const skillRead: AgentTool = {
	name: "skill_read",
	label: "Read skill",
	description: "Read a caller skill",
	parameters: Type.Object({ uri: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "must not read" }], details: {} }),
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
		const child = await factory(request, new AbortController().signal, noChildMessages);
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
		const deniedChild = await factory(request, new AbortController().signal, noChildMessages);
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
		let childSystemPrompt = "";
		harness.setResponses([
			(context: TranscriptContext) => {
				childSystemPrompt = JSON.stringify(context.messages.filter((message) => message.role === "system"));
				return fauxAssistantMessage(
					[fauxToolCall("eval", { language: "javascript", code: "display(await tool.tool_info({}));" })],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(
				[fauxToolCall("eval", { language: "javascript", code: "throw new Error('child cell failed')" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The cell error was reported."),
		]);
		const child = await factory(
			{ task: "Run the cell", provider: model.provider, model: model.id, thinking: "off" },
			new AbortController().signal,
			noChildMessages,
		);
		const evalResult: ToolResultMessage[] = [];
		child.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "toolResult") evalResult.push(event.message);
		});
		await child.prompt("Run the cell");
		expect(childSystemPrompt).toContain(
			"Run persistent code in the child's separate kernel with its selected host tools; tool selection is not user approval.",
		);
		expect(childSystemPrompt).toContain("You are a subagent with an explicitly delegated task.");
		expect(childSystemPrompt).toContain("Report findings, changes, relevant checks, and uncertainty to the parent.");
		expect(childSystemPrompt).toContain("Match verification to your assignment:");
		expect(JSON.parse(getMessageText(evalResult[0])).map((tool: { name: string }) => tool.name)).toEqual([
			"echo",
			"eval",
			"message_parent",
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
	it("filters eval tools, disables skills by default, and returns parent replies to a running faux-provider child", async () => {
		let api: ExtensionAPI | undefined;
		const hostCalls: string[] = [];
		const mcpCalls: string[] = [];
		const mcpTool: AgentTool = {
			name: "mcp",
			label: "MCP",
			description: "Call a fixture MCP tool",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("discover"), Type.Literal("call")]),
				server: Type.String(),
				name: Type.Optional(Type.String()),
				arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			}),
			execute: async (_id, args) => {
				const input = args as { action: string; server: string; name?: string };
				mcpCalls.push(`${input.server}/${input.name ?? ""}`);
				if (input.action === "discover")
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									server: input.server,
									tools: [
										{ name: "allowed", inputSchema: { type: "object" } },
										{ name: "unlisted_remote_fixture", inputSchema: { type: "object" } },
									],
									resources: [{ name: "unselected_resource" }],
									prompts: [{ name: "unselected_prompt" }],
								}),
							},
						],
						details: {},
					};
				return { content: [{ type: "text", text: "fixture MCP call" }], details: {} };
			},
		};
		harness = await createHarness({
			tools: [echo, blocked, skillRead, mcpTool],
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("tool_call", (event) => {
						if (
							event.toolName === "echo" ||
							event.toolName === "blocked" ||
							event.toolName === "skill_read" ||
							event.toolName === "mcp"
						)
							hostCalls.push(event.toolName);
					});
				},
			],
		});
		dataDir = mkdtempSync(join(tmpdir(), "pi-child-messaging-"));
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
		const childReady = Promise.withResolvers<HarnessChildSession>();
		const beginChild = Promise.withResolvers<void>();
		const parentMessages = vi.fn();
		const manager = new HarnessSubagents({
			createSession: async (request, signal, callbacks) => {
				const child = await factory(request, signal, callbacks);
				childReady.resolve(child);
				await beginChild.promise;
				return child;
			},
			ledger: new HarnessUsageLedger(),
			onMessage: parentMessages,
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("eval", {
						language: "javascript",
						code: 'display(await tool.message_parent({text: "Can I inspect fixture A?", waitForReply: true}));',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("eval", {
						language: "javascript",
						code: [
							"display(await tool.tool_info({}));",
							'display(await tool.tool_info({name: "mcp"}));',
							'display(await tool.mcp({action: "discover", server: "fixture"}));',
							'display(await tool.echo({text: "selected"}));',
							'try { await tool.blocked({text: "blocked"}); } catch (error) { display(error.message); }',
							'try { await tool.skill_read({uri: "skill://secret"}); } catch (error) { display(error.message); }',
							'display(await tool.mcp({action: "call", server: "fixture", name: "allowed", arguments: {}}));',
							'try { await tool.mcp({action: "call", server: "fixture", name: "denied"}); } catch (error) { display(error.message); }',
							'try { await tool.mcp({action: "call", server: "other", name: "allowed"}); } catch (error) { display(error.message); }',
						].join("\n"),
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The selected host tool ran after the parent replied."),
		]);
		const job = manager.start({
			task: "Inspect fixture A",
			context: "Only compare the generated output with fixture A.",
			provider: model.provider,
			model: model.id,
			thinking: "off",
			allowedTools: ["echo", "mcp"],
			mcp: [{ server: "fixture", names: ["allowed"] }],
		});
		const child = await childReady.promise;
		const childResults: ToolResultMessage[] = [];
		child.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "toolResult") childResults.push(event.message);
		});
		beginChild.resolve();

		const intermediate = await manager.wait(job.id);
		expect(intermediate).toEqual({
			type: "message",
			message: { id: job.id, text: "Can I inspect fixture A?" },
		});
		expect(parentMessages).toHaveBeenCalledOnce();
		expect(parentMessages).toHaveBeenCalledWith({ id: job.id, text: "Can I inspect fixture A?" }, true);
		await manager.send(job.id, "Inspect fixture A only.");
		const final = await manager.wait(job.id);
		expect(final).toMatchObject({
			type: "result",
			result: { status: "completed", text: "The selected host tool ran after the parent replied." },
		});
		expect(manager.result(job.id)).toEqual(final.type === "result" ? final.result : undefined);
		expect(hostCalls).toEqual(["mcp", "echo", "mcp"]);
		expect(mcpCalls).toEqual(["fixture/", "fixture/allowed"]);
		const evalResults = childResults.filter((result) => result.toolName === "eval");
		expect(evalResults).toHaveLength(2);
		expect(getMessageText(evalResults[0])).toContain("Inspect fixture A only.");
		const selectedToolOutput = getMessageText(evalResults[1]);
		expect(selectedToolOutput).toContain('"message_parent"');
		expect(selectedToolOutput).toContain('"echo"');
		expect(selectedToolOutput).toContain('"mcp"');
		expect(selectedToolOutput).toContain('"const":"allowed"');
		expect(selectedToolOutput).not.toContain("unlisted_remote_fixture");
		expect(selectedToolOutput).not.toContain("unselected_resource");
		expect(selectedToolOutput).not.toContain("unselected_prompt");
		expect(selectedToolOutput).toContain("Tool blocked is not in the child host-tool allowlist");
		expect(selectedToolOutput).toContain("Tool skill_read is not in the child host-tool allowlist");
		expect(selectedToolOutput).toContain("MCP operation is not allowed for this child: fixture");
		expect(selectedToolOutput).toContain("MCP server is not allowed for this child: other");
		await manager.close();

		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("eval", { language: "javascript", code: "display(await tool.tool_info({}));" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The default child has no skills."),
		]);
		const defaultChild = await factory(
			{ task: "Check default tools", provider: model.provider, model: model.id, thinking: "off" },
			new AbortController().signal,
			noChildMessages,
		);
		const defaultResults: ToolResultMessage[] = [];
		defaultChild.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "toolResult") defaultResults.push(event.message);
		});
		await defaultChild.prompt("Check default tools");
		const defaultToolCatalog = getMessageText(defaultResults[0]);
		expect(defaultToolCatalog).toContain('"blocked"');
		expect(defaultToolCatalog).not.toContain('"skill_read"');
		expect(defaultToolCatalog).not.toContain('"skill_index"');
		await defaultChild.dispose();
	});
});
