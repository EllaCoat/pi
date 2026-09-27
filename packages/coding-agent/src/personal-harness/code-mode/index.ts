import { resolve } from "node:path";
import { JavaScriptKernel } from "./javascript-kernel.ts";
import { PythonKernel } from "./python-kernel.ts";
import type {
	CodeModeExecuteOptions,
	CodeModeExecutionResult,
	CodeModeLanguage,
	CodeModeSessionManagerOptions,
	CodeModeSessionOptions,
	CodeModeToolDispatcher,
} from "./types.ts";

export type {
	CodeModeExecuteOptions,
	CodeModeExecutionError,
	CodeModeExecutionResult,
	CodeModeLanguage,
	CodeModeOutput,
	CodeModeOutputType,
	CodeModeSessionManagerOptions,
	CodeModeSessionOptions,
	CodeModeToolDispatcher,
	CodeModeToolExecution,
	CodeModeToolExecutionStatus,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

export class CodeModeSessionManager {
	readonly #dispatcher: CodeModeToolDispatcher;
	readonly #pythonExecutable: string;
	readonly #sessions = new Map<string, CodeModeSession>();
	#closed = false;

	constructor(options: CodeModeSessionManagerOptions) {
		this.#dispatcher = options.dispatcher;
		this.#pythonExecutable = options.pythonExecutable ?? (process.platform === "win32" ? "python" : "python3");
	}

	createSession(id: string, options: CodeModeSessionOptions = {}): CodeModeSession {
		if (this.#closed) throw new Error("Code Mode session manager is shut down");
		if (typeof id !== "string" || id.trim().length === 0)
			throw new TypeError("Code Mode session id must be a non-empty string");
		if (this.#sessions.has(id)) throw new Error(`Code Mode session already exists: ${id}`);
		const cwd = options.cwd ?? process.cwd();
		if (typeof cwd !== "string" || cwd.trim().length === 0)
			throw new TypeError("Code Mode session cwd must be a non-empty string");
		const session = new CodeModeSession(id, this.#dispatcher, this.#pythonExecutable, resolve(cwd), () =>
			this.#sessions.delete(id),
		);
		this.#sessions.set(id, session);
		return session;
	}

	getSession(id: string): CodeModeSession | undefined {
		return this.#sessions.get(id);
	}

	async shutdownSession(id: string): Promise<void> {
		await this.#sessions.get(id)?.shutdown();
	}

	async shutdown(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await Promise.all([...this.#sessions.values()].map((session) => session.shutdown()));
	}
}

export class CodeModeSession {
	readonly #id: string;
	readonly #dispatcher: CodeModeToolDispatcher;
	readonly #pythonExecutable: string;
	readonly #cwd: string;
	readonly #onShutdown: () => void;
	readonly #restarting = new Set<CodeModeLanguage>();
	readonly #kernels: Record<CodeModeLanguage, JavaScriptKernel | PythonKernel | undefined> = {
		javascript: undefined,
		python: undefined,
	};
	#active?: {
		language: CodeModeLanguage;
		controller: AbortController;
		promise: Promise<CodeModeExecutionResult>;
		pauseTimeout: () => () => void;
	};
	#closed = false;
	#lifecycleBusy = false;

	constructor(
		id: string,
		dispatcher: CodeModeToolDispatcher,
		pythonExecutable: string,
		cwd: string,
		onShutdown: () => void,
	) {
		this.#id = id;
		this.#dispatcher = dispatcher;
		this.#pythonExecutable = pythonExecutable;
		this.#cwd = cwd;
		this.#onShutdown = onShutdown;
	}

	async execute(
		language: CodeModeLanguage,
		code: string,
		options: CodeModeExecuteOptions = {},
	): Promise<CodeModeExecutionResult> {
		if (this.#closed) throw new Error(`Code Mode session is shut down: ${this.#id}`);
		if (language !== "javascript" && language !== "python")
			throw new TypeError(`Unsupported Code Mode language: ${String(language)}`);
		if (typeof code !== "string") throw new TypeError("Code Mode cell must be a string");
		if (this.#active) throw new Error(`Code Mode session is already executing a ${this.#active.language} cell`);
		if (this.#restarting.has(language) || this.#lifecycleBusy)
			throw new Error(`Code Mode ${language} kernel is restarting`);

		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
			throw new RangeError("Code Mode timeoutMs must be a positive integer");
		const kernel = this.#getKernel(language);
		const controller = new AbortController();
		const callerSignal = options.signal;
		const abortFromCaller = () => controller.abort(callerSignal?.reason ?? new Error("Code Mode execution aborted"));
		if (callerSignal?.aborted) abortFromCaller();
		else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
		let remainingMs = timeoutMs;
		let deadline = performance.now() + remainingMs;
		let holds = 0;
		let settled = false;
		const onTimeout = () => {
			const error = new Error(`Code Mode cell exceeded ${timeoutMs} ms`);
			error.name = "TimeoutError";
			controller.abort(error);
		};
		let timeout = setTimeout(onTimeout, remainingMs);
		const pauseTimeout = (): (() => void) => {
			if (settled || controller.signal.aborted) return () => {};
			if (holds++ === 0) {
				remainingMs = Math.max(0, deadline - performance.now());
				clearTimeout(timeout);
				if (remainingMs === 0) onTimeout();
			}
			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (--holds === 0 && !settled && !controller.signal.aborted) {
					deadline = performance.now() + remainingMs;
					timeout = setTimeout(onTimeout, remainingMs);
				}
			};
		};

		const promise = kernel.execute(code, controller.signal);
		this.#active = { language, controller, promise, pauseTimeout };
		try {
			return await promise;
		} finally {
			settled = true;
			clearTimeout(timeout);
			callerSignal?.removeEventListener("abort", abortFromCaller);
			if (this.#active?.promise === promise) this.#active = undefined;
		}
	}

	/** Parent reply waits do not consume the cell execution deadline; cancellation remains active. */
	pauseTimeout(): () => void {
		return this.#active?.pauseTimeout() ?? (() => {});
	}

	async restart(language?: CodeModeLanguage): Promise<void> {
		if (this.#closed) throw new Error(`Code Mode session is shut down: ${this.#id}`);
		if (this.#lifecycleBusy || this.#restarting.size > 0)
			throw new Error(`Code Mode session lifecycle operation is already running: ${this.#id}`);
		const languages: CodeModeLanguage[] = language ? [language] : ["javascript", "python"];
		this.#lifecycleBusy = !language;
		for (const current of languages) this.#restarting.add(current);
		try {
			const active = this.#active;
			if (active && languages.includes(active.language)) {
				const error = new Error(`Code Mode ${active.language} kernel restarted`);
				error.name = "AbortError";
				active.controller.abort(error);
				await active.promise;
			}
			await Promise.all(
				languages.map(async (current) => {
					await this.#kernels[current]?.restart();
					this.#kernels[current] = undefined;
				}),
			);
		} finally {
			for (const current of languages) this.#restarting.delete(current);
			this.#lifecycleBusy = false;
		}
	}

	async shutdown(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const active = this.#active;
		if (active) {
			const error = new Error(`Code Mode session shut down: ${this.#id}`);
			error.name = "AbortError";
			active.controller.abort(error);
			await active.promise;
		}
		await Promise.all([this.#kernels.javascript?.shutdown(), this.#kernels.python?.shutdown()]);
		this.#kernels.javascript = undefined;
		this.#kernels.python = undefined;
		this.#onShutdown();
	}

	#getKernel(language: CodeModeLanguage): JavaScriptKernel | PythonKernel {
		if (language === "javascript") {
			this.#kernels.javascript ??= new JavaScriptKernel(this.#dispatcher, this.#cwd);
			return this.#kernels.javascript;
		}
		this.#kernels.python ??= new PythonKernel(this.#dispatcher, this.#pythonExecutable, this.#cwd);
		return this.#kernels.python;
	}
}

export function createCodeModeSessionManager(options: CodeModeSessionManagerOptions): CodeModeSessionManager {
	return new CodeModeSessionManager(options);
}
