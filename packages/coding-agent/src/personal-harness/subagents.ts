import { randomUUID } from "node:crypto";
import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type HarnessUsageLedger, reportedModelUsage } from "./usage.ts";

export interface HarnessSubagentRequest {
	task: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
}
export interface HarnessChildSession {
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	getLastAssistantText(): string | undefined;
	subscribe(listener: (event: AgentEvent) => void): () => void;
}
export interface HarnessSubagentResult {
	id: string;
	status: "completed" | "failed" | "cancelled";
	provider: string;
	model: string;
	text: string;
	error?: string;
	durationMs: number;
}
export interface HarnessSubagentInfo {
	id: string;
	status: "queued" | "running" | HarnessSubagentResult["status"];
	provider: string;
	model: string;
}
export interface HarnessSubagentOptions {
	createSession: (request: HarnessSubagentRequest, signal: AbortSignal) => Promise<HarnessChildSession>;
	ledger: HarnessUsageLedger;
	maxParallel?: number;
	onResult?: (result: HarnessSubagentResult, waiting: boolean) => void;
}
interface ChildJob {
	id: string;
	request: HarnessSubagentRequest;
	status: HarnessSubagentInfo["status"];
	controller: AbortController;
	completion: Promise<HarnessSubagentResult>;
	resolve: (result: HarnessSubagentResult) => void;
	session?: HarnessChildSession;
	result?: HarnessSubagentResult;
	waiters: number;
	startedAt: number;
}

/** State inspection and result retrieval never start another model turn. */
export class HarnessSubagents {
	#options: HarnessSubagentOptions;
	#jobs = new Map<string, ChildJob>();
	#queue: ChildJob[] = [];
	#running = 0;
	#closed = false;
	#maxParallel: number;

	constructor(options: HarnessSubagentOptions) {
		const max = options.maxParallel ?? 2;
		if (!Number.isSafeInteger(max) || max < 1) throw new Error("maxParallel must be a positive integer");
		this.#options = options;
		this.#maxParallel = max;
	}

	start(request: HarnessSubagentRequest): HarnessSubagentInfo {
		if (this.#closed) throw new Error("Subagent manager is closed");
		if (!request.task.trim() || !request.provider.trim() || !request.model.trim())
			throw new Error("A task and explicit provider/model are required");
		const deferred = Promise.withResolvers<HarnessSubagentResult>();
		const job: ChildJob = {
			id: randomUUID(),
			request: { ...request },
			status: "queued",
			controller: new AbortController(),
			completion: deferred.promise,
			resolve: deferred.resolve,
			waiters: 0,
			startedAt: performance.now(),
		};
		this.#jobs.set(job.id, job);
		this.#queue.push(job);
		this.#drain();
		return { id: job.id, status: job.status, provider: request.provider, model: request.model };
	}

	list(): HarnessSubagentInfo[] {
		return [...this.#jobs.values()].map((job) => ({
			id: job.id,
			status: job.status,
			provider: job.request.provider,
			model: job.request.model,
		}));
	}

	result(id: string): HarnessSubagentResult | undefined {
		const job = this.#jobs.get(id);
		if (!job) throw new Error("Unknown subagent");
		return job.result ? { ...job.result } : undefined;
	}

	async wait(id: string, signal?: AbortSignal): Promise<HarnessSubagentResult> {
		const job = this.#jobs.get(id);
		if (!job) throw new Error("Unknown subagent");
		signal?.throwIfAborted();
		if (job.result) return { ...job.result };
		job.waiters++;
		const interrupted = Promise.withResolvers<never>();
		const abort = () => interrupted.reject(signal?.reason ?? new Error("Wait aborted"));
		signal?.addEventListener("abort", abort, { once: true });
		try {
			return { ...(await Promise.race([job.completion, interrupted.promise])) };
		} finally {
			job.waiters--;
			signal?.removeEventListener("abort", abort);
		}
	}

	async cancel(id: string): Promise<void> {
		const job = this.#jobs.get(id);
		if (!job) throw new Error("Unknown subagent");
		if (job.result) return;
		job.controller.abort(new Error("Subagent cancelled"));
		if (job.status === "queued") this.#finish(job, "cancelled", "");
		else if (job.session) await job.session.abort();
	}

	restore(results: readonly HarnessSubagentResult[]): void {
		for (const result of results) {
			if (this.#jobs.has(result.id)) continue;
			this.#jobs.set(result.id, {
				id: result.id,
				request: { task: "", provider: result.provider, model: result.model, thinking: "off" },
				status: result.status,
				controller: new AbortController(),
				completion: Promise.resolve(result),
				resolve: () => {},
				result: { ...result },
				waiters: 0,
				startedAt: 0,
			});
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		await this.cancelAll();
	}

	async cancelAll(): Promise<void> {
		const jobs = [...this.#jobs.values()].filter((job) => !job.result);
		await Promise.all(
			jobs.map(async (job) => {
				await this.cancel(job.id);
				await job.completion;
			}),
		);
	}

	#drain(): void {
		while (!this.#closed && this.#running < this.#maxParallel && this.#queue.length > 0) {
			const job = this.#queue.shift()!;
			if (job.result || job.controller.signal.aborted) continue;
			this.#running++;
			job.status = "running";
			void this.#run(job).finally(() => {
				this.#running--;
				this.#drain();
			});
		}
	}

	async #run(job: ChildJob): Promise<void> {
		let unsubscribe: (() => void) | undefined;
		let lastError: string | undefined;
		let turnStarted = performance.now();
		let status: HarnessSubagentResult["status"] = "completed";
		let text = "";
		let errorMessage: string | undefined;
		try {
			job.session = await this.#options.createSession(job.request, job.controller.signal);
			job.controller.signal.throwIfAborted();
			unsubscribe = job.session.subscribe((event) => {
				if (event.type === "turn_start") turnStarted = performance.now();
				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				const message = event.message;
				const messageStatus =
					message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "success";
				lastError = messageStatus === "success" ? undefined : (message.errorMessage ?? message.stopReason);
				this.#options.ledger.record({
					purpose: "subagent",
					model: `${message.provider}/${message.model}`,
					status: messageStatus,
					usage: reportedModelUsage(message),
					durationMs: performance.now() - turnStarted,
				});
			});
			await job.session.prompt(job.request.task);
			text = job.session.getLastAssistantText() ?? "";
			status = job.controller.signal.aborted ? "cancelled" : lastError ? "failed" : "completed";
			errorMessage = lastError;
		} catch (error) {
			text = job.session?.getLastAssistantText() ?? "";
			status = job.controller.signal.aborted ? "cancelled" : "failed";
			errorMessage = error instanceof Error ? error.message : "Subagent failed";
		} finally {
			unsubscribe?.();
			try {
				await job.session?.dispose();
			} catch (error) {
				status = "failed";
				errorMessage = error instanceof Error ? error.message : "Subagent disposal failed";
			}
		}
		this.#finish(job, status, text, errorMessage);
	}

	#finish(job: ChildJob, status: HarnessSubagentResult["status"], text: string, error?: string): void {
		if (job.result) return;
		job.status = status;
		job.result = {
			id: job.id,
			status,
			provider: job.request.provider,
			model: job.request.model,
			text,
			...(error ? { error } : {}),
			durationMs: performance.now() - job.startedAt,
		};
		job.resolve(job.result);
		this.#options.onResult?.({ ...job.result }, job.waiters > 0);
	}
}
