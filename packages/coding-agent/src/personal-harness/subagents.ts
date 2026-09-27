import { randomUUID } from "node:crypto";
import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type ApiEquivalentCostSummary,
	addAssistantApiEquivalentCost,
	emptyApiEquivalentCost,
} from "./api-equivalent-cost.ts";
import { type HarnessUsageLedger, reportedModelUsage } from "./usage.ts";

export interface HarnessSubagentMcpAccess {
	server: string;
	names: readonly string[];
}
export interface HarnessSubagentRequest {
	task: string;
	context?: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	allowedTools?: readonly string[];
	mcp?: readonly HarnessSubagentMcpAccess[];
}
export interface HarnessSubagentCallbacks {
	onMessage: (text: string, waitForReply: boolean, signal: AbortSignal) => Promise<string | undefined>;
}
export interface HarnessChildSession {
	prompt(text: string): Promise<void>;
	send(text: string): Promise<void>;
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
	apiEquivalentCost?: ApiEquivalentCostSummary;
}
export interface HarnessSubagentMessage {
	id: string;
	text: string;
}
export type HarnessSubagentWait =
	| { type: "message"; message: HarnessSubagentMessage }
	| { type: "result"; result: HarnessSubagentResult };
export interface HarnessSubagentInfo {
	id: string;
	status: "queued" | "running" | HarnessSubagentResult["status"];
	provider: string;
	model: string;
}
export interface HarnessSubagentOptions {
	createSession: (
		request: HarnessSubagentRequest,
		signal: AbortSignal,
		callbacks: HarnessSubagentCallbacks,
	) => Promise<HarnessChildSession>;
	ledger: HarnessUsageLedger;
	maxParallel?: number;
	onUsage?: (childId: string, summary: ApiEquivalentCostSummary) => void;
	onMessage?: (message: HarnessSubagentMessage, waiting: boolean) => void;
	onResult?: (result: HarnessSubagentResult, waiting: boolean) => void;
}
interface ChildWaiter {
	resolve: (value: HarnessSubagentWait) => void;
	reject: (reason: unknown) => void;
}
interface ParentReplyWaiter {
	resolve: (text: string) => void;
	reject: (reason: unknown) => void;
	signal: AbortSignal;
	onAbort: () => void;
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
	waiters: ChildWaiter[];
	messages: HarnessSubagentMessage[];
	replyWaiters: ParentReplyWaiter[];
	pendingParentMessages: string[];
	startedAt: number;
	apiEquivalentCost: ApiEquivalentCostSummary;
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
			request: {
				...request,
				...(request.allowedTools === undefined ? {} : { allowedTools: [...request.allowedTools] }),
				...(request.mcp === undefined
					? {}
					: { mcp: request.mcp.map(({ server, names }) => ({ server, names: [...names] })) }),
			},
			status: "queued",
			controller: new AbortController(),
			completion: deferred.promise,
			resolve: deferred.resolve,
			waiters: [],
			messages: [],
			replyWaiters: [],
			pendingParentMessages: [],
			startedAt: performance.now(),
			apiEquivalentCost: emptyApiEquivalentCost(),
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

