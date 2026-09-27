import { Buffer } from "node:buffer";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { describeToolExecution } from "./tool-execution.ts";
import type {
	CodeModeExecutionError,
	CodeModeExecutionResult,
	CodeModeOutput,
	CodeModeToolDispatcher,
	CodeModeToolExecution,
} from "./types.ts";

const PYTHON_BYTES_KEY = "__pi_code_mode_bytes__";
const PYTHON_BIGINT_KEY = "__pi_code_mode_bigint__";

const PYTHON_BOOTSTRAP = String.raw`
import ast
import asyncio
import base64
import contextlib
import inspect
import io
import json
import queue
import sys
import threading
import traceback

protocol_out = sys.stdout
write_lock = threading.Lock()
input_queue = queue.Queue()
pending_calls = {}
pending_lock = threading.Lock()
next_call_id = 1
active_request_id = None


def json_default(value):
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"__pi_code_mode_bytes__": base64.b64encode(bytes(value)).decode("ascii")}
    raise TypeError("unsupported Code Mode wire value: " + type(value).__name__)


def decode_special(value):
    if set(value) == {"__pi_code_mode_bytes__"}:
        return base64.b64decode(value["__pi_code_mode_bytes__"])
    if set(value) == {"__pi_code_mode_bigint__"}:
        return int(value["__pi_code_mode_bigint__"])
    return value


def write_message(message):
    line = json.dumps(message, default=json_default, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    with write_lock:
        protocol_out.write(line + "\n")
        protocol_out.flush()


def read_input():
    while True:
        line = sys.stdin.readline()
        if not line:
            input_queue.put({"type": "eof"})
            return
        try:
            input_queue.put(json.loads(line, object_hook=decode_special))
        except Exception as error:
            input_queue.put({"type": "protocolError", "message": str(error)})


class ToolBridge:
    def __getattr__(self, name):
        async def call(args=None):
            global next_call_id
            if active_request_id is None:
                raise RuntimeError("tool calls are only available while a cell is running")
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            with pending_lock:
                call_id = str(next_call_id)
                next_call_id += 1
                pending_calls[call_id] = (loop, future)
            write_message({"type": "toolCall", "requestId": active_request_id, "callId": call_id, "name": name, "args": args})
            try:
                return await future
            except asyncio.CancelledError:
                write_message({"type": "toolCancel", "requestId": active_request_id, "callId": call_id})
                raise
            finally:
                with pending_lock:
                    pending_calls.pop(call_id, None)
        return call


def finish_tool_call(message):
    with pending_lock:
        pending = pending_calls.get(message.get("callId"))
    if pending is None:
        return
    loop, future = pending

    def settle():
        if future.done():
            return
        if message.get("type") == "toolResult":
            future.set_result(message.get("result"))
        else:
            details = message.get("error") or {}
            name = details.get("name", "Error")
            text = details.get("message", "Tool call failed")
            error = RuntimeError(text)
            error.name = name
            future.set_exception(error)

    loop.call_soon_threadsafe(settle)


def process_input():
    while True:
        message = input_queue.get()
        if message.get("type") == "eof":
            return
        if message.get("type") in ("toolResult", "toolError"):
            finish_tool_call(message)
        elif message.get("type") == "shutdown":
            return
        else:
            input_queue.task_done()
            command_queue.put(message)
            continue
        input_queue.task_done()


class OutputCapture(io.TextIOBase):
    def __init__(self, output_type):
        self.output_type = output_type

    def write(self, text):
        if text:
            write_message({"type": "output", "requestId": active_request_id, "output": {"type": self.output_type, "data": text}})
        return len(text)

    def flush(self):
        return None


def display(value):
    write_message({"type": "output", "requestId": active_request_id, "output": {"type": "display", "data": value}})


namespace = {"__name__": "__main__", "tool": ToolBridge(), "display": display}
command_queue = queue.Queue()
reader_thread = threading.Thread(target=read_input, daemon=True)
reader_thread.start()
router_thread = threading.Thread(target=process_input, daemon=True)
router_thread.start()
write_message({"type": "ready"})

while True:
    message = command_queue.get()
    if message.get("type") == "shutdown":
        break
    if message.get("type") != "execute" or not isinstance(message.get("requestId"), int) or not isinstance(message.get("code"), str):
        write_message({"type": "fatal", "message": "invalid Code Mode request"})
        continue

    active_request_id = message["requestId"]
    error = None
    result_key = "__pi_code_mode_cell_result__"
    namespace.pop(result_key, None)
    try:
        with contextlib.redirect_stdout(OutputCapture("stdout")), contextlib.redirect_stderr(OutputCapture("stderr")):
            tree = ast.parse(message["code"], filename="code-mode.py", mode="exec")
            has_result = bool(tree.body and isinstance(tree.body[-1], ast.Expr))
            if has_result:
                expression = tree.body[-1]
                tree.body[-1] = ast.Assign(targets=[ast.Name(id=result_key, ctx=ast.Store())], value=expression.value)
            ast.fix_missing_locations(tree)
            compiled = compile(tree, "code-mode.py", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT, dont_inherit=True)
            pending = eval(compiled, namespace, namespace)
            if inspect.isawaitable(pending):
                asyncio.run(pending)
            if has_result:
                write_message({"type": "output", "requestId": active_request_id, "output": {"type": "result", "data": namespace.pop(result_key, None)}})
    except BaseException as exception:
        error = {"name": type(exception).__name__, "message": str(exception), "stack": traceback.format_exc()}
    finally:
        namespace.pop(result_key, None)
        write_message({"type": "completed", "requestId": active_request_id, **({"error": error} if error else {})})
        active_request_id = None
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
	signal: AbortSignal;
}

interface ChildMessage {
	type?: unknown;
	requestId?: unknown;
	output?: unknown;
	callId?: unknown;
	name?: unknown;
	args?: unknown;
	error?: unknown;
	message?: unknown;
}

export class PythonKernel {
	readonly #dispatcher: CodeModeToolDispatcher;
	readonly #executable: string;
	readonly #cwd: string;
	#child?: ChildProcessWithoutNullStreams;
	#ready?: Promise<void>;
	#resolveReady?: () => void;
	#rejectReady?: (error: Error) => void;
	#active?: ActiveCell;
	#stdoutBuffer = "";
	#nextRequestId = 1;
	#stdoutDecoder?: StringDecoder;
	#stderrDecoder?: StringDecoder;
	// Persistent globals can retain recalled content beyond the cell that fetched it.
	#hasDerivedRecall = false;

	constructor(dispatcher: CodeModeToolDispatcher, executable: string, cwd: string) {
		this.#dispatcher = dispatcher;
		this.#executable = executable;
		this.#cwd = cwd;
	}

	async execute(code: string, signal: AbortSignal): Promise<CodeModeExecutionResult> {
		if (this.#active)
			return {
				outputs: [],
				toolExecutions: [],
				harnessDerivedRecall: false,
				error: { name: "KernelBusyError", message: "The Python kernel is already executing a cell" },
			};
		if (signal.aborted) return interruptedResult(signal.reason);

		const { promise: result, resolve } = Promise.withResolvers<CodeModeExecutionResult>();
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
			wake: () => {},
			removeAbortListener: () => {},
			signal,
		};
		this.#active = active;
		const { promise: aborted, resolve: wake } = Promise.withResolvers<void>();
		active.wake = wake;
		const abortListener = () => {
			active.wake();
			void this.#interrupt(active, signal.reason);
		};
		active.removeAbortListener = () => signal.removeEventListener("abort", abortListener);
		signal.addEventListener("abort", abortListener, { once: true });
		if (signal.aborted) abortListener();
		if (active.interrupted) return result;

		try {
			await Promise.race([this.#startProcess(), aborted]);
			if (active.settled || active.interrupted) return result;
			this.#writeMessage({ type: "execute", requestId: active.requestId, code });
		} catch (error) {
			this.#finish(active, { outputs: active.outputs, error: errorDetails(error) });
		}
		return result;
	}

	async restart(): Promise<void> {
		if (this.#active) await this.#interrupt(this.#active, new Error("Python kernel restarted"));
		await this.#stopProcess();
		this.#hasDerivedRecall = false;
	}

	async shutdown(): Promise<void> {
		if (this.#active) await this.#interrupt(this.#active, new Error("Python kernel shut down"));
		const child = this.#child;
		if (!child) return;
		try {
			this.#writeMessage({ type: "shutdown" });
			await terminateChild(child);
		} finally {
			if (this.#child === child) this.#child = undefined;
			this.#ready = undefined;
		}
	}

	#startProcess(): Promise<void> {
		if (this.#child && this.#ready) return this.#ready;
		const child = spawn(this.#executable, ["-u", "-c", PYTHON_BOOTSTRAP], {
			cwd: this.#cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.#child = child;
		this.#stdoutBuffer = "";
		this.#stdoutDecoder = new StringDecoder("utf8");
		this.#stderrDecoder = new StringDecoder("utf8");
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#ready = promise;
		this.#resolveReady = resolve;
		this.#rejectReady = reject;
		child.stdout.on("data", (chunk: Buffer) => this.#handleStdout(child, chunk));
		child.stderr.on("data", (chunk: Buffer) => this.#handleStderr(child, chunk));
		child.stdin.on("error", (error: Error) => this.#handleProcessError(child, error));
		child.on("error", (error: Error) => this.#handleProcessError(child, error));
		child.on("close", (code: number | null, signal: NodeJS.Signals | null) =>
			this.#handleProcessClose(child, code, signal),
		);
		return this.#ready;
	}

	#handleStdout(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
		if (child !== this.#child || !this.#stdoutDecoder) return;
		this.#stdoutBuffer += this.#stdoutDecoder.write(chunk);
		let newline = this.#stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#stdoutBuffer.slice(0, newline);
			this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
			this.#handleLine(child, line);
			newline = this.#stdoutBuffer.indexOf("\n");
		}
	}

	#handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
		let parsed: unknown;
		try {
			parsed = decodePythonWireValue(JSON.parse(line) as unknown);
		} catch (error) {
			this.#handleProcessError(child, new Error(`Invalid Python kernel message: ${errorDetails(error).message}`));
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const message = parsed as ChildMessage;
		if (typeof message.type !== "string") return;
		if (message.type === "ready") {
			this.#resolveReady?.();
			this.#resolveReady = undefined;
			this.#rejectReady = undefined;
			return;
		}
		const active = this.#active;
		if (!active || message.requestId !== active.requestId) return;
		if (message.type === "output" && isOutput(message.output)) {
			active.outputs.push(message.output);
			return;
		}
		if (message.type === "toolCall" && typeof message.callId === "string" && typeof message.name === "string") {
			active.toolExecutions.set(message.callId, {
				name: message.name,
				status: "unknown",
				harnessDerivedRecall: false,
			});
			void this.#dispatchTool(active, child, message.callId, message.name, message.args);
			return;
		}
		if (message.type === "toolCancel" && typeof message.callId === "string") {
			active.toolControllers.get(message.callId)?.abort(new Error("Python tool call was cancelled"));
			return;
		}
		if (message.type === "completed") {
			const workerError = isExecutionError(message.error) ? message.error : undefined;
			this.#finish(active, {
				outputs: active.outputs,
				...(workerError ? { error: workerError } : active.toolErrors[0] ? { error: active.toolErrors[0] } : {}),
			});
			return;
		}
		if (message.type === "fatal") {
			this.#handleProcessError(
				child,
				new Error(typeof message.message === "string" ? message.message : "Python kernel protocol failure"),
			);
		}
	}

	#handleStderr(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
		if (child !== this.#child || !this.#stderrDecoder) return;
		const text = this.#stderrDecoder.write(chunk);
		if (text && this.#active && !this.#active.settled) this.#active.outputs.push({ type: "stderr", data: text });
	}

	async #dispatchTool(
		active: ActiveCell,
		child: ChildProcessWithoutNullStreams,
		callId: string,
		name: string,
		args: unknown,
	): Promise<void> {
		const controller = new AbortController();
		active.toolControllers.set(callId, controller);
		const toolExecution = active.toolExecutions.get(callId);
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
			this.#writeMessage({ type: "toolResult", callId, result: encodePythonWireValue(result) });
		} catch (error) {
			const details = errorDetails(error);
			if (toolExecution && toolExecution.status === "unknown" && !active.settled) {
				toolExecution.status = controller.signal.aborted ? "unknown" : "failure";
			}
			if (!active.interrupted && !active.settled) active.toolErrors.push(details);
			if (!active.settled && this.#child === child)
				this.#writeMessage({ type: "toolError", callId, error: details });
		} finally {
			active.toolControllers.delete(callId);
		}
	}

	#writeMessage(message: unknown): void {
		const child = this.#child;
		if (!child || !child.stdin.writable) throw new Error("Python kernel is not writable");
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	#handleProcessError(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (child !== this.#child) return;
		this.#child = undefined;
		this.#hasDerivedRecall = false;
		this.#rejectReady?.(error);
		this.#resolveReady = undefined;
		this.#rejectReady = undefined;
		const active = this.#active;
		if (active && !active.interrupted) this.#finish(active, { outputs: active.outputs, error: errorDetails(error) });
		void terminateChild(child);
	}

	#handleProcessClose(
		child: ChildProcessWithoutNullStreams,
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		if (child !== this.#child) return;
		const trailingOutput = this.#stdoutDecoder?.end() ?? "";
		this.#stdoutBuffer += trailingOutput;
		if (this.#stdoutBuffer.trim()) this.#handleLine(child, this.#stdoutBuffer.trim());
		const trailingError = this.#stderrDecoder?.end() ?? "";
		if (trailingError && this.#active && !this.#active.settled)
			this.#active.outputs.push({ type: "stderr", data: trailingError });
		this.#child = undefined;
		this.#hasDerivedRecall = false;
		this.#ready = undefined;
		this.#resolveReady = undefined;
		this.#rejectReady = undefined;
		const active = this.#active;
		if (active && !active.interrupted && !active.settled) {
			const detail = signal ? `terminated by ${signal}` : `exited with code ${code ?? "unknown"}`;
			this.#finish(active, {
				outputs: active.outputs,
				error: { name: "PythonProcessExitError", message: `Python kernel ${detail}` },
			});
		}
	}

	#interrupt(active: ActiveCell, reason: unknown): Promise<void> {
		if (active.interruptPromise) return active.interruptPromise;
		if (active.settled) return Promise.resolve();
		active.interrupted = true;
		const details = errorDetails(reason ?? new Error("Code Mode execution interrupted"));
		this.#hasDerivedRecall = false;
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

	async #stopProcess(): Promise<void> {
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

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	child.once("close", () => resolve());
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

function encodePythonWireValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
	if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean")
		return value ?? null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") return { [PYTHON_BIGINT_KEY]: value.toString() };
	if (typeof value === "function" || typeof value === "symbol")
		throw new TypeError(`Python tool values cannot contain ${typeof value}`);
	if (value instanceof Uint8Array)
		return { [PYTHON_BYTES_KEY]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
	if (value instanceof ArrayBuffer) return { [PYTHON_BYTES_KEY]: Buffer.from(value).toString("base64") };
	if (value instanceof Error)
		return { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}) };
	if (typeof value !== "object") return null;
	if (ancestors.has(value)) throw new TypeError("Python tool values cannot contain circular references");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => encodePythonWireValue(item, ancestors));
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, encodePythonWireValue(item, ancestors)]),
		);
	} finally {
		ancestors.delete(value);
	}
}

function decodePythonWireValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => decodePythonWireValue(item));
	if (typeof value !== "object" || value === null) return value;
	if (
		!ArrayBuffer.isView(value) &&
		!(value instanceof ArrayBuffer) &&
		"__pi_code_mode_bytes__" in value &&
		typeof value.__pi_code_mode_bytes__ === "string"
	) {
		return new Uint8Array(Buffer.from(value.__pi_code_mode_bytes__, "base64"));
	}
	if ("__pi_code_mode_bigint__" in value && typeof value.__pi_code_mode_bigint__ === "string")
		return BigInt(value.__pi_code_mode_bigint__);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodePythonWireValue(item)]));
}
