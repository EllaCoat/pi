import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { HarnessGoalStore } from "../../src/personal-harness/goal.ts";
import {
	type HarnessChildSession,
	type HarnessSubagentResult,
	HarnessSubagents,
} from "../../src/personal-harness/subagents.ts";
import { HarnessUsageLedger, reportedModelUsage } from "../../src/personal-harness/usage.ts";

function child(text: string, pending?: Promise<void>): HarnessChildSession {
	return {
		prompt: async () => {
			if (pending) await pending;
		},
		send: async () => {},
		abort: async () => {},
		dispose: async () => {},
		getLastAssistantText: () => text,
		subscribe: (_listener: (event: AgentEvent) => void) => () => {},
	};
}

async function waitForResult(
	manager: HarnessSubagents,
	id: string,
	signal?: AbortSignal,
): Promise<HarnessSubagentResult> {
	const outcome = await manager.wait(id, signal);
	if (outcome.type !== "result") throw new Error("Expected the child final result");
	return outcome.result;
}
const request = { task: "Inspect a fixture", provider: "fixture", model: "one", thinking: "off" as const };
const usage: Usage = {
	input: 10,
	output: 3,
	cacheRead: 100,
	cacheWrite: 2,
	totalTokens: 115,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

describe("personal harness runtime state", () => {
	it("runs children with separate explicit model requests and does not rerun on result lookup", async () => {
		const factory = vi.fn(async (spec) => child(spec.model));
		const delivered = vi.fn();
		const manager = new HarnessSubagents({
			createSession: factory,
			ledger: new HarnessUsageLedger(),
			onResult: delivered,
		});
		const first = manager.start(request);
		const second = manager.start({ ...request, model: "two" });
		const [one, two] = await Promise.all([waitForResult(manager, first.id), waitForResult(manager, second.id)]);
		expect([one.text, two.text]).toEqual(["one", "two"]);
		expect(manager.list().map((item) => item.status)).toEqual(["completed", "completed"]);
		expect(await waitForResult(manager, first.id)).toEqual(one);
		expect(manager.result(second.id)).toEqual(two);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(delivered).toHaveBeenCalledTimes(2);
		expect(delivered.mock.calls.every((call) => call[1] === true)).toBe(true);
		await manager.close();
	});

	it("delivers a child question once, accepts a direct reply and steering, then returns the final result", async () => {
		const replyReceived = Promise.withResolvers<void>();
		const finishChild = Promise.withResolvers<void>();
		const prompts: string[] = [];
		const replies: string[] = [];
		const sentToChild: string[] = [];
		const notified = vi.fn();
		const delivered = vi.fn();
		const manager = new HarnessSubagents({
			createSession: async (_request, signal, callbacks) => ({
				prompt: async (text) => {
					prompts.push(text);
					const reply = await callbacks.onMessage("Should I inspect the generated output?", true, signal);
					replies.push(reply ?? "");
					replyReceived.resolve();
					await finishChild.promise;
				},
				send: async (text) => {
					sentToChild.push(text);
				},
				abort: async () => finishChild.resolve(),
				dispose: async () => {},
				getLastAssistantText: () => replies[0] ?? "",
				subscribe: () => () => {},
			}),
			ledger: new HarnessUsageLedger(),
			onMessage: notified,
			onResult: delivered,
		});
		const job = manager.start({ ...request, context: "Only compare the generated output with fixture A." });
		const messageWaiting = manager.wait(job.id);
		const message = await messageWaiting;
		expect(message).toEqual({
			type: "message",
			message: { id: job.id, text: "Should I inspect the generated output?" },
		});
		expect(notified).toHaveBeenCalledOnce();
		expect(notified).toHaveBeenCalledWith({ id: job.id, text: "Should I inspect the generated output?" }, true);

		await manager.send(job.id, "Inspect fixture A only.");
		await replyReceived.promise;
		const finalWaiting = manager.wait(job.id);
		await manager.send(job.id, "Keep the comparison short.");
		expect(replies).toEqual(["Inspect fixture A only."]);
		expect(sentToChild).toEqual(["Keep the comparison short."]);
		expect(prompts[0]).toContain("Context from the parent:\nOnly compare the generated output with fixture A.");

		finishChild.resolve();
		const final = await finalWaiting;
		expect(final.type).toBe("result");
		expect(delivered).toHaveBeenCalledOnce();
		expect(delivered.mock.calls[0]?.[1]).toBe(true);
		if (final.type !== "result") throw new Error("Expected the child final result");
		expect(manager.result(job.id)).toEqual(final.result);
		await expect(manager.send(job.id, "Too late")).rejects.toThrow("Subagent is not active");
		await manager.close();
	});

	it("cancels a queued child without starting another session", async () => {
		const pending = Promise.withResolvers<void>();
		const factory = vi.fn(async () => child("first", pending.promise));
		const manager = new HarnessSubagents({
			createSession: factory,
			ledger: new HarnessUsageLedger(),
			maxParallel: 1,
		});
		const first = manager.start(request);
		const queued = manager.start({ ...request, model: "queued" });
		await manager.cancel(queued.id);
		expect((await waitForResult(manager, queued.id)).status).toBe("cancelled");
		pending.resolve();
		expect((await waitForResult(manager, first.id)).status).toBe("completed");
		expect(factory).toHaveBeenCalledTimes(1);
		await manager.close();
	});

	it("interrupts a wait without canceling or restarting the child", async () => {
		const pending = Promise.withResolvers<void>();
		const manager = new HarnessSubagents({
			createSession: async () => child("finished", pending.promise),
			ledger: new HarnessUsageLedger(),
		});
		const job = manager.start(request);
		const controller = new AbortController();
		const waiting = manager.wait(job.id, controller.signal);
		controller.abort(new Error("stop waiting"));
		await expect(waiting).rejects.toThrow("stop waiting");
		expect(manager.list()[0].status).toBe("running");
		pending.resolve();
		expect((await waitForResult(manager, job.id)).text).toBe("finished");
		await manager.close();
	});

	it("cancels all active children, awaits their disposal, and remains reusable", async () => {
		const started = Promise.withResolvers<void>();
		const pending = Promise.withResolvers<void>();
		const disposed = Promise.withResolvers<void>();
		let created = 0;
		const manager = new HarnessSubagents({
			createSession: async () => {
				created++;
				if (created > 1) return child("next");
				return {
					prompt: async () => {
						started.resolve();
						await pending.promise;
					},
					abort: async () => {
						pending.resolve();
					},
					send: async () => {},
					dispose: async () => {
						disposed.resolve();
					},
					getLastAssistantText: () => "cancelled child",
					subscribe: () => () => {},
				};
			},
			ledger: new HarnessUsageLedger(),
		});
		const running = manager.start(request);
		await started.promise;

		await manager.cancelAll();
		await disposed.promise;
		expect(manager.result(running.id)?.status).toBe("cancelled");

		const next = manager.start({ ...request, task: "Continue independently" });
		expect((await waitForResult(manager, next.id)).status).toBe("completed");
		await manager.close();
	});
	it("restores settled results without allocating a model session", async () => {
		const factory = vi.fn(async () => child("unexpected"));
		const manager = new HarnessSubagents({ createSession: factory, ledger: new HarnessUsageLedger() });
		manager.restore([
			{ id: "old", provider: "fixture", model: "one", status: "completed", text: "saved result", durationMs: 5 },
		]);
		expect((await waitForResult(manager, "old")).text).toBe("saved result");
		expect(factory).not.toHaveBeenCalled();
		await manager.close();
	});

	it("records unknown usage separately and never adds reasoning twice", () => {
		const ledger = new HarnessUsageLedger();
		ledger.record({
			purpose: "todo",
			model: "fixture",
			durationMs: 5,
			status: "success",
			usage: { ...usage, reasoning: 2 },
		});
		ledger.record({ purpose: "todo", model: "fixture", durationMs: 6, status: "error" });
		expect(ledger.snapshot().todo).toEqual({
			calls: 2,
			failed: 1,
			unknownUsage: 1,
			unreportedCacheCalls: 0,
			unreportedCostCalls: 0,
			input: 10,
			output: 3,
			cacheRead: 100,
			cacheWrite: 2,
			estimatedUsd: 0.33,
			durationMs: 11,
		});
	});

	it("does not report a failed provider's placeholder zeros as measured free usage", () => {
		const empty: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		expect(reportedModelUsage({ stopReason: "aborted", usage: empty })).toBeUndefined();
		expect(reportedModelUsage({ stopReason: "error", usage: empty })).toBeUndefined();
		expect(reportedModelUsage({ stopReason: "aborted", usage })).toBe(usage);
		expect(reportedModelUsage({ stopReason: "stop", usage: empty })).toBe(empty);
		const ledger = new HarnessUsageLedger();
		ledger.record({
			purpose: "hook",
			model: "jev",
			status: "success",
			durationMs: 2,
			usage,
			cacheUsageReported: false,
			costReported: false,
		});
		expect(ledger.snapshot().hook).toMatchObject({
			input: 10,
			output: 3,
			unreportedCacheCalls: 1,
			unreportedCostCalls: 1,
		});
	});

	it("preserves an unfinished goal, counts only uncached input/write/output and resumes explicitly", () => {
		const persist = vi.fn();
		const goals = new HarnessGoalStore(persist);
		const created = goals.create("Finish the fixture", 12);
		expect(() => goals.create("Replace it")).toThrow("unfinished");
		goals.recordUsage(usage);
		expect(goals.get()).toMatchObject({ status: "budget-limited", tokensUsed: 15 });
		expect(() => goals.transition("active")).toThrow("exhausted");
		goals.setBudget(30);
		expect(goals.transition("active").id).toBe(created.id);
		expect(goals.transition("complete").tokensUsed).toBe(15);
		const restored = new HarnessGoalStore(() => {});
		expect(restored.restore(goals.get())).toBe(true);
		expect(restored.get()).toEqual(goals.get());
		expect(persist).toHaveBeenCalledTimes(5);
	});
});
