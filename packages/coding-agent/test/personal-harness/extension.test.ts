import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import {
	createPersonalHarnessExtension,
	type PersonalHarnessExtensionOptions,
} from "../../src/personal-harness/extension.ts";
import { INPUT_SOURCE_ENTRY } from "../../src/personal-harness/hooks/input-advice.ts";
import type { JevEvaluationInput, JevEvaluationResponse } from "../../src/personal-harness/hooks/jev-types.ts";
import type { HarnessMcpClient } from "../../src/personal-harness/mcp/index.ts";
import { type MemoryExcerpt, PersonalMemoryStore } from "../../src/personal-harness/memory/index.ts";
import * as modelCalls from "../../src/personal-harness/model-call.ts";
import { TODO_SESSION_ENTRY_TYPE } from "../../src/personal-harness/todo/index.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

const echo: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo an input",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_id, args) => {
		if (typeof args !== "object" || args === null || !("text" in args) || typeof args.text !== "string")
			throw new Error("Invalid echo input");
		return { content: [{ type: "text", text: args.text }], details: {} };
	},
};

function resultText(harness: Harness, name: string): string[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult" && message.toolName === name)
		.map(getMessageText);
}

describe("personal harness extension in an AgentSession", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	function dataDirectory(): string {
		const path = mkdtempSync(join(tmpdir(), "pi-extension-data-"));
		directories.push(path);
		return path;
	}
	async function create(
		dataDir: string,
		extra: Parameters<typeof createHarness>[0] = {},
		options: PersonalHarnessExtensionOptions = {},
	): Promise<Harness> {
		const harness = await createHarness({
			...extra,
			tools: extra.tools ?? [echo],
			settings: { cacheWarming: "off", ...extra.settings },
			extensionFactories: [
				createPersonalHarnessExtension({ dataDir, todoDebounceMs: 60_000, ...options }),
				...(extra.extensionFactories ?? []),
			],
		});
		harnesses.push(harness);
		return harness;
	}
	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length) {
			const harness = harnesses.pop()!;
			await harness.session.dispose();
			harness.cleanup();
		}
		for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("caps both child notifications at 10000 characters while explicit retrieval keeps full text", async () => {
		const intermediate = "ordinary child update ".repeat(600);
		const finalText = "ordinary final result ".repeat(600);
		const harness = await create(
			dataDirectory(),
			{},
			{
				createSubagentSession: async (_request, signal, callbacks) => ({
					prompt: async () => {
						await callbacks.onMessage(intermediate, false, signal);
					},
					send: async () => {},
					abort: async () => {},
					dispose: async () => {},
					getLastAssistantText: () => finalText,
					subscribe: () => () => {},
				}),
			},
		);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("task", {
						action: "spawn",
						task: "Long report fixture",
						provider: "fixture",
						model: "fixture",
						thinking: "off",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Started."),
		]);
		await harness.session.prompt("Run the artificial long report");
		const id = JSON.parse(resultText(harness, "task")[0]).id;
		await vi.waitFor(() =>
			expect(
				harness.session.messages.filter(
					(m) =>
						m.role === "custom" &&
						["personal-harness-child-message", "personal-harness-child-result"].includes(m.customType),
				),
			).toHaveLength(2),
		);
		const notices = harness.session.messages.filter(
			(m) =>
				m.role === "custom" &&
				["personal-harness-child-message", "personal-harness-child-result"].includes(m.customType),
		);
		for (const notice of notices) expect(getMessageText(notice).length).toBeLessThanOrEqual(10000);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { action: "wait", id })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("task", { action: "result", id })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Read both full messages."),
		]);
		await harness.session.prompt("Read the complete stored texts");
		const results = resultText(harness, "task");
		expect(JSON.parse(results.at(-2)!)).toMatchObject({ type: "message", message: { id, text: intermediate } });
		expect(JSON.parse(results.at(-1)!)).toMatchObject({ id, text: finalText });
	});

	it("routes intermediate child messages and replies through the task tool", async () => {
		let childText = "";
		const requestSeen: unknown[] = [];
		const harness = await create(
			dataDirectory(),
			{},
			{
				createSubagentSession: async (request, signal, callbacks) => {
					requestSeen.push(request);
					return {
						prompt: async () => {
							childText = (await callbacks.onMessage("Please choose fixture A or B.", true, signal)) ?? "";
						},
						send: async () => {
							throw new Error("A waiting child reply must not steer another model turn");
						},
						abort: async () => {},
						dispose: async () => {},
						getLastAssistantText: () => childText,
						subscribe: () => () => {},
					};
				},
			},
		);
		let id = "";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("task", {
						action: "spawn",
						task: "Inspect fixture",
						context: "Only artificial inputs",
						provider: "fixture",
						model: "fixture",
						thinking: "off",
						allowedTools: ["echo"],
						mcp: [],
					}),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				id = JSON.parse(resultText(harness, "task").at(-1)!).id;
				return fauxAssistantMessage([fauxToolCall("task", { action: "wait", id })], { stopReason: "toolUse" });
			},
			() => {
				expect(JSON.parse(resultText(harness, "task").at(-1)!)).toMatchObject({
					type: "message",
					message: { id, text: "Please choose fixture A or B." },
				});
				return fauxAssistantMessage([fauxToolCall("task", { action: "send", id, message: "Choose A." })], {
					stopReason: "toolUse",
				});
			},
			() => fauxAssistantMessage([fauxToolCall("task", { action: "wait", id })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Child replied."),
		]);
		await harness.session.prompt("Run the child and answer its question");
		expect(JSON.parse(resultText(harness, "task").at(-1)!)).toMatchObject({
			type: "result",
			result: { status: "completed", text: "Choose A." },
		});
		expect(requestSeen[0]).toMatchObject({ context: "Only artificial inputs", allowedTools: ["echo"], mcp: [] });
	});

	it("runs persistent JavaScript with host hooks, shows partial failure, and blocks recursive eval", async () => {
		const seen: string[] = [];
		const harness = await create(dataDirectory(), {
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) => {
						seen.push(event.toolName);
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("eval", {
						language: "javascript",
						code: "const carried = 41; display(await tool.echo({text: 'host-result'}));",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("eval", {
						language: "javascript",
						code: "display(carried + 1); throw new Error('intentional-cell-error');",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("eval", {
						language: "javascript",
						code: "await tool.eval({language:'javascript',code:'1'});",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Run the code fixture");
		const results = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "eval",
		);
		expect(getMessageText(results[0])).toContain("host-result");
		expect(getMessageText(results[1])).toContain("42");
		expect(getMessageText(results[1])).toContain("intentional-cell-error");
		expect(results[1]).toMatchObject({ isError: true });
		expect(getMessageText(results[2])).toContain("Recursive");
		expect(results[2]).toMatchObject({ isError: true });
		expect(seen.filter((name) => name === "echo")).toHaveLength(1);
	});

	it.each(["direct", "eval"])(
		"recalls prior sessions without reindexing %s generated recall payloads",
		async (mode) => {
			const dataDir = dataDirectory();
			const first = await create(dataDir);
			first.setResponses([fauxAssistantMessage("The cobalt fixture is stored in the archive.")]);
			await first.session.prompt("Remember where the cobalt fixture is stored.");
			vi.spyOn(modelCalls, "completeHarnessTask").mockImplementation(async (options) => {
				const content = options.context.messages[0].content;
				if (typeof content !== "string") throw new Error("Expected structured curator input");
				const input = JSON.parse(content) as { records: MemoryExcerpt[] };
				const source = input.records[0];
				if (!source) throw new Error("No source reached the curator");
				return fauxAssistantMessage(
					[
						fauxToolCall("return_memory_curate", {
							text: "DERIVED_ONLY_SENTINEL: cobalt belongs in the archive.",
							citations: [
								{
									sessionId: source.sessionId,
									branchId: source.branchId,
									entryId: source.entryId,
									sourceRevision: source.sourceRevision,
									kind: source.kind,
									range: { start: source.range.start, end: source.range.end },
								},
							],
						}),
					],
					{ stopReason: "toolUse" },
				);
			});
			const second = await create(dataDir);
			second.setResponses([
				fauxAssistantMessage(
					[
						mode === "direct"
							? fauxToolCall("recall", { query: "cobalt fixture" })
							: fauxToolCall("eval", {
									language: "javascript",
									code: "const recalled = await tool.recall({query: 'cobalt fixture'}); display(recalled);",
								}),
					],
					{ stopReason: "toolUse" },
				),
				...(mode === "eval"
					? [
							fauxAssistantMessage(
								[fauxToolCall("eval", { language: "javascript", code: "display(recalled);" })],
								{ stopReason: "toolUse" },
							),
						]
					: []),
				fauxAssistantMessage("Looked up the prior record."),
			]);
			await second.session.prompt("Consult previous work.");
			expect(resultText(second, mode === "direct" ? "recall" : "eval")[0]).toContain("DERIVED_ONLY_SENTINEL");
			if (mode === "eval") {
				expect(resultText(second, "eval")[1]).toContain("DERIVED_ONLY_SENTINEL");
				const branch = second.sessionManager.getBranch();
				const evalIds = new Set(
					branch
						.filter(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolName === "eval",
						)
						.map((entry) => entry.id),
				);
				for (const entry of branch) {
					if (entry.type !== "custom" || entry.customType !== TODO_SESSION_ENTRY_TYPE) continue;
					const snapshot = entry.data as { evidence: { entryId: string }[] };
					expect(snapshot.evidence.some((evidence) => evalIds.has(evidence.entryId))).toBe(false);
				}
			}
			const reader = new PersonalMemoryStore({ databasePath: join(dataDir, "memory.sqlite") });
			try {
				expect(reader.search("DERIVED_ONLY_SENTINEL").candidates).toHaveLength(0);
				expect(reader.search("cobalt fixture").candidates.length).toBeGreaterThan(0);
			} finally {
				reader.close();
			}
		},
	);

	it("does not turn a failed nested operation into successful TODO evidence", async () => {
		const fail: AgentTool = {
			...echo,
			name: "fail",
			execute: async () => {
				throw new Error("fixture-operation-failed");
			},
		};
		const harness = await create(dataDirectory(), { tools: [fail] });
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("eval", { language: "javascript", code: "display(await tool.fail({text:'failure'}));" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("failure observed"),
		]);
		await harness.session.prompt("Observe a failed operation");
		const entry = harness.sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "eval",
			);
		expect(entry?.type === "message" ? entry.message : undefined).toMatchObject({
			isError: false,
			details: { toolExecutions: [{ name: "fail", status: "failure" }] },
		});
		const saved = harness.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === TODO_SESSION_ENTRY_TYPE);
		expect(saved?.type === "custom" ? saved.data : undefined).toMatchObject({
			evidence: expect.arrayContaining([expect.objectContaining({ entryId: entry?.id, outcome: "failure" })]),
		});
	});

	it("discovers a tools-only MCP server and preserves structured-only results through eval", async () => {
		const resources = vi.fn(async () => {
			throw new Error("unsupported resources");
		});
		const prompts = vi.fn(async () => {
			throw new Error("unsupported prompts");
		});
		const client = {
			isConnected: true,
			getInfo: () => ({ transportType: "stdio", serverCapabilities: { tools: {} } }),
			listTools: async () => ({
				tools: [{ name: "answer", inputSchema: { type: "object" } }],
				fingerprint: "fixture",
			}),
			listResources: resources,
			listPrompts: prompts,
			call: async () => ({ content: [], structuredContent: { value: 42 } }),
			close: async () => {},
		} as unknown as HarnessMcpClient;
		const harness = await create(
			dataDirectory(),
			{},
			{
				mcpServers: { fixture: { transport: { type: "stdio", command: "fixture" } } },
				createMcpClient: () => client,
			},
		);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp", { action: "discover", server: "fixture" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("mcp", { action: "call", server: "fixture", name: "answer" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("eval", {
						language: "javascript",
						code: "display((await tool.mcp({action:'call',server:'fixture',name:'answer'})).details.structuredContent.value);",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Discover and use the MCP result");
		expect(resultText(harness, "mcp")[0]).toContain("answer");
		expect(resultText(harness, "mcp")[1]).toContain('"value":42');
		expect(resultText(harness, "eval")[0]).toContain("42");
		expect(resources).not.toHaveBeenCalled();
		expect(prompts).not.toHaveBeenCalled();
	});

	it("resets kernels and restores the selected TODO after navigation to a linear ancestor", async () => {
		const harness = await create(dataDirectory());
		harness.setResponses([fauxAssistantMessage("initial checkpoint")]);
		await harness.session.prompt("Start this test");
		const ancestor = harness.sessionManager.getLeafId()!;
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("eval", { language: "javascript", code: "const futureValue = 42; display(futureValue);" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("todo", { action: "add", title: "Future-only TODO" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("future state"),
		]);
		await harness.session.prompt("Create state after the checkpoint");
		await harness.session.navigateTree(ancestor);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("eval", { language: "javascript", code: "display(typeof futureValue);" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("todo", { action: "list" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("checked"),
		]);
		await harness.session.prompt("Check selected checkpoint state");
		expect(resultText(harness, "eval").at(-1)).toContain("undefined");
		expect(resultText(harness, "todo").at(-1)).not.toContain("Future-only TODO");
	});

	it("sends background child completion to TODO while the parent is idle", async () => {
		const childGate = Promise.withResolvers<void>();
		const requests: { changes: { kind: string; summary: string }[] }[] = [];
		vi.spyOn(modelCalls, "completeHarnessTask").mockImplementation(async (options) => {
			if (options.purpose !== "todo") throw new Error("Unexpected model purpose");
			requests.push(JSON.parse(String(options.context.messages[0].content)));
			return fauxAssistantMessage([fauxToolCall("return_todo_update", {})], { stopReason: "toolUse" });
		});
		const harness = await create(
			dataDirectory(),
			{},
			{
				todoDebounceMs: 1,
				createSubagentSession: async () => ({
					prompt: async () => childGate.promise,
					abort: async () => childGate.resolve(),
					send: async () => {},
					dispose: async () => {},
					getLastAssistantText: () => "child fixture finished",
					subscribe: () => () => {},
				}),
			},
		);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("task", {
						action: "spawn",
						task: "test",
						provider: "fixture",
						model: "fixture",
						thinking: "off",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("parent finished"),
		]);
		await harness.session.prompt("Start background work");
		expect(harness.session.isIdle).toBe(true);
		childGate.resolve();
		await vi.waitFor(() =>
			expect(
				requests.some((request) =>
					request.changes.some(
						(change) => change.kind === "child" && change.summary.includes("completed: child fixture finished"),
					),
				),
			).toBe(true),
		);
		const childId = JSON.parse(resultText(harness, "task")[0]).id;
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("eval", {
						language: "javascript",
						code: `display(await tool.task({action:'wait',id:${JSON.stringify(childId)}})); display(await tool.task({action:'result',id:${JSON.stringify(childId)}}));`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("child report read"),
		]);
		await harness.session.prompt("Read the child report without treating it as verification");
		const branch = harness.sessionManager.getBranch();
		const evalEntry = branch.findLast(
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "eval",
		);
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== TODO_SESSION_ENTRY_TYPE) continue;
			expect(
				(entry.data as { evidence: { entryId: string }[] }).evidence.some(
					(evidence) => evidence.entryId === evalEntry?.id,
				),
			).toBe(false);
		}
	});

	it("normalizes strict-model null optionals before applying background TODO updates", async () => {
		vi.spyOn(modelCalls, "completeHarnessTask").mockImplementation(async (options) => {
			const input = JSON.parse(String(options.context.messages[0].content)) as {
				currentTodo: { id: string }[];
				observedEvidence: { entryId: string; outcome: string }[];
			};
			const success = input.observedEvidence.find((evidence) => evidence.outcome === "success");
			return fauxAssistantMessage(
				[
					fauxToolCall("return_todo_update", {
						add: null,
						update:
							success && input.currentTodo[0]
								? [
										{
											id: input.currentTodo[0].id,
											title: null,
											status: "done",
											evidenceEntryIds: [success.entryId],
										},
									]
								: null,
					}),
				],
				{ stopReason: "toolUse" },
			);
		});
		const harness = await create(dataDirectory(), {}, { todoDebounceMs: 1 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("todo", { action: "add", title: "Verify fixture" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[fauxToolCall("eval", { language: "javascript", code: "display(await tool.echo({text:'verified'}));" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Verify the artificial fixture");
		await vi.waitFor(() =>
			expect(
				harness.sessionManager
					.getBranch()
					.some(
						(entry) =>
							entry.type === "custom" &&
							entry.customType === TODO_SESSION_ENTRY_TYPE &&
							(entry.data as { items: { status: string }[] }).items[0]?.status === "done",
					),
			).toBe(true),
		);
	});

	it("limits the first model tool surface while keeping permitted tools callable through eval", async () => {
		let api: ExtensionAPI | undefined;
		const requests: { names: string[]; system: string; toolChanges: number; evalDescription: string }[] = [];
		const respond = (message: AssistantMessage) => (context: TranscriptContext) => {
			const messages = context.messages;
			requests.push({
				names: getCurrentTools(messages).map((tool) => tool.name),
				system: JSON.stringify(messages.filter((message) => message.role === "system")),
				toolChanges: messages.filter(
					(message) => message.role === "system" && (message.toolsAdded?.length || message.toolsRemoved?.length),
				).length,
				evalDescription: getCurrentTools(messages).find((tool) => tool.name === "eval")?.description ?? "",
			});
			return message;
		};
		let executions = 0;
		const activeSelections: string[][] = [];
		const legacyPromptViews: string[] = [];
		const harness = await create(dataDirectory(), {
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("before_agent_start", (event, context) => {
						activeSelections.push([...event.systemPromptOptions.selectedTools]);
						legacyPromptViews.push(event.systemPrompt, context.getSystemPrompt());
						return { systemPrompt: `${event.systemPrompt}\nLEGACY_APPEND_MARKER` };
					});
					pi.registerTool({
						name: "hidden_fixture",
						label: "hidden fixture",
						description: "Hidden host fixture",
						promptSnippet: "HIDDEN_SNIPPET_SENTINEL",
						promptGuidelines: ["HIDDEN_GUIDELINE_SENTINEL"],
						parameters: Type.Object({ text: Type.String({ description: "HIDDEN_SCHEMA_SENTINEL" }) }),
						execute: async (_id, input) => {
							executions++;
							return { content: [{ type: "text", text: input.text }], details: {} };
						},
					});
				},
			],
		});
		harness.setResponses([
			respond(
				fauxAssistantMessage(
					[
						fauxToolCall("eval", {
							language: "javascript",
							code: "display(await tool.hidden_fixture({text:'BRIDGE_READY'}));",
						}),
					],
					{ stopReason: "toolUse" },
				),
			),
			respond(fauxAssistantMessage("done")),
		]);
		await harness.session.prompt("Run the permitted hidden host operation");
		expect(executions).toBe(1);
		expect(resultText(harness, "eval")[0]).toContain("BRIDGE_READY");
		expect(requests[0].evalDescription).toContain("await tool.tool_info({})");
		expect(requests[0].evalDescription).toContain('tool.tool_info({name: "NAME"})');
		expect(requests[0].names.sort()).toEqual(["eval", "todo"]);
		expect(requests[0].system).toContain("LEGACY_APPEND_MARKER");
		for (const prompt of legacyPromptViews) {
			expect(prompt).not.toContain("HIDDEN_SNIPPET_SENTINEL");
			expect(prompt).not.toContain("HIDDEN_GUIDELINE_SENTINEL");
		}
		for (const marker of ["HIDDEN_SCHEMA_SENTINEL", "HIDDEN_SNIPPET_SENTINEL", "HIDDEN_GUIDELINE_SENTINEL"])
			expect(requests[0].system).not.toContain(marker);
		const enabledLeaf = harness.sessionManager.getLeafId()!;
		const changesBefore = requests.at(-1)!.toolChanges;
		harness.setResponses([respond(fauxAssistantMessage("unchanged"))]);
		await harness.session.prompt("Continue without changing tools");
		expect(requests.at(-1)!.toolChanges).toBe(changesBefore);
		expect(api!.getActiveTools()).toContain("hidden_fixture");
		expect(activeSelections[1]).toContain("hidden_fixture");
		expect(harness.session.systemPrompt).not.toContain("HIDDEN_SNIPPET_SENTINEL");
		api!.setActiveTools(api!.getActiveTools().filter((name) => name !== "hidden_fixture"));
		harness.setResponses([
			respond(
				fauxAssistantMessage(
					[
						fauxToolCall("eval", {
							language: "javascript",
							code: "display(await tool.hidden_fixture({text:'must not execute'}));",
						}),
					],
					{ stopReason: "toolUse" },
				),
			),
			respond(fauxAssistantMessage("denied")),
		]);
		await harness.session.prompt("Observe the revoked operation");
		expect(executions).toBe(1);
		expect(resultText(harness, "eval").at(-1)).toContain("unavailable or not permitted");
		const disabledLeaf = harness.sessionManager.getLeafId()!;
		await harness.session.navigateTree(enabledLeaf, { summarize: false });
		expect(api!.getActiveTools()).toContain("hidden_fixture");
		expect(api!.getActiveTools()).toContain("tool_info");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("eval", {
						language: "javascript",
						code: "display(await tool.hidden_fixture({text: 'RESTORED'}));",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Use the restored host operation");
		expect(executions).toBe(2);
		await harness.session.navigateTree(disabledLeaf, { summarize: false });
		expect(api!.getActiveTools()).not.toContain("hidden_fixture");
	});

	it("records assistant latency when stream events use different message objects", async () => {
		const harness = await create(dataDirectory(), {
			extensionFactories: [
				(pi) => {
					pi.on("message_start", async (event) => {
						if (event.message.role === "assistant") await new Promise((resolve) => setTimeout(resolve, 25));
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first reply")]);
		await harness.session.prompt("Produce a brief reply");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("usage", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("reported"),
		]);
		await harness.session.prompt("Show usage");
		const usage = JSON.parse(resultText(harness, "usage")[0]);
		expect(usage.main.durationMs).toBeGreaterThanOrEqual(25);
	});

	it("reports invalid TODO input as an error and does not create a Goal without user approval", async () => {
		const harness = await create(dataDirectory());
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("todo", { action: "edit", id: "missing", title: "no item" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("goal", { op: "create", objective: "Do something" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("goal", { op: "get" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Exercise rejected operations");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.toolName === "todo"),
		).toMatchObject({ isError: true });
		expect(resultText(harness, "goal")[0]).toContain("approval");
		expect(JSON.parse(resultText(harness, "goal")[1])).toEqual({ status: "none" });
	});

	it("starts processing a newly persisted request before the parent agent_end event", async () => {
		const events: string[] = [];
		const requestEntryIds: string[] = [];
		vi.spyOn(modelCalls, "completeHarnessTask").mockImplementation(async (options) => {
			const request = JSON.parse(String(options.context.messages[0]?.content)) as {
				changes: { entryId: string; kind: string }[];
			};
			const requests = request.changes.filter((change) => change.kind === "request");
			requestEntryIds.push(...requests.map((change) => change.entryId));
			for (const change of requests) events.push(`todo:${change.entryId}`);
			return fauxAssistantMessage([fauxToolCall("return_todo_update", { add: [], update: [] })], {
				stopReason: "toolUse",
			});
		});
		const harness = await create(
			dataDirectory(),
			{
				extensionFactories: [
					(pi) => {
						pi.on("message_persisted", async (event) => {
							if (event.message.role !== "user") return;
							events.push(`persisted:${event.entryId}`);
							await vi.waitFor(() => expect(requestEntryIds).toContain(event.entryId));
						});
						pi.on("agent_end", () => {
							events.push("agent_end");
						});
					},
				],
			},
			{ todoDebounceMs: 0 },
		);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("Track this request before answering");

		const userEntry = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userEntry).toBeDefined();
		if (!userEntry) throw new Error("User message was not persisted");
		expect(requestEntryIds).toContain(userEntry.id);
		expect(events.indexOf(`todo:${userEntry.id}`)).toBeLessThan(events.indexOf("agent_end"));
	});

	it("replays pending user and tool results after restoring the saved TODO cursor", async () => {
		const requests: Array<{ changes: Array<{ entryId: string; kind: string }> }> = [];
		let extensionApi: ExtensionAPI | undefined;
		vi.spyOn(modelCalls, "completeHarnessTask").mockImplementation(async (options) => {
			if (options.purpose !== "todo") throw new Error("Unexpected model purpose");
			const request = JSON.parse(String(options.context.messages[0]?.content)) as {
				changes: Array<{ entryId: string; kind: string }>;
			};
			requests.push(request);
			return fauxAssistantMessage(
				[
					fauxToolCall("return_todo_update", {
						add: requests.length === 1 ? [{ title: "Retained TODO fixture" }] : [],
						update: [],
					}),
				],
				{ stopReason: "toolUse" },
			);
		});
		const harness = await create(
			dataDirectory(),
			{
				extensionFactories: [
					(pi) => {
						extensionApi = pi;
					},
				],
			},
			{ todoDebounceMs: 0 },
		);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "previous tool result" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Previous request completed"),
		]);
		await harness.session.prompt("Run the earlier operation");

		const firstBranch = harness.sessionManager.getBranch();
		const oldUser = firstBranch.find((entry) => entry.type === "message" && entry.message.role === "user");
		const oldTool = firstBranch.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "echo",
		);
		expect(oldUser).toBeDefined();
		expect(oldTool).toBeDefined();
		if (!oldUser || !oldTool) throw new Error("Previous request and tool result were not persisted");
		await vi.waitFor(() => {
			const changeIds = requests.flatMap((request) => request.changes.map((change) => change.entryId));
			expect(changeIds).toEqual(expect.arrayContaining([oldUser.id, oldTool.id]));
		});
		await vi.waitFor(() => {
			const hasRetainedTodo = harness.sessionManager.getBranch().some((entry) => {
				if (entry.type !== "custom" || entry.customType !== TODO_SESSION_ENTRY_TYPE) return false;
				const data = entry.data as { items?: Array<{ title?: string }> };
				return data.items?.some((item) => item.title === "Retained TODO fixture") === true;
			});
			expect(hasRetainedTodo).toBe(true);
		});

		const savedTodo = harness.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === TODO_SESSION_ENTRY_TYPE);
		expect(savedTodo).toBeDefined();
		if (!savedTodo || savedTodo.type !== "custom") throw new Error("TODO checkpoint was not persisted");
		if (!extensionApi) throw new Error("Extension API was not initialized");
		extensionApi.appendEntry(TODO_SESSION_ENTRY_TYPE, {
			...(savedTodo.data as Record<string, unknown>),
			processedThroughEntryId: null,
		});
		const restartMarker = harness.sessionManager.getBranch().at(-1);
		if (!restartMarker) throw new Error("Restart marker was not persisted");
		await harness.session.navigateTree(oldTool.id);
		await harness.session.navigateTree(restartMarker.id);

		harness.setResponses([fauxAssistantMessage("Next request completed")]);
		await harness.session.prompt("Continue with a new request");
		const newUser = harness.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "message" && entry.message.role === "user");
		expect(newUser).toBeDefined();
		if (!newUser) throw new Error("New request was not persisted");
		await vi.waitFor(() => {
			const resumedRequest = requests.find((request) =>
				request.changes.some((change) => change.entryId === newUser.id),
			);
			expect(resumedRequest?.changes.map((change) => change.entryId)).toEqual(
				expect.arrayContaining([oldUser.id, oldTool.id, newUser.id]),
			);
		});
	});

	it("keeps input advice tied to raw /skill text and its persisted user entry", async () => {
		const dataDir = dataDirectory();
		const skillPath = join(dataDir, "SKILL.md");
		writeFileSync(skillPath, "# Test skill\n\nUse the skill body.");
		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					{
						name: "test",
						description: "Test skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: dataDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: dataDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const evaluated: JevEvaluationInput[] = [];
		const evaluateJev = async (input: JevEvaluationInput): Promise<JevEvaluationResponse> => {
			evaluated.push(input);
			const answers: JevEvaluationResponse["answers"] = {};
			for (const [id, question] of Object.entries(input.questions)) {
				if (question.type !== "choice") throw new Error("Input advice expects choice questions");
				const choice = Object.keys(question.criteria)[0]!;
				answers[id] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 0.9 };
			}
			return { model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 5 } };
		};
		const extensionsResult = await createTestExtensionsResult(
			[createPersonalHarnessExtension({ dataDir, evaluateJev })],
			dataDir,
		);
		const harnessResourceLoader = { ...resourceLoader, getExtensions: () => extensionsResult };
		const harness = await createHarness({
			resourceLoader: harnessResourceLoader,
			tools: [echo],
			settings: { cacheWarming: "off" },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
		const originalInput = "/skill:test inspect the callback source";

		await harness.session.prompt(originalInput);

		expect(evaluated).toHaveLength(1);
		expect(JSON.stringify(evaluated[0]?.state)).toContain(originalInput);
		expect(JSON.stringify(evaluated[0]?.state)).not.toContain("Use the skill body.");
		expect(JSON.stringify(evaluated[0]?.state)).not.toContain(skillPath);
		const branch = harness.sessionManager.getBranch();
		const userEntry = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userEntry).toBeDefined();
		if (!userEntry || userEntry.type !== "message") throw new Error("Expanded user message was not persisted");
		expect(getMessageText(userEntry.message)).toContain("Use the skill body.");

		await harness.session.prompt("Review the earlier request");

		expect(evaluated).toHaveLength(2);
		const secondState = evaluated[1]?.state as {
			history?: Array<{ user?: { text?: string } }>;
		};
		expect(secondState.history?.some((turn) => turn.user?.text === originalInput)).toBe(true);
		const serializedStates = JSON.stringify(evaluated.map((input) => input.state));
		expect(serializedStates).not.toContain("Use the skill body.");
		expect(serializedStates).not.toContain(skillPath);
		const sourceEntry = branch.find((entry) => entry.type === "custom" && entry.customType === INPUT_SOURCE_ENTRY);
		expect(sourceEntry?.type === "custom" ? sourceEntry.data : undefined).toEqual({
			userEntryId: userEntry.id,
			rawInputText: originalInput,
		});
	});
});
