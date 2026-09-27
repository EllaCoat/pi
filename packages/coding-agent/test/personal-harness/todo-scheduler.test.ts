import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type TodoModelRequest,
	type TodoSnapshot,
	TodoStateMachine,
	type TodoUiNotification,
	TodoUpdateScheduler,
} from "../../src/personal-harness/todo/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function setup(
	updateModel: (request: TodoModelRequest, signal: AbortSignal) => Promise<unknown>,
	intervals: { checkIntervalMs?: number; modelIntervalMs?: number } = {},
) {
	const state = new TodoStateMachine({ sessionId: "session-a", branchId: "branch-a" });
	const saved: Array<{ snapshot: TodoSnapshot; reason: string }> = [];
	const notices: TodoUiNotification[] = [];
	let nextEntryId = 0;
	const scheduler = new TodoUpdateScheduler({
		state,
		updateModel,
		appendSessionEntry: (snapshot, reason) => {
			saved.push({ snapshot, reason });
			return `todo-entry-${++nextEntryId}`;
		},
		notifyUi: (notification) => notices.push(notification),
		checkIntervalMs: intervals.checkIntervalMs ?? 60,
		modelIntervalMs: intervals.modelIntervalMs ?? 300,
	});
	return { state, scheduler, saved, notices };
}

function request(
	scheduler: TodoUpdateScheduler,
	entryId: string,
	summary = entryId,
	kind: "request" | "tool" = "tool",
) {
	if (kind === "request") scheduler.beginRequest();
	return scheduler.requestUpdate({ scope: scheduler.state.scope, entryId, kind, summary });
}

afterEach(() => {
	vi.useRealTimers();
});

