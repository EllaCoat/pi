import { type ChildProcess, fork } from "node:child_process";
import { describeToolExecution } from "./tool-execution.ts";
import type {
	CodeModeExecutionError,
	CodeModeExecutionResult,
	CodeModeOutput,
	CodeModeToolDispatcher,
	CodeModeToolExecution,
} from "./types.ts";

const JAVASCRIPT_CHILD_SOURCE = `
const repl = require("node:repl");
const { PassThrough, Writable } = require("node:stream");
const util = require("node:util");

const input = new PassThrough();
const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
const server = repl.start({ input, output, terminal: false, prompt: "", useGlobal: false, ignoreUndefined: true });
const pendingCalls = new Map();
let nextCallId = 1;
let activeRequestId;
let activeToolErrors = [];
let evalFinished = false;
let activeEvalError;
let pendingMessages = 0;
let closing = false;

function errorShape(error) {
  if (error && typeof error === "object") {
    return {
      name: typeof error.name === "string" ? error.name : "Error",
      message: typeof error.message === "string" ? error.message : String(error),
      ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function sendToParent(message, onError) {
  pendingMessages += 1;
  try {
    if (typeof process.send !== "function") throw new Error("Code Mode child has no IPC channel");
    process.send(message, (error) => {
      pendingMessages -= 1;
      if (error && onError) onError(error);
      maybeFinish();
    });
  } catch (error) {
    pendingMessages -= 1;
    if (onError) onError(error);
    maybeFinish();
  }
}

function sendOutput(type, data) {
  sendToParent({ type: "output", requestId: activeRequestId, output: { type, data } }, (error) => {
    activeToolErrors.push({ name: "DataCloneError", message: "Code Mode output could not be transferred: " + errorShape(error).message });
  });
}

function writeText(type, values) {
  sendOutput(type, util.format(...values));
}

const consoleFacade = {
  log(...values) { writeText("stdout", values); },
  info(...values) { writeText("stdout", values); },
  debug(...values) { writeText("stdout", values); },
  warn(...values) { writeText("stderr", values); },
  error(...values) { writeText("stderr", values); },
};

const tool = new Proxy(Object.create(null), {
  get(_target, property) {
    if (typeof property !== "string" || property === "then") return undefined;
    return (...args) => {
      if (args.length > 1) return Promise.reject(new TypeError("tool.<name> accepts one argument object"));
      if (activeRequestId === undefined) return Promise.reject(new Error("tool calls are only available while a cell is running"));
      const callId = String(nextCallId++);
      const deferred = Promise.withResolvers();
      deferred.promise.catch(() => {});
      pendingCalls.set(callId, deferred);
      sendToParent({ type: "toolCall", requestId: activeRequestId, callId, name: property, args: args.length === 0 ? undefined : args[0] }, (error) => {
        pendingCalls.delete(callId);
        activeToolErrors.push({ name: "DataCloneError", message: "Code Mode tool call could not be transferred: " + errorShape(error).message });
        deferred.reject(error);
      });
      return deferred.promise;
    };
  },
});

server.context.tool = tool;
server.context.print = (...values) => writeText("stdout", values);
server.context.display = (value) => sendOutput("display", value);
server.context.console = consoleFacade;

function maybeFinish() {
  if (activeRequestId === undefined || !evalFinished || pendingCalls.size !== 0 || pendingMessages !== 0) return;
  const requestId = activeRequestId;
  const error = activeEvalError || activeToolErrors[0];
  activeRequestId = undefined;
  activeEvalError = undefined;
  activeToolErrors = [];
  evalFinished = false;
  sendToParent({ type: "completed", requestId, ...(error ? { error } : {}) });
}

server._domain.removeAllListeners("error");
server._domain.on("error", (error) => {
  if (activeRequestId === undefined) return;
  activeEvalError = errorShape(error);
  evalFinished = true;
  maybeFinish();
});

function errorFromMessage(message) {
  const error = new Error(message.message);
  error.name = message.name;
  if (typeof message.stack === "string") error.stack = message.stack;
  return error;
}

function closeKernel() {
  if (closing) return;
  closing = true;
  server.close();
  input.destroy();
  output.end();
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "shutdown") {
    closeKernel();
    process.disconnect();
    return;
  }
  if (message.type === "toolResult" || message.type === "toolError") {
    const pending = pendingCalls.get(message.callId);
    if (!pending) return;
    pendingCalls.delete(message.callId);
    if (message.type === "toolResult") pending.resolve(message.result);
    else {
      const error = errorFromMessage(message.error || { name: "Error", message: "Tool call failed" });
      activeToolErrors.push(errorShape(error));
      pending.reject(error);
    }
    maybeFinish();
    return;
  }
  if (message.type !== "execute" || typeof message.requestId !== "number" || typeof message.code !== "string" || activeRequestId !== undefined) return;
  activeRequestId = message.requestId;
  activeToolErrors = [];
  evalFinished = false;
  activeEvalError = undefined;
  server.eval(message.code, server.context, "code-mode.js", (error, result) => {
    if (error) activeEvalError = errorShape(error);
    else if (result !== undefined) sendOutput("result", result);
    evalFinished = true;
    maybeFinish();
  });
});

process.on("disconnect", closeKernel);
sendToParent({ type: "ready" });
`;

