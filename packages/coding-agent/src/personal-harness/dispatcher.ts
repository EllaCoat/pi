import { randomUUID } from "node:crypto";
import type { Agent, AgentContext, AgentTool, AgentToolCall, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";

export interface HarnessToolResult extends AgentToolResult<unknown> {
	isError: boolean;
	toolCallId: string;
}

export interface HarnessToolEvent {
	phase: "start" | "update" | "end";
	call: AgentToolCall;
	result?: AgentToolResult<unknown>;
	isError?: boolean;
}

export interface HarnessToolExecutionOptions {
	signal?: AbortSignal;
	/** Per-call caller context, copied before hooks run to isolate concurrent children. */
	context?: AgentContext;
	assistantMessage?: AssistantMessage;
}

export interface HarnessDispatcherOptions {
	/** Host-owned, permitted tools; hiding a declaration from the model does not revoke it. */
	tools: () => readonly AgentTool[];
	context: () => AgentContext;
	assistantMessage: () => AssistantMessage;
	beforeToolCall?: Agent["beforeToolCall"];
	afterToolCall?: Agent["afterToolCall"];
	onEvent?: (event: HarnessToolEvent) => void;
}

function copyContext(context: AgentContext): AgentContext {
	return {
		messages: [...context.messages],
		...(context.tools === undefined ? {} : { tools: [...context.tools] }),
	};
}

/** Executes the same host tool and hook contracts from persistent code kernels. */
export class HarnessToolDispatcher {
	#options: HarnessDispatcherOptions;
	#defaultSchedule = { barrier: Promise.resolve(), pending: new Set<Promise<void>>() };
	#callerSchedules = new WeakMap<AssistantMessage, { barrier: Promise<void>; pending: Set<Promise<void>> }>();
	#closed = false;

	constructor(options: HarnessDispatcherOptions) {
		this.#options = options;
	}

	list(): Array<{ name: string; description: string; parameters: AgentTool["parameters"] }> {
		return this.#options
			.tools()
			.map(({ name, description, parameters }) => ({ name, description, parameters }))
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	async execute(name: string, input: unknown, options?: HarnessToolExecutionOptions): Promise<HarnessToolResult> {
		const tool = this.#options.tools().find((candidate) => candidate.name === name);
		if (!tool || this.#closed) return this.#error(name, `Tool ${name} is unavailable or not permitted`);
		const callOptions =
			options?.context === undefined ? options : { ...options, context: copyContext(options.context) };
		// Match native per-turn batches without making a parent task.wait block its child.
		let schedule = this.#defaultSchedule;
		if (options?.assistantMessage) {
			schedule = this.#callerSchedules.get(options.assistantMessage) ?? {
				barrier: Promise.resolve(),
				pending: new Set<Promise<void>>(),
			};
			this.#callerSchedules.set(options.assistantMessage, schedule);
		}
		const previous = tool.executionMode === "sequential" ? Promise.all(schedule.pending) : schedule.barrier;
		const gate = Promise.withResolvers<void>();
		schedule.pending.add(gate.promise);
		if (tool.executionMode === "sequential") schedule.barrier = gate.promise;
		try {
			await previous;
			return await this.#execute(tool, input, callOptions);
		} finally {
			schedule.pending.delete(gate.promise);
			gate.resolve();
		}
	}

	close(): void {
		this.#closed = true;
	}

	#error(name: string, message: string, id: string = randomUUID()): HarnessToolResult {
		return { content: [{ type: "text", text: message }], details: { tool: name }, isError: true, toolCallId: id };
	}

	async #execute(tool: AgentTool, input: unknown, options?: HarnessToolExecutionOptions): Promise<HarnessToolResult> {
		const signal = options?.signal;
		const call: AgentToolCall = {
			type: "toolCall",
			id: randomUUID(),
			name: tool.name,
			arguments: input as JsonObject,
		};
		let acceptingUpdates = true;
		this.#options.onEvent?.({ phase: "start", call });
		let result: AgentToolResult<unknown>;
		let isError = false;
		try {
			signal?.throwIfAborted();
			if (this.#closed || !this.#options.tools().includes(tool))
				throw new Error(`Tool ${tool.name} is no longer permitted`);
			const prepared = tool.prepareArguments
				? { ...call, arguments: tool.prepareArguments(call.arguments) as JsonObject }
				: call;
			const args = validateToolArguments(tool, prepared);
			const context = options?.context ?? this.#options.context();
			const assistantMessage = options?.assistantMessage ?? this.#options.assistantMessage();
			const before = await this.#options.beforeToolCall?.(
				{ context, assistantMessage, toolCall: call, args },
				signal,
			);
			signal?.throwIfAborted();
			if (this.#closed || !this.#options.tools().includes(tool))
				throw new Error(`Tool ${tool.name} is no longer permitted`);
			if (before?.block) {
				result = {
					...this.#error(tool.name, before.reason ?? "Tool execution was blocked", call.id),
					terminate: before.terminate,
				};
				isError = true;
			} else {
				try {
					result = await tool.execute(call.id, args, signal, (partial) => {
						if (acceptingUpdates) this.#options.onEvent?.({ phase: "update", call, result: partial });
					});
				} catch (error) {
					result = this.#error(tool.name, error instanceof Error ? error.message : String(error), call.id);
					isError = true;
				}
				acceptingUpdates = false;
				const after = await this.#options.afterToolCall?.(
					{ context, assistantMessage, toolCall: call, args, result, isError },
					signal,
				);
				if (after) {
					result = {
						...result,
						...(after.content !== undefined ? { content: after.content } : {}),
						...(after.details !== undefined ? { details: after.details } : {}),
						...(after.usage !== undefined ? { usage: after.usage } : {}),
						...(after.terminate !== undefined ? { terminate: after.terminate } : {}),
					};
					isError = after.isError ?? isError;
				}
			}
		} catch (error) {
			result = this.#error(tool.name, error instanceof Error ? error.message : String(error), call.id);
			isError = true;
		} finally {
			acceptingUpdates = false;
		}
		this.#options.onEvent?.({ phase: "end", call, result, isError });
		return { ...result, isError, toolCallId: call.id };
	}
}