	async wait(id: string, signal?: AbortSignal): Promise<HarnessSubagentWait> {
		const job = this.#jobs.get(id);
		if (!job) throw new Error("Unknown subagent");
		signal?.throwIfAborted();
		const message = job.messages.shift();
		if (message) return { type: "message", message: { ...message } };
		if (job.result) return { type: "result", result: { ...job.result } };

		const deferred = Promise.withResolvers<HarnessSubagentWait>();
		const waiter: ChildWaiter = { resolve: deferred.resolve, reject: deferred.reject };
		const abort = () => {
			const index = job.waiters.indexOf(waiter);
			if (index !== -1) job.waiters.splice(index, 1);
			deferred.reject(signal?.reason ?? new Error("Wait aborted"));
		};
		job.waiters.push(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try {
			return await deferred.promise;
		} finally {
			const index = job.waiters.indexOf(waiter);
			if (index !== -1) job.waiters.splice(index, 1);
			signal?.removeEventListener("abort", abort);
		}
	}

	async send(id: string, message: string): Promise<void> {
		const job = this.#jobs.get(id);
		if (!job) throw new Error("Unknown subagent");
		if (!message.trim()) throw new Error("A parent message is required");
		if (job.result || job.status !== "running") throw new Error("Subagent is not active");
		const replyWaiter = job.replyWaiters.shift();
		if (replyWaiter) {
			replyWaiter.signal.removeEventListener("abort", replyWaiter.onAbort);
			replyWaiter.resolve(message);
		} else if (job.session) {
			await job.session.send(message);
		} else {
			job.pendingParentMessages.push(message);
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
				waiters: [],
				messages: [],
				replyWaiters: [],
				pendingParentMessages: [],
				startedAt: 0,
				apiEquivalentCost: result.apiEquivalentCost ? { ...result.apiEquivalentCost } : emptyApiEquivalentCost(),
			});
		}
	}

	async close(): Promise<HarnessSubagentResult[]> {
		this.#closed = true;
		return this.cancelAll();
	}

	async cancelAll(): Promise<HarnessSubagentResult[]> {
		const jobs = [...this.#jobs.values()].filter((job) => !job.result);
		await Promise.all(
			jobs.map(async (job) => {
				await this.cancel(job.id);
				await job.completion;
			}),
		);
		return jobs.flatMap((job) =>
			job.result
				? [
						{
							...job.result,
							...(job.result.apiEquivalentCost
								? { apiEquivalentCost: { ...job.result.apiEquivalentCost } }
								: {}),
						},
					]
				: [],
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

	async #receiveMessage(
		job: ChildJob,
		text: string,
		waitForReply: boolean,
		signal: AbortSignal,
	): Promise<string | undefined> {
		signal.throwIfAborted();
		if (job.result || job.status !== "running") throw new Error("Subagent is not active");
		if (!text.trim()) throw new Error("A child message is required");

		let reply: Promise<string> | undefined;
		if (waitForReply) {
			const deferred = Promise.withResolvers<string>();
			let waiter: ParentReplyWaiter;
			const onAbort = () => {
				const index = job.replyWaiters.indexOf(waiter);
				if (index !== -1) job.replyWaiters.splice(index, 1);
				deferred.reject(signal.reason ?? new Error("Parent reply wait aborted"));
			};
			waiter = {
				resolve: deferred.resolve,
				reject: deferred.reject,
				signal,
				onAbort,
			};
			job.replyWaiters.push(waiter);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			reply = deferred.promise;
		}

		const message = { id: job.id, text };
		const waiting = job.waiters.shift();
		if (waiting) waiting.resolve({ type: "message", message });
		else job.messages.push(message);
		this.#options.onMessage?.({ ...message }, waiting !== undefined);
		return reply ? await reply : undefined;
	}

	async #run(job: ChildJob): Promise<void> {
		let unsubscribe: (() => void) | undefined;
		let lastError: string | undefined;
		let turnStarted = performance.now();
		let status: HarnessSubagentResult["status"] = "completed";
		let text = "";
		let errorMessage: string | undefined;
		try {
			job.session = await this.#options.createSession(job.request, job.controller.signal, {
				onMessage: (message, waitForReply, signal) => this.#receiveMessage(job, message, waitForReply, signal),
			});
			job.controller.signal.throwIfAborted();
			unsubscribe = job.session.subscribe((event) => {
				if (event.type === "turn_start") turnStarted = performance.now();
				if (
					event.type !== "message_end" ||
					event.message.role !== "assistant" ||
					job.result ||
					job.status !== "running"
				)
					return;
				const message = event.message;
				const messageStatus =
					message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "success";
				lastError = messageStatus === "success" ? undefined : (message.errorMessage ?? message.stopReason);
				addAssistantApiEquivalentCost(job.apiEquivalentCost, message);
				this.#options.ledger.record({
					purpose: "subagent",
					model: `${message.provider}/${message.model}`,
					status: messageStatus,
					usage: reportedModelUsage(message),
					durationMs: performance.now() - turnStarted,
				});
				this.#options.onUsage?.(job.id, { ...job.apiEquivalentCost });
			});
			for (const message of job.pendingParentMessages.splice(0)) await job.session.send(message);
			const prompt = job.request.context?.trim()
				? `${job.request.task}\n\nContext from the parent:\n${job.request.context}`
				: job.request.task;
			await job.session.prompt(prompt);
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
			apiEquivalentCost: { ...job.apiEquivalentCost },
		};
		const result = { ...job.result };
		const waiting = job.waiters.length > 0;
		for (const waiter of job.waiters.splice(0)) waiter.resolve({ type: "result", result: { ...result } });
		for (const waiter of job.replyWaiters.splice(0)) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new Error("Subagent finished before the parent replied"));
		}
		job.resolve(job.result);
		this.#options.onResult?.(result, waiting);
	}
}