interface ActiveCell {
	requestId: number;
	outputs: CodeModeOutput[];
	toolControllers: Map<string, AbortController>;
	toolExecutions: Map<string, CodeModeToolExecution>;
	harnessDerivedRecall: boolean;
	toolErrors: CodeModeExecutionError[];
	resolve: (result: CodeModeExecutionResult) => void;
	settled: boolean;
	interrupted: boolean;
	interruptPromise?: Promise<void>;
	wake: () => void;
	removeAbortListener: () => void;
}

export class JavaScriptKernel {
	readonly #dispatcher: CodeModeToolDispatcher;
	readonly #cwd: string;
	#child?: ChildProcess;
	#ready?: Promise<void>;
	#resolveReady?: () => void;
	#rejectReady?: (error: Error) => void;
	#active?: ActiveCell;
	#nextRequestId = 1;
	// Persistent globals can retain recalled content beyond the cell that fetched it.
	#hasDerivedRecall = false;

	constructor(dispatcher: CodeModeToolDispatcher, cwd: string) {
		this.#dispatcher = dispatcher;
		this.#cwd = cwd;
	}

	async execute(code: string, signal: AbortSignal): Promise<CodeModeExecutionResult> {
		if (this.#active)
			return {
				outputs: [],
				toolExecutions: [],
				harnessDerivedRecall: false,
				error: { name: "KernelBusyError", message: "The JavaScript kernel is already executing a cell" },
			};
		if (signal.aborted) return interruptedResult(signal.reason);

		const { promise: result, resolve } = Promise.withResolvers<CodeModeExecutionResult>();
		const { promise: aborted, resolve: wake } = Promise.withResolvers<void>();
		const active: ActiveCell = {
			requestId: this.#nextRequestId++,
			outputs: [],
			toolControllers: new Map(),
			toolExecutions: new Map(),
			harnessDerivedRecall: this.#hasDerivedRecall,
			toolErrors: [],
			resolve,
			settled: false,
			interrupted: false,
			wake,
			removeAbortListener: () => {},
		};
		this.#active = active;
		const abortListener = () => {
			active.wake();
			void this.#interrupt(active, signal.reason);
		};
		active.removeAbortListener = () => signal.removeEventListener("abort", abortListener);
		signal.addEventListener("abort", abortListener, { once: true });
		if (signal.aborted) abortListener();

		try {
			if (active.interrupted) return result;
			await Promise.race([this.#startChild(), aborted]);
			if (active.settled || active.interrupted) return result;
			const child = this.#child;
			if (!child) throw new Error("JavaScript child stopped before execution");
			await this.#sendMessage(child, { type: "execute", requestId: active.requestId, code });
		} catch (error) {
			const child = this.#child;
			if (child) this.#handleChildError(child, error instanceof Error ? error : new Error(String(error)));
			else this.#finish(active, { outputs: active.outputs, error: errorDetails(error) });
		}
		return result;
	}

	async restart(): Promise<void> {
		if (this.#active) await this.#interrupt(this.#active, new Error("JavaScript kernel restarted"));
		await this.#stopChild();
		this.#hasDerivedRecall = false;
	}

	async shutdown(): Promise<void> {
		if (this.#active) await this.#interrupt(this.#active, new Error("JavaScript kernel shut down"));
		const child = this.#child;
		if (!child) return;
		try {
			await this.#sendMessage(child, { type: "shutdown" });
		} catch {
			// The forced close below also handles a child that has already disconnected.
		}
		try {
			await terminateChild(child);
		} finally {
			if (this.#child === child) this.#child = undefined;
			this.#ready = undefined;
		}
	}

	#startChild(): Promise<void> {
		if (this.#child && this.#ready) return this.#ready;
		const child = fork("-e", [JAVASCRIPT_CHILD_SOURCE], {
			cwd: this.#cwd,
			execArgv: [],
			serialization: "advanced",
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#child = child;
		this.#ready = promise;
		this.#resolveReady = resolve;
		this.#rejectReady = reject;
		child.on("message", (message: unknown) => this.#handleMessage(child, message));
		child.on("error", (error: Error) => this.#handleChildError(child, error));
		child.on("close", (code: number | null, signal: NodeJS.Signals | null) =>
			this.#handleChildClose(child, code, signal),
		);
		return promise;
	}

	#handleMessage(child: ChildProcess, message: unknown): void {
		if (
			child !== this.#child ||
			typeof message !== "object" ||
			message === null ||
			!("type" in message) ||
			typeof message.type !== "string"
		)
			return;
		if (message.type === "ready") {
			this.#resolveReady?.();
			this.#resolveReady = undefined;
			this.#rejectReady = undefined;
			return;
		}
		const active = this.#active;
		if (!active || !("requestId" in message) || message.requestId !== active.requestId) return;
		if (message.type === "output" && "output" in message && isOutput(message.output)) {
			active.outputs.push(message.output);
			return;
		}
		if (
			message.type === "toolCall" &&
			"callId" in message &&
			"name" in message &&
			typeof message.callId === "string" &&
			typeof message.name === "string"
		) {
			active.toolExecutions.set(message.callId, {
				name: message.name,
				status: "unknown",
				harnessDerivedRecall: false,
			});
			void this.#dispatchTool(
				active,
				child,
				message.callId,
				message.name,
				"args" in message ? message.args : undefined,
			);
			return;
		}
		if (message.type === "completed") {
			const childError = "error" in message && isExecutionError(message.error) ? message.error : undefined;
			this.#finish(active, {
				outputs: active.outputs,
				...(childError ? { error: childError } : active.toolErrors[0] ? { error: active.toolErrors[0] } : {}),
			});
		}
	}

	async #dispatchTool(
		active: ActiveCell,
		child: ChildProcess,
		callId: string,
		name: string,
		args: unknown,
	): Promise<void> {
		const controller = new AbortController();
		active.toolControllers.set(callId, controller);
		const toolExecution = active.toolExecutions.get(callId);
		let executionRecorded = false;
		try {
			const result = await this.#dispatcher(name, args, controller.signal);
			if (active.settled || this.#child !== child) return;
			const execution = describeToolExecution(name, args, result);
			if (toolExecution) {
				toolExecution.status = execution.status;
				toolExecution.harnessDerivedRecall = execution.harnessDerivedRecall;
			}
			if (execution.harnessDerivedRecall) {
				active.harnessDerivedRecall = true;
				this.#hasDerivedRecall = true;
			}
			executionRecorded = true;
			await this.#sendMessage(child, { type: "toolResult", callId, result });
		} catch (error) {
			const details = errorDetails(error);
			if (toolExecution && !executionRecorded && !active.settled) {
				toolExecution.status = controller.signal.aborted ? "unknown" : "failure";
			}
			if (!active.interrupted && !active.settled) active.toolErrors.push(details);
			if (!active.settled && this.#child === child) {
				try {
					await this.#sendMessage(child, { type: "toolError", callId, error: details });
				} catch (sendError) {
					active.toolErrors.push({
						name: "DataCloneError",
						message: `Tool error could not be transferred to JavaScript child: ${errorDetails(sendError).message}`,
					});
					this.#handleChildError(child, sendError instanceof Error ? sendError : new Error(String(sendError)));
				}
			}
		} finally {
			active.toolControllers.delete(callId);
		}
	}

	#sendMessage(child: ChildProcess, message: object): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			try {
				child.send(message, (error) => (error ? reject(error) : resolve()));
			} catch (error) {
				reject(error);
			}
		});
	}

	#handleChildError(child: ChildProcess, error: Error): void {
		if (child !== this.#child) return;
		this.#rejectReady?.(error);
		this.#resolveReady = undefined;
		this.#rejectReady = undefined;
		const active = this.#active;
		if (active && !active.interrupted) this.#finish(active, { outputs: active.outputs, error: errorDetails(error) });
		void terminateChild(child);
	}

	#handleChildClose(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (child !== this.#child) return;
		this.#child = undefined;
		this.#hasDerivedRecall = false;
		this.#ready = undefined;
		this.#resolveReady = undefined;
		this.#rejectReady?.(new Error(`JavaScript child exited before readiness (${signal ?? code ?? "unknown"})`));
		this.#rejectReady = undefined;
		const active = this.#active;
		if (active && !active.interrupted && !active.settled) {
			const detail = signal ? `terminated by ${signal}` : `exited with code ${code ?? "unknown"}`;
			this.#finish(active, {
				outputs: active.outputs,
				error: { name: "JavaScriptProcessExitError", message: `JavaScript child ${detail}` },
			});
		}
	}

	#interrupt(active: ActiveCell, reason: unknown): Promise<void> {
		if (active.interruptPromise) return active.interruptPromise;
		if (active.settled) return Promise.resolve();
		active.interrupted = true;
		this.#hasDerivedRecall = false;
		const details = errorDetails(reason ?? new Error("Code Mode execution interrupted"));
		for (const controller of active.toolControllers.values()) controller.abort(details);
		const child = this.#child;
		if (child) {
			this.#child = undefined;
			this.#ready = undefined;
			this.#resolveReady = undefined;
			this.#rejectReady = undefined;
		}
		const stopping = child ? terminateChild(child) : Promise.resolve();
		active.interruptPromise = stopping.then(() => {
			this.#finish(active, { outputs: active.outputs, error: details, interrupted: true });
		});
		return active.interruptPromise;
	}

	async #stopChild(): Promise<void> {
		const child = this.#child;
		if (!child) return;
		this.#child = undefined;
		this.#ready = undefined;
		this.#resolveReady = undefined;
		this.#rejectReady = undefined;
		await terminateChild(child);
	}

	#finish(active: ActiveCell, result: Omit<CodeModeExecutionResult, "toolExecutions" | "harnessDerivedRecall">): void {
		if (active.settled) return;
		active.settled = true;
		active.removeAbortListener();
		if (this.#active === active) this.#active = undefined;
		active.resolve({
			...result,
			toolExecutions: [...active.toolExecutions.values()].map((execution) => ({ ...execution })),
			harnessDerivedRecall: active.harnessDerivedRecall,
		});
	}
}

async function terminateChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	child.once("close", resolve);
	child.kill("SIGKILL");
	await promise;
}

function isOutput(value: unknown): value is CodeModeOutput {
	if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string")
		return false;
	return value.type === "stdout" || value.type === "stderr" || value.type === "display" || value.type === "result";
}

function isExecutionError(value: unknown): value is CodeModeExecutionError {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		"message" in value &&
		typeof value.name === "string" &&
		typeof value.message === "string"
	);
}

function errorDetails(error: unknown): CodeModeExecutionError {
	if (error instanceof Error) {
		return {
			name: error.name || "Error",
			message: error.message,
			...(error.stack ? { stack: error.stack } : {}),
		};
	}
	return { name: "Error", message: String(error) };
}

function interruptedResult(reason: unknown): CodeModeExecutionResult {
	return {
		outputs: [],
		toolExecutions: [],
		harnessDerivedRecall: false,
		error: errorDetails(reason ?? new Error("Code Mode execution interrupted")),
		interrupted: true,
	};
}
