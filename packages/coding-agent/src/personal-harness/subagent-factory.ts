import { join } from "node:path";
import type { AgentContext, AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	getSupportedThinkingLevels,
	type ImageContent,
	type TextContent,
} from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
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
import type { HarnessChildSession, HarnessSubagentRequest } from "./subagents.ts";
import { installCodeModeToolSurface } from "./tool-surface.ts";

const CHILD_EVAL_TOOL = "eval";
const CHILD_EVAL_PARAMETERS = Type.Object({
	language: Type.Union([Type.Literal("javascript"), Type.Literal("python")]),
	code: Type.String({ minLength: 1 }),
});
const CHILD_ONLY_TOOLS: Record<string, true> = {
	goal: true,
	eval: true,
	memory: true,
	recall: true,
	task: true,
	todo: true,
	usage: true,
	tool_info: true,
};

export interface PiSubagentSessionFactoryOptions {
	readonly api: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly dataDir: string;
	readonly inheritedSkillPaths?: readonly string[];
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
			"Run persistent JavaScript or Python and call active parent host tools through tool.<name>(args). Use await tool.tool_info({}) to discover permitted host tools and tool.tool_info({name: 'NAME'}) for a schema.",
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
): (request: HarnessSubagentRequest, signal: AbortSignal) => Promise<HarnessChildSession> {
	return async (request, signal) => {
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
		const hostToolNames = new Set(api.getActiveTools().filter((name) => !Object.hasOwn(CHILD_ONLY_TOOLS, name)));
		const available = api.getAllTools().filter((tool) => hostToolNames.has(tool.name));
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
		const customTools: ToolDefinition[] = available.map((tool) => ({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
			parameters: tool.parameters,
			execute: async (_toolCallId, params, toolSignal) => {
				const effectiveSignal = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal;
				effectiveSignal.throwIfAborted();
				if (!hostToolNames.has(tool.name))
					throw new Error(`Parent host tool is no longer in the child allowlist: ${tool.name}`);
				const { context: childContext, assistantMessage } = currentExecution();
				const result = await api.executeTool(tool.name, params, {
					signal: effectiveSignal,
					context: childContext,
					assistantMessage,
				});
				return requireSuccessfulHostTool(tool.name, result);
			},
		}));
		const codeMode = new CodeModeSessionManager({
			dispatcher: async (name, args, toolSignal) => {
				if (name === "tool_info") {
					if (!childSession) throw new Error("Subagent session is not ready");
					return childSession.extensionRunner
						.createContext()
						.executeTool(name, args, { signal: AbortSignal.any([signal, toolSignal]) });
				}
				if (!hostToolNames.has(name)) throw new Error(`Tool ${name} is not in the child host-tool allowlist`);
				const { context: childContext, assistantMessage } = currentExecution();
				return api.executeTool(name, args, {
					signal: AbortSignal.any([signal, toolSignal]),
					context: childContext,
					assistantMessage,
				});
			},
		});
		customTools.push(codeTool(sessionManager.getSessionId(), codeMode, context.cwd));
		const childFactory = childHooksFactory(options);
		const resourceLoader = new DefaultResourceLoader({
			cwd: context.cwd,
			agentDir: childAgentDir,
			settingsManager,
			systemPrompt: context.getSystemPrompt(),
			appendSystemPrompt: [
				"You are a subagent with an explicitly delegated task. Keep inherited approval boundaries. Do not start Goals or delegate again. Report verified results and remaining uncertainty to the parent.",
			],
			noExtensions: true,
			noSkills: false,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: !context.isProjectTrusted(),
			additionalSkillPaths: [...(options.inheritedSkillPaths ?? [])],
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
