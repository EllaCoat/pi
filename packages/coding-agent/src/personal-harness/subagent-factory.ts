import { join } from "node:path";
import type { AgentContext, AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	getSupportedThinkingLevels,
	type ImageContent,
	type TextContent,
} from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import type { AgentSession } from "../core/agent-session.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionToolResult,
	ToolDefinition,
} from "../core/extensions/types.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { createAgentSession } from "../core/sdk.ts";
import { SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { CodeModeSessionManager } from "./code-mode/index.ts";
import type { HarnessHookOptions } from "./hooks/index.ts";
import { installHooks } from "./hooks/index.ts";
import { isRecord } from "./hooks/jev-types.ts";
import type { HarnessChildSession, HarnessSubagentCallbacks, HarnessSubagentRequest } from "./subagents.ts";
import { installCodeModeToolSurface } from "./tool-surface.ts";

const CHILD_EVAL_TOOL = "eval";
const CHILD_MESSAGE_TOOL = "message_parent";
const CHILD_EVAL_PARAMETERS = Type.Object({
	language: Type.Union([Type.Literal("javascript"), Type.Literal("python")]),
	code: Type.String({ minLength: 1 }),
});
const CHILD_MESSAGE_PARAMETERS = Type.Object({
	text: Type.String({ minLength: 1 }),
	waitForReply: Type.Optional(Type.Boolean()),
});
const CHILD_ONLY_TOOLS: Record<string, true> = {
	goal: true,
	eval: true,
	memory: true,
	notes: true,
	recall: true,
	task: true,
	todo: true,
	usage: true,
	tool_info: true,
};
const SKILL_TOOLS: Record<string, true> = {
	skill_read: true,
	skill_index: true,
};

export interface PiSubagentSessionFactoryOptions {
	readonly api: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly dataDir: string;
	readonly systemPrompt?: string;
	readonly hookValues?: Omit<Partial<HarnessHookOptions>, "evaluate" | "hold" | "ledger">;
	readonly evaluate: HarnessHookOptions["evaluate"];
	readonly ledger: HarnessHookOptions["ledger"];
}

function assistantText(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const content = message.content;

		if (Array.isArray(content)) {
			const text = content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return undefined;
}

function requireSuccessfulHostTool(name: string, result: ExtensionToolResult): ExtensionToolResult {
	if (!result.isError) return result;
	const message = result.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	throw new Error(message || `Host tool ${name} failed`);
}

function pushOutput(value: unknown, content: Array<TextContent | ImageContent>): void {
	if (Array.isArray(value)) {
		for (const item of value) pushOutput(item, content);
		return;
	}
	if (typeof value === "string") {
		content.push({ type: "text", text: value });
		return;
	}
	if (!isRecord(value)) {
		content.push({ type: "text", text: String(value) });
		return;
	}
	if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
		content.push({ type: "image", data: value.data, mimeType: value.mimeType });
	} else if (value.type === "text" && typeof value.text === "string") {
		content.push({ type: "text", text: value.text });
	} else if (Array.isArray(value.content)) {
		pushOutput(value.content, content);
	} else {
		try {
			content.push({ type: "text", text: JSON.stringify(value) });
		} catch {
			content.push({ type: "text", text: "[Unserializable tool output]" });
		}
	}
}

function codeTool(sessionId: string, codeMode: CodeModeSessionManager, cwd: string): ToolDefinition {
	return {
		name: CHILD_EVAL_TOOL,
		label: "personal eval",
		description:
			"Run persistent JavaScript or Python. Use tool.<name>(args) only for this child's selected host tools; use tool.message_parent({text, waitForReply?}) to report a finding or ask the parent, and tool.tool_info({}) to inspect permitted host tools.",
		promptSnippet: "Run persistent code with the isolated child kernel and approved host tools.",
		parameters: CHILD_EVAL_PARAMETERS,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		execute: async (_toolCallId, params, signal) => {
			const session = codeMode.getSession(sessionId) ?? codeMode.createSession(sessionId, { cwd });
			const input = params as Static<typeof CHILD_EVAL_PARAMETERS>;
			const result = await session.execute(input.language, input.code, { signal });
			const content: Array<TextContent | ImageContent> = [];
			for (const output of result.outputs) {
				const data = output.data;
				if (output.type === "display") pushOutput(data, content);
				else
					content.push({
						type: "text",
						text: `[${output.type}] ${typeof data === "string" ? data : String(data)}`,
					});
			}
			if (result.error)
				content.push({
					type: "text",
					text: `Error: ${result.error.name}: ${result.error.message}${result.error.stack ? `\n${result.error.stack}` : ""}`,
				});
			if (result.interrupted) content.push({ type: "text", text: "Execution interrupted." });
			if (content.length === 0) content.push({ type: "text", text: "(no output)" });
			return {
				content,
				details: {
					error: result.error,
					interrupted: result.interrupted,
					outputCount: result.outputs.length,
					toolExecutions: result.toolExecutions,
					harnessDerivedRecall: result.harnessDerivedRecall,
				},
				isError: Boolean(result.error || result.interrupted),
			};
		},
	};
}

function parentMessageTool(
	callbacks: HarnessSubagentCallbacks,
	signal: AbortSignal,
	pauseTimeout: () => () => void,
): ToolDefinition {
	return {
		name: CHILD_MESSAGE_TOOL,
		label: "message parent",
		description: "Report a finding or ask the parent a question; optionally wait for its reply.",
		parameters: CHILD_MESSAGE_PARAMETERS,
		execute: async (_toolCallId, params, toolSignal) => {
			const input = params as Static<typeof CHILD_MESSAGE_PARAMETERS>;
			const effectiveSignal = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal;
			effectiveSignal.throwIfAborted();
			const release = input.waitForReply ? pauseTimeout() : () => {};
			try {
				const reply = await callbacks.onMessage(input.text, input.waitForReply === true, effectiveSignal);
				return {
					content: [
						{ type: "text", text: reply === undefined ? "Message sent to parent." : `Parent replied: ${reply}` },
					],
					details: { waitingForReply: input.waitForReply === true },
				};
			} finally {
				release();
			}
		},
	};
}

function childHooksFactory(options: PiSubagentSessionFactoryOptions): ExtensionFactory {
	return (api) => {
		installCodeModeToolSurface(api);
		installHooks(api, {
			...options.hookValues,
			evaluate: options.evaluate,
			hold: () => () => {},
			ledger: options.ledger,
		});
		api.on("tool_result", (event) => {
			if (event.toolName !== CHILD_EVAL_TOOL || !isRecord(event.details)) return;
			if (event.details.error !== undefined || event.details.interrupted === true) return { isError: true };
		});
	};
}

export function createPiSubagentSessionFactory(
	options: PiSubagentSessionFactoryOptions,
): (
	request: HarnessSubagentRequest,
	signal: AbortSignal,
	callbacks: HarnessSubagentCallbacks,
) => Promise<HarnessChildSession> {
	return async (request, signal, callbacks) => {
		signal.throwIfAborted();
		const { context, api } = options;
		const model = context.modelRegistry.find(request.provider, request.model);
		if (!model) throw new Error(`Subagent model is unavailable: ${request.provider}/${request.model}`);
		if (!getSupportedThinkingLevels(model).includes(request.thinking))
			throw new Error(`Requested thinking level is unavailable: ${request.thinking}`);
		if (!context.modelRegistry.hasConfiguredAuth(model))
			throw new Error(`Subagent model has no configured authentication: ${request.provider}/${request.model}`);

		const sessionManager = SessionManager.inMemory(context.cwd, {
			parentSession: context.sessionManager.getSessionFile() ?? context.sessionManager.getSessionId(),
		});
		const childAgentDir = join(options.dataDir, "children");
		const settingsManager = SettingsManager.inMemory(
			{ cacheWarming: "off" },
			{ projectTrusted: context.isProjectTrusted() },
		);
		const parentActiveToolNames = new Set(api.getActiveTools());
		const parentTools = new Map(
			api
				.getAllTools()
				.filter((tool) => parentActiveToolNames.has(tool.name))
				.map((tool) => [tool.name, tool] as const),
		);
		const requestedToolNames =
			request.allowedTools ??
			[...parentActiveToolNames].filter(
				(name) => !Object.hasOwn(CHILD_ONLY_TOOLS, name) && !Object.hasOwn(SKILL_TOOLS, name),
			);
		const hostToolNames = new Set<string>();
		for (const name of requestedToolNames) {
			if (!parentActiveToolNames.has(name) || !parentTools.has(name))
				throw new Error(`Requested child tool is unavailable: ${name}`);
			if (Object.hasOwn(CHILD_ONLY_TOOLS, name)) {
				if (name === CHILD_EVAL_TOOL || name === "tool_info") continue;
				throw new Error(`Tool ${name} cannot be delegated to child sessions`);
			}
			if (request.allowedTools === undefined && Object.hasOwn(SKILL_TOOLS, name)) continue;
			hostToolNames.add(name);
		}
		if (request.mcp?.length && !hostToolNames.has("mcp"))
			throw new Error("MCP access requires the mcp tool to be selected for this child");
		for (const access of request.mcp ?? []) {
			if (!access.server.trim() || access.names.some((name) => !name.trim()))
				throw new Error("MCP access requires a server and non-empty tool names");
		}
		if (request.mcp?.length === 0) hostToolNames.delete("mcp");
		const available = [...parentTools.values()].filter((tool) => hostToolNames.has(tool.name));
		let childSession: AgentSession | undefined;
		let childAssistantMessage: AssistantMessage | undefined;
		const currentExecution = (): { context: AgentContext; assistantMessage: AssistantMessage } => {
			const session = childSession;
			const assistantMessage = childAssistantMessage;
			if (!session || !assistantMessage) throw new Error("Child tool execution has no active assistant message");
			return {
				context: {
					messages: session.agent.state.messages.slice(),
					tools: session.agent.state.tools.slice(),
				},
				assistantMessage,
			};
		};
		const assertMcpAccess = (args: unknown): void => {
			if (request.mcp === undefined) return;
			if (!isRecord(args) || typeof args.server !== "string")
				throw new Error("MCP access requires a selected server and tool name");
			const serverAccess = request.mcp.filter((access) => access.server === args.server);
			if (serverAccess.length === 0) throw new Error(`MCP server is not allowed for this child: ${args.server}`);
			if (args.action === "discover") return;
			if (
				args.action === "call" &&
				typeof args.name === "string" &&
				serverAccess.some((access) => access.names.includes(args.name as string))
			)
				return;
			throw new Error(`MCP operation is not allowed for this child: ${args.server}`);
		};
		const mcpSchemas: TSchema[] = [];
		for (const access of request.mcp ?? []) {
			mcpSchemas.push(Type.Object({ action: Type.Literal("discover"), server: Type.Literal(access.server) }));
			if (access.names.length)
				mcpSchemas.push(
					Type.Object({
						action: Type.Literal("call"),
						server: Type.Literal(access.server),
						name: Type.Union(access.names.map((name) => Type.Literal(name))),
						arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
					}),
				);
		}
		const executeHostTool = async (
			name: string,
			args: unknown,
			effectiveSignal: AbortSignal,
		): Promise<ExtensionToolResult> => {
			effectiveSignal.throwIfAborted();
			if (!hostToolNames.has(name) || !api.getActiveTools().includes(name))
				throw new Error(`Tool ${name} is not in the child host-tool allowlist`);
			if (name === "mcp") assertMcpAccess(args);
			const { context: childContext, assistantMessage } = currentExecution();
			const result = await api.executeTool(name, args, {
				signal: effectiveSignal,
				context: childContext,
				assistantMessage,
			});
			if (
				name !== "mcp" ||
				request.mcp === undefined ||
				!isRecord(args) ||
				args.action !== "discover" ||
				result.isError
			)
				return result;
			const text = result.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const discovery: unknown = JSON.parse(text);
			if (!isRecord(discovery) || !Array.isArray(discovery.tools))
				throw new Error("MCP discovery returned an invalid tool index");
			const allowedNames = new Set(
				request.mcp.filter((access) => access.server === args.server).flatMap((access) => [...access.names]),
			);
			const tools = discovery.tools.filter(
				(tool) => isRecord(tool) && typeof tool.name === "string" && allowedNames.has(tool.name),
			);
			return {
				...result,
				content: [{ type: "text", text: JSON.stringify({ server: args.server, tools }) }],
				details: {},
			};
		};
		const customTools: ToolDefinition[] = available.map((tool) => ({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
			parameters: tool.name === "mcp" && request.mcp !== undefined ? Type.Union(mcpSchemas) : tool.parameters,
			execute: async (_toolCallId, params, toolSignal) => {
				const effectiveSignal = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal;
				return requireSuccessfulHostTool(tool.name, await executeHostTool(tool.name, params, effectiveSignal));
			},
		}));

		const codeMode = new CodeModeSessionManager({
			dispatcher: async (name, args, toolSignal) => {
				const effectiveSignal = AbortSignal.any([signal, toolSignal]);
				effectiveSignal.throwIfAborted();
				if (name === "tool_info" || name === CHILD_MESSAGE_TOOL) {
					if (!childSession) throw new Error("Subagent session is not ready");
					return childSession.extensionRunner.createContext().executeTool(name, args, { signal: effectiveSignal });
				}
				return executeHostTool(name, args, effectiveSignal);
			},
		});
		customTools.push(
			parentMessageTool(
				callbacks,
				signal,
				() => codeMode.getSession(sessionManager.getSessionId())?.pauseTimeout() ?? (() => {}),
			),
		);
		customTools.push(codeTool(sessionManager.getSessionId(), codeMode, context.cwd));
		const childFactory = childHooksFactory(options);
		const resourceLoader = new DefaultResourceLoader({
			cwd: context.cwd,
			agentDir: childAgentDir,
			settingsManager,
			systemPrompt: options.systemPrompt,
			appendSystemPrompt: [
				"You are a subagent with an explicitly delegated task. Keep inherited approval boundaries. Do not start Goals or delegate again. Report verified results and remaining uncertainty to the parent.",
			],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: !context.isProjectTrusted(),
			extensionFactories: [{ name: "personal-harness-child-hooks", factory: childFactory }],
		});
		try {
			await resourceLoader.reload();
			const created = await createAgentSession({
				cwd: context.cwd,
				agentDir: childAgentDir,
				modelRuntime: context.modelRegistry.runtime,
				model,
				thinkingLevel: request.thinking,
				noTools: "builtin",
				customTools,
				resourceLoader,
				sessionManager,
				settingsManager,
			});
			childSession = created.session;
		} catch (error) {
			await codeMode.shutdown();
			throw error;
		}

		const session = childSession;
		if (!session) throw new Error("Child session creation returned no session");
		let childAbort: Promise<void> | undefined;
		let disposePromise: Promise<void> | undefined;
		const unsubscribeAssistant = session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				childAssistantMessage = event.message;
			}
		});
		const unsubscribeAbort = (): void => signal.removeEventListener("abort", abortChild);
		const abortChild = (): void => {
			childAbort ??= session.abort();
			void childAbort.catch(() => undefined);
		};
		signal.addEventListener("abort", abortChild, { once: true });
		if (signal.aborted) abortChild();
		return {
			prompt: async (text) => {
				signal.throwIfAborted();
				await session.prompt(text, { expandPromptTemplates: false });
			},
			send: async (text) => {
				signal.throwIfAborted();
				await session.steer(text);
			},
			abort: async () => {
				unsubscribeAbort();
				abortChild();
				await childAbort;
			},
			dispose: () => {
				unsubscribeAbort();
				unsubscribeAssistant();
				disposePromise ??= (async () => {
					try {
						if (childAbort) await childAbort;
					} finally {
						try {
							await session.dispose();
						} finally {
							await codeMode.shutdown();
						}
					}
				})();
				return disposePromise;
			},
			getLastAssistantText: () => assistantText(session.messages),
			subscribe: (listener) =>
				session.subscribe((event) => {
					if (event.type === "turn_start" || event.type === "message_end") listener(event);
				}),
		};
	};
}
