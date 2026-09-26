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
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function setup(updateModel: (request: TodoModelRequest, signal: AbortSignal) => Promise<unknown>) {
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
		debounceMs: 5,
	});
	return { state, scheduler, saved, notices };
}

function request(
	scheduler: TodoUpdateScheduler,
	entryId: string,
	summary = entryId,
	kind: "request" | "tool" = "request",
) {
	if (kind === "request") scheduler.invalidateForNewRequest();
	return scheduler.requestUpdate({ scope: scheduler.state.scope, entryId, kind, summary });
}

afterEach(() => {
	vi.useRealTimers();
});

describe("TodoUpdateScheduler", () => {
	it("consumes the request delta after message-start invalidation without incrementing twice", () => {
		const { state, scheduler } = setup(async () => ({}));
		scheduler.invalidateForNewRequest();
		expect(state.snapshot.requestGeneration).toBe(1);

		expect(
			scheduler.requestUpdate({
				scope: state.scope,
				entryId: "request-entry",
				kind: "request",
				summary: "new user request",
			}),
		).toBe(true);
		expect(state.snapshot.requestGeneration).toBe(1);
		scheduler.shutdown();
	});

	it("keeps queued entries pending while an earlier model result is persisted", async () => {
		vi.useFakeTimers();
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		const capturedPending: string[][] = [];
		const state = new TodoStateMachine({ sessionId: "session-a", branchId: "branch-a" });
		let calls = 0;
		const scheduler = new TodoUpdateScheduler({
			state,
			debounceMs: 5,
			updateModel: () => (++calls === 1 ? first.promise : second.promise),
			appendSessionEntry: () => {
				capturedPending.push([...scheduler.pendingEntryIds]);
			},
			notifyUi: () => {},
		});
		request(scheduler, "entry-a", "first", "tool");
		await vi.advanceTimersByTimeAsync(5);
		request(scheduler, "entry-b", "second", "tool");
		expect(new Set(scheduler.pendingEntryIds)).toEqual(new Set(["entry-a", "entry-b"]));
		first.resolve({ add: [{ title: "First reflected" }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(capturedPending.at(-1)).toEqual(["entry-b"]);
		scheduler.addManualTodo("Manual item");
		expect(capturedPending.at(-1)).toEqual(["entry-b"]);
		scheduler.shutdown();
		second.resolve({});
	});

	it("debounces changes and gives the model only deltas and the current TODO", async () => {
		vi.useFakeTimers();
		const updateModel = vi.fn(async (input: TodoModelRequest) => ({
			add: [{ title: input.changes.map((change) => change.summary).join(" + ") }],
		}));
		const { state, scheduler, saved } = setup(updateModel);

		expect(request(scheduler, "request-1", "first delta")).toBe(true);
		expect(request(scheduler, "request-2", "second delta", "tool")).toBe(true);
		expect(updateModel).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5);

		expect(updateModel).toHaveBeenCalledTimes(1);
		expect(updateModel.mock.calls[0][0]).toEqual({
			changes: [
				{ entryId: "request-1", kind: "request", summary: "first delta" },
				{ entryId: "request-2", kind: "tool", summary: "second delta" },
			],
			currentTodo: [],
			observedEvidence: [],
		});
		expect(state.snapshot.items[0].title).toBe("first delta + second delta");
		expect(saved).toHaveLength(1);
		expect(saved[0].reason).toBe("model");
		scheduler.shutdown();
	});

	it("passes host-observed evidence to the model and accepts only a matching success reference for done", async () => {
		vi.useFakeTimers();
		const updateModel = vi.fn(async (input: TodoModelRequest) => ({
			update: [{ id: input.currentTodo[0].id, status: "done", evidenceEntryIds: ["verified-entry"] }],
		}));
		const { state, scheduler, saved } = setup(updateModel);
		scheduler.addManualTodo("Run checks");
		expect(request(scheduler, "request-entry", "Run the checks")).toBe(true);
		expect(
			scheduler.requestUpdate({
				scope: state.scope,
				entryId: "verified-entry",
				kind: "verification",
				summary: "verification passed",
			}),
		).toBe(true);
		expect(
			scheduler.recordEvidence({
				...state.scope,
				entryId: "verified-entry",
				source: "verification",
				outcome: "success",
			}),
		).toBe(true);
		expect(
			scheduler.recordEvidence({
				...state.scope,
				entryId: "child-entry",
				todoId: state.snapshot.items[0].id,
				source: "child_report",
				outcome: "success",
			}),
		).toBe(true);

		scheduler.flush();
		await vi.advanceTimersByTimeAsync(0);

		expect(updateModel.mock.calls[0][0].observedEvidence).toEqual([
			{ entryId: "verified-entry", source: "verification", outcome: "success", generation: 1 },
		]);
		expect(state.snapshot.items[0]).toMatchObject({
			status: "done",
			evidenceEntryIds: ["child-entry", "verified-entry"],
			completion: { kind: "evidence", entryId: "verified-entry" },
		});
		expect(saved.filter((entry) => entry.reason === "model")).toHaveLength(1);
		scheduler.shutdown();
	});

	it("keeps a captured completion when unrelated task evidence arrives", async () => {
		vi.useFakeTimers();
		const first = deferred<unknown>();
		const updateModel = vi.fn().mockImplementationOnce(() => first.promise);
		const { state, scheduler } = setup(updateModel);
		scheduler.addManualTodo("Task A");
		scheduler.addManualTodo("Task B");
		const taskA = state.snapshot.items[0];
		const taskB = state.snapshot.items[1];
		expect(
			scheduler.recordEvidence({
				...state.scope,
				entryId: "a-success",
				source: "verification",
				outcome: "success",
			}),
		).toBe(true);
		request(scheduler, "request-a", "Complete task A");
		expect(
			scheduler.requestUpdate({
				scope: state.scope,
				entryId: "a-success",
				kind: "verification",
				summary: "Task A verification passed",
			}),
		).toBe(true);
		scheduler.flush();
		expect(updateModel.mock.calls[0][0].observedEvidence).toEqual([
			{ entryId: "a-success", source: "verification", outcome: "success", generation: 1 },
		]);

		expect(
			scheduler.recordEvidence({
				...state.scope,
				entryId: "b-failure",
				todoId: taskB.id,
				source: "verification",
				outcome: "failure",
			}),
		).toBe(true);
		expect(
			scheduler.requestUpdate({
				scope: state.scope,
				entryId: "b-failure",
				kind: "verification",
				summary: "Task B verification failed",
			}),
		).toBe(true);
		first.resolve({ update: [{ id: taskA.id, status: "done", evidenceEntryIds: ["a-success"] }] });
		await vi.advanceTimersByTimeAsync(0);

		expect(state.snapshot.items[0]).toMatchObject({
			status: "done",
			completion: { kind: "evidence", entryId: "a-success" },
		});
		expect(state.snapshot.items[1].status).toBe("pending");
		expect(updateModel).toHaveBeenCalledTimes(1);
		scheduler.shutdown();
	});

	it("applies a one-second response while tool deltas arrive every 100ms without resending old deltas", async () => {
		vi.useFakeTimers();
		const updateModel = vi.fn(async (_input: TodoModelRequest) => {
			if (updateModel.mock.calls.length === 1) {
				await new Promise<void>((resolve) => setTimeout(resolve, 1000));
				return { add: [{ title: "Task captured before the tool stream" }] };
			}
			return {};
		});
		const { state, scheduler } = setup(updateModel);
		request(scheduler, "request-long", "Start the work");
		scheduler.flush();
		expect(updateModel).toHaveBeenCalledTimes(1);

		for (let index = 1; index <= 10; index += 1) {
			await vi.advanceTimersByTimeAsync(100);
			expect(request(scheduler, `tool-${index}`, `tool ${index} completed`, "tool")).toBe(true);
		}
		expect(state.snapshot.items[0].title).toBe("Task captured before the tool stream");
		expect(updateModel).toHaveBeenCalledTimes(1);

		scheduler.flush();
		await vi.advanceTimersByTimeAsync(0);
		expect(updateModel).toHaveBeenCalledTimes(2);
		expect(updateModel.mock.calls[1][0].changes.map((change) => change.entryId)).toEqual(
			Array.from({ length: 10 }, (_unused, index) => `tool-${index + 1}`),
		);
		scheduler.shutdown();
	});

	it("does not apply a done response captured before the evidence generation changes", async () => {
		vi.useFakeTimers();
		const first = deferred<unknown>();
		let todoId = "";
		const updateModel = vi
			.fn()
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(async () => ({
				update: [{ id: todoId, status: "done", evidenceEntryIds: ["verified-entry"] }],
			}));
		const { state, scheduler } = setup(updateModel);
		scheduler.addManualTodo("Run checks");
		todoId = state.snapshot.items[0].id;
		request(scheduler, "verified-entry");
		scheduler.flush();
		expect(updateModel).toHaveBeenCalledTimes(1);

		expect(
			scheduler.recordEvidence({
				...state.scope,
				entryId: "verified-entry",
				source: "verification",
				outcome: "success",
			}),
		).toBe(true);
		expect(
			scheduler.requestUpdate({
				scope: state.scope,
				entryId: "verified-entry",
				kind: "verification",
				summary: "verification passed",
			}),
		).toBe(true);
		first.resolve({ update: [{ id: todoId, status: "done", evidenceEntryIds: ["verified-entry"] }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(state.snapshot.items[0].status).toBe("pending");

		scheduler.flush();
		await vi.advanceTimersByTimeAsync(0);
		expect(updateModel).toHaveBeenCalledTimes(2);
		expect(updateModel.mock.calls[1][0].observedEvidence.map((entry: { entryId: string }) => entry.entryId)).toEqual([
			"verified-entry",
		]);
		expect(state.snapshot.items[0].status).toBe("done");
		scheduler.shutdown();
	});

	it("keeps one model call in flight and requeues both old and new changes after a stale result", async () => {
		vi.useFakeTimers();
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		const updateModel = vi
			.fn()
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise);
		const { state, scheduler } = setup(updateModel);

		request(scheduler, "before");
		scheduler.flush();
		expect(updateModel).toHaveBeenCalledTimes(1);
		expect(request(scheduler, "during", "new request")).toBe(true);
		first.resolve({ add: [{ title: "stale result" }] });
		await vi.advanceTimersByTimeAsync(5);

		expect(state.snapshot.items).toEqual([]);
		expect(updateModel).toHaveBeenCalledTimes(2);
		expect(updateModel.mock.calls[1][0].changes.map((change: { entryId: string }) => change.entryId)).toEqual([
			"before",
			"during",
		]);
		second.resolve({ add: [{ title: "fresh result" }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(state.snapshot.items[0].title).toBe("fresh result");
		scheduler.shutdown();
	});

	it("rejects a response after manual revision without overwriting the user's edit", async () => {
		vi.useFakeTimers();
		const first = deferred<unknown>();
		let calls = 0;
		const updateModel = vi.fn(async (input: TodoModelRequest) => {
			calls += 1;
			if (calls === 1) return first.promise;
			return { update: [{ id: input.currentTodo[0].id, title: input.currentTodo[0].title }] };
		});
		const { state, scheduler } = setup(updateModel);
		scheduler.addManualTodo("User title");
		const id = state.snapshot.items[0].id;
		request(scheduler, "tool-result", "tool completed", "tool");
		scheduler.flush();
		scheduler.editManualTodo(id, "Manual correction");
		first.resolve({ update: [{ id, title: "stale model title" }] });
		await vi.advanceTimersByTimeAsync(5);

		expect(state.snapshot.items[0].title).toBe("Manual correction");
		expect(updateModel).toHaveBeenCalledTimes(2);
		expect(updateModel.mock.calls[1][0].currentTodo[0].title).toBe("Manual correction");
		scheduler.shutdown();
	});

	it("holds session saves through compaction and releases them in finally even when compaction fails", async () => {
		vi.useFakeTimers();
		const updateModel = vi.fn(async () => ({ add: [{ title: "Updated in background" }] }));
		const { state, scheduler, saved } = setup(updateModel);
		const compressionFailure = new Error("compaction stopped");
		const endCompression = deferred<void>();
		const compressed = scheduler.withCompressionHold(async () => {
			request(scheduler, "tool-done", "validated change", "tool");
			scheduler.flush();
			await endCompression.promise;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(state.snapshot.items).toEqual([]);
		expect(saved).toEqual([]);
		endCompression.reject(compressionFailure);
		await expect(compressed).rejects.toBe(compressionFailure);

		expect(state.snapshot.items[0].title).toBe("Updated in background");
		expect(saved.filter((entry) => entry.reason === "model")).toHaveLength(1);
		scheduler.shutdown();
	});

	it("releases an explicit hold once without overwriting a manual edit", async () => {
		vi.useFakeTimers();
		const updateModel = vi.fn(async (input: TodoModelRequest) => ({
			update: [{ id: input.currentTodo[0].id, title: "Model correction" }],
		}));
		const { state, scheduler, saved } = setup(updateModel);
		scheduler.addManualTodo("Original title");
		const id = state.snapshot.items[0].id;
		const release = scheduler.acquireCompressionHold();
		request(scheduler, "tool-result", "operation completed", "tool");
		scheduler.flush();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.snapshot.items[0].title).toBe("Original title");

		scheduler.editManualTodo(id, "Manual correction");
		release();
		release();

		expect(state.snapshot.items[0].title).toBe("Manual correction");
		expect(saved[saved.length - 1]).toMatchObject({
			reason: "retry",
			snapshot: { items: [{ title: "Manual correction" }] },
		});
		scheduler.shutdown();
	});

	it("does not apply a held model result after restoring another TODO snapshot", async () => {
		vi.useFakeTimers();
		const updateModel = vi.fn(async () => ({ add: [{ title: "Old session result" }] }));
		const { state, scheduler } = setup(updateModel);
		const release = scheduler.acquireCompressionHold();
		request(scheduler, "tool-result");
		scheduler.flush();
		await vi.advanceTimersByTimeAsync(0);

		const restored = new TodoStateMachine({ sessionId: "session-b", branchId: "branch-b" });
		const item = restored.prepareManualChange({ type: "add", title: "Restored snapshot item" });
		expect(item).toBeDefined();
		expect(restored.commit(item!)).toBe(true);
		expect(scheduler.restore(restored.snapshot)).toBe(true);
		release();

		expect(state.snapshot.items.map((todo) => todo.title)).toEqual(["Restored snapshot item"]);
		scheduler.shutdown();
	});

	it("retains failed model work for an explicit retry and never forwards raw errors to the UI", async () => {
		vi.useFakeTimers();
		const updateModel = vi
			.fn()
			.mockRejectedValueOnce(new Error("secret-token-must-not-escape"))
			.mockResolvedValueOnce({ add: [{ title: "Recovered" }] });
		const { state, scheduler, notices } = setup(updateModel);
		request(scheduler, "tool-result", "finished the operation", "tool");
		scheduler.flush();
		await vi.advanceTimersByTimeAsync(0);

		expect(state.snapshot.items).toEqual([]);
		expect(notices.some((notice) => notice.type === "error" && notice.message.includes("secret-token"))).toBe(false);
		scheduler.retryPending();
		scheduler.flush();
		await vi.advanceTimersByTimeAsync(0);
		expect(updateModel).toHaveBeenCalledTimes(2);
		expect(state.snapshot.items[0].title).toBe("Recovered");
		scheduler.shutdown();
	});

	it("does not apply an aborted result and cancels old work on restore", async () => {
		vi.useFakeTimers();
		const first = deferred<unknown>();
		const updateModel = vi
			.fn()
			.mockImplementationOnce(() => first.promise)
			.mockResolvedValueOnce({ add: [{ title: "new session item" }] });
		const { state, scheduler, saved } = setup(updateModel);
		const oldScope = state.scope;
		request(scheduler, "old-request");
		scheduler.flush();
		scheduler.abortCurrentUpdate();
		first.resolve({ add: [{ title: "aborted item" }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(state.snapshot.items).toEqual([]);
		expect(saved.filter((entry) => entry.reason === "model")).toHaveLength(0);

		const restored = new TodoStateMachine({ sessionId: "session-b", branchId: "branch-b" });
		expect(scheduler.restore(restored.snapshot)).toBe(true);
		expect(state.scope).toMatchObject({ sessionId: "session-b", branchId: "branch-b" });
		expect(
			scheduler.requestUpdate({
				scope: oldScope,
				entryId: "stale-scope",
				kind: "request",
				summary: "old session event",
			}),
		).toBe(false);
		scheduler.shutdown();
	});

	it("does not let TODO's own session entry trigger another model update", async () => {
		vi.useFakeTimers();
		const updateModel = vi.fn(async () => ({ add: [{ title: "Background item" }] }));
		let scheduler: TodoUpdateScheduler | undefined;
		let appenderCalls = 0;
		const state = new TodoStateMachine({ sessionId: "session-a", branchId: "branch-a" });
		scheduler = new TodoUpdateScheduler({
			state,
			updateModel,
			appendSessionEntry: () => {
				appenderCalls += 1;
				scheduler?.requestUpdate({
					scope: state.scope,
					entryId: `entry-${appenderCalls}`,
					kind: "tool",
					summary: "self generated",
				});
				return `entry-${appenderCalls}`;
			},
			notifyUi: () => {},
			debounceMs: 5,
		});
		request(scheduler, "external-request");
		scheduler.flush();
		await vi.advanceTimersByTimeAsync(0);

		expect(updateModel).toHaveBeenCalledTimes(1);
		expect(appenderCalls).toBe(1);
		expect(
			scheduler.requestUpdate({
				scope: state.scope,
				entryId: "entry-1",
				kind: "tool",
				summary: "late self-generated event",
			}),
		).toBe(false);
		expect(state.snapshot.items[0].title).toBe("Background item");
		scheduler.shutdown();
	});
});