describe("TodoUpdateScheduler", () => {
	it("checks and aggregates deltas every minute, then updates once per fixed five-minute window", async () => {
		vi.useFakeTimers();
		const updateModel = vi.fn(async (input: TodoModelRequest) => ({
			add: [{ title: input.changes.map((change) => change.summary).join(" + ") }],
		}));
		const { state, scheduler, saved } = setup(updateModel, { checkIntervalMs: 60_000, modelIntervalMs: 300_000 });

		expect(request(scheduler, "entry-a", "first change")).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(scheduler.pendingEntryIds).toEqual(["entry-a"]);
		expect(updateModel).not.toHaveBeenCalled();

		expect(request(scheduler, "entry-b", "second change")).toBe(true);
		await vi.advanceTimersByTimeAsync(239_999);
		expect(updateModel).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(updateModel).toHaveBeenCalledTimes(1);
		expect(updateModel.mock.calls[0]?.[0].changes).toEqual([
			{ entryId: "entry-a", kind: "tool", summary: "first change" },
			{ entryId: "entry-b", kind: "tool", summary: "second change" },
		]);
		expect(state.snapshot.items[0]?.title).toBe("first change + second change");
		expect(saved).toHaveLength(1);

		request(scheduler, "entry-c", "third change");
		await vi.advanceTimersByTimeAsync(299_999);
		expect(updateModel).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(updateModel).toHaveBeenCalledTimes(2);
		expect(
			updateModel.mock.calls[1]?.[0].changes.map((change: TodoModelRequest["changes"][number]) => change.entryId),
		).toEqual(["entry-c"]);
		scheduler.shutdown();
	});

	it("does not call the model in an unchanged fixed window", async () => {
		vi.useFakeTimers();
		const updateModel = vi.fn(async () => ({}));
		const { scheduler } = setup(updateModel);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(updateModel).not.toHaveBeenCalled();
		scheduler.shutdown();
	});

	it("does not leave later deltas paused when a user request has no safe summary", async () => {
		vi.useFakeTimers();
		const updateModel = vi.fn(async (input: TodoModelRequest) => ({ changes: input.changes }));
		const { scheduler } = setup(updateModel, { checkIntervalMs: 10, modelIntervalMs: 100 });
		scheduler.beginRequest();
		scheduler.completeRequestWithoutDelta();
		expect(request(scheduler, "tool-entry", "safe tool summary")).toBe(true);
		await vi.advanceTimersByTimeAsync(100);
		expect(updateModel).toHaveBeenCalledOnce();
		expect(updateModel.mock.calls[0]?.[0].changes).toEqual([
			{ entryId: "tool-entry", kind: "tool", summary: "safe tool summary" },
		]);
		scheduler.shutdown();
	});

	it("keeps one model call in flight and leaves newer deltas for the next fixed window", async () => {
		vi.useFakeTimers();
		const first = deferred<unknown>();
		const updateModel = vi
			.fn()
			.mockImplementationOnce(() => first.promise)
			.mockResolvedValueOnce({ add: [{ title: "Next window" }] });
		const { state, scheduler } = setup(updateModel, { checkIntervalMs: 10, modelIntervalMs: 100 });
		request(scheduler, "entry-a", "first window");
		await vi.advanceTimersByTimeAsync(100);
		expect(updateModel).toHaveBeenCalledTimes(1);
		request(scheduler, "entry-b", "arrived during model call", "request");
		expect(updateModel.mock.calls[0]?.[1].aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(100);
		expect(updateModel).toHaveBeenCalledTimes(1);
		expect(new Set(scheduler.pendingEntryIds)).toEqual(new Set(["entry-a", "entry-b"]));

		first.resolve({ add: [{ title: "First window" }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(state.snapshot.items[0]?.title).toBe("First window");
		await vi.advanceTimersByTimeAsync(100);
		expect(updateModel).toHaveBeenCalledTimes(2);
		expect(
			updateModel.mock.calls[1]?.[0].changes.map((change: TodoModelRequest["changes"][number]) => change.entryId),
		).toEqual(["entry-b"]);
		expect(state.snapshot.items.map((item) => item.title)).toEqual(["First window", "Next window"]);
		scheduler.shutdown();
	});

	it("applies manual edits immediately and rejects a background result captured before them", async () => {
		vi.useFakeTimers();
		const pending = deferred<unknown>();
		const updateModel = vi.fn(() => pending.promise);
		const { state, scheduler, saved } = setup(updateModel, { checkIntervalMs: 10, modelIntervalMs: 100 });
		expect(scheduler.addManualTodo("Original title")).toBe(true);
		const id = state.snapshot.items[0]!.id;
		request(scheduler, "tool-result", "work changed");
		await vi.advanceTimersByTimeAsync(100);
		expect(updateModel).toHaveBeenCalledTimes(1);

		expect(scheduler.editManualTodo(id, "Manual correction")).toBe(true);
		expect(state.snapshot.items[0]?.title).toBe("Manual correction");
		expect(saved.at(-1)).toMatchObject({ reason: "manual", snapshot: { items: [{ title: "Manual correction" }] } });
		pending.resolve({ update: [{ id, title: "stale model title", status: "done" }] });
		await vi.advanceTimersByTimeAsync(0);

		expect(state.snapshot.items[0]).toEqual({ id, title: "Manual correction", status: "pending" });
		scheduler.shutdown();
	});

	it("isolates restored scopes from an older model response", async () => {
		vi.useFakeTimers();
		const oldResponse = deferred<unknown>();
		const updateModel = vi
			.fn()
			.mockImplementationOnce(() => oldResponse.promise)
			.mockResolvedValueOnce({});
		const { state, scheduler } = setup(updateModel, { checkIntervalMs: 10, modelIntervalMs: 100 });
		const oldScope = state.scope;
		request(scheduler, "old-entry", "old scope work");
		await vi.advanceTimersByTimeAsync(100);
		const restored = new TodoStateMachine({ sessionId: "session-b", branchId: "branch-b" });
		restored.commit(restored.prepareManualChange({ type: "add", title: "Restored item" })!);
		expect(scheduler.restore(restored.snapshot)).toBe(true);
		expect(
			scheduler.requestUpdate({ scope: oldScope, entryId: "late-old-entry", kind: "tool", summary: "old" }),
		).toBe(false);
		oldResponse.resolve({ add: [{ title: "Old response" }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(state.snapshot.items.map((item) => item.title)).toEqual(["Restored item"]);
		scheduler.shutdown();
	});

	it("validates model output and accepts a done status without a proof ledger at the next window", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const updateModel = vi.fn(async (input: TodoModelRequest) => {
			calls += 1;
			const id = input.currentTodo[0]?.id ?? "missing";
			return calls === 1
				? { update: [{ id, status: "done" as const, evidenceEntryIds: ["old-format"] }] }
				: { update: [{ id, status: "done" as const }] };
		});
		const { state, scheduler, notices } = setup(updateModel, { checkIntervalMs: 10, modelIntervalMs: 100 });
		state.commit(state.prepareManualChange({ type: "add", title: "Use current context" })!);
		const id = state.snapshot.items[0]!.id;
		request(scheduler, "entry-a", "context supports completion");

		await vi.advanceTimersByTimeAsync(100);
		expect(state.snapshot.items[0]?.status).toBe("pending");
		expect(notices.some((notice) => notice.type === "error")).toBe(true);
		await vi.advanceTimersByTimeAsync(100);
		expect(state.snapshot.items[0]).toEqual({ id, title: "Use current context", status: "done" });
		expect(updateModel).toHaveBeenCalledTimes(2);
		scheduler.shutdown();
	});

	it("keeps failed-save deltas visible to the successful shutdown resave", async () => {
		vi.useFakeTimers();
		const state = new TodoStateMachine({ sessionId: "session-a", branchId: "branch-a" });
		const saved: Array<{ reason: string; pendingIds: string[] }> = [];
		let scheduler: TodoUpdateScheduler | undefined;
		let shouldFailModelSave = true;
		scheduler = new TodoUpdateScheduler({
			state,
			updateModel: async () => ({ add: [{ title: "Recovered from failed save" }] }),
			appendSessionEntry: (_snapshot, reason) => {
				saved.push({ reason, pendingIds: [...(scheduler?.pendingEntryIds ?? [])] });
				if (reason === "model" && shouldFailModelSave) {
					shouldFailModelSave = false;
					throw new Error("synthetic save failure");
				}
				return undefined;
			},
			notifyUi: () => {},
			checkIntervalMs: 10,
			modelIntervalMs: 100,
		});
		request(scheduler, "unprocessed-entry", "keep this delta for replay");
		await vi.advanceTimersByTimeAsync(100);
		expect(state.snapshot.items).toEqual([]);
		expect(scheduler.pendingEntryIds).toEqual(["unprocessed-entry"]);

		await scheduler.shutdown();
		expect(saved.at(-1)).toEqual({ reason: "shutdown", pendingIds: ["unprocessed-entry"] });
	});

	it("waits for an aborted update callback to settle during shutdown", async () => {
		vi.useFakeTimers();
		const lateResponse = deferred<unknown>();
		let updateSignal: AbortSignal | undefined;
		let callbackSettled = false;
		const { state, scheduler, saved } = setup(
			async (_request, signal) => {
				updateSignal = signal;
				const response = await lateResponse.promise;
				callbackSettled = true;
				return response;
			},
			{ checkIntervalMs: 10, modelIntervalMs: 100 },
		);
		request(scheduler, "slow-request", "slow work");
		await vi.advanceTimersByTimeAsync(100);
		expect(callbackSettled).toBe(false);

		const shutdown = scheduler.shutdown();
		expect(updateSignal?.aborted).toBe(true);
		let shutdownSettled = false;
		void shutdown.then(() => {
			shutdownSettled = true;
		});
		await Promise.resolve();
		expect(shutdownSettled).toBe(false);

		lateResponse.resolve({ add: [{ title: "late response" }] });
		await shutdown;
		expect(callbackSettled).toBe(true);
		expect(state.snapshot.items).toEqual([]);
		expect(saved.filter(({ reason }) => reason === "model")).toHaveLength(0);
	});
});
