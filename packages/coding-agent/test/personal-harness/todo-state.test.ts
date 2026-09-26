import { describe, expect, it } from "vitest";
import { TodoStateMachine } from "../../src/personal-harness/todo/state.ts";

describe("TodoStateMachine", () => {
	it("keeps stable IDs across snapshots and allows explicit manual statuses", () => {
		const ids = ["todo-a", "todo-b"];
		const state = new TodoStateMachine({
			sessionId: "session-a",
			branchId: "branch-a",
			idFactory: () => ids.shift() ?? "unexpected",
		});
		const added = state.prepareManualChange({ type: "add", title: "  Inspect the result  " });
		expect(added).toBeDefined();
		expect(state.commit(added!)).toBe(true);
		expect(state.snapshot.items[0]).toMatchObject({ id: "todo-a", title: "Inspect the result", status: "pending" });

		const manualDone = state.prepareManualChange({ type: "status", id: "todo-a", status: "done" });
		expect(manualDone).toBeDefined();
		expect(state.commit(manualDone!)).toBe(true);
		expect(state.snapshot.items[0]).toMatchObject({ status: "done", completion: { kind: "manual" } });

		const saved = state.snapshot;
		saved.items[0].title = "mutated caller copy";
		expect(state.snapshot.items[0].title).toBe("Inspect the result");
		const restored = new TodoStateMachine({ sessionId: "session-x", branchId: "branch-x" });
		expect(restored.restore(state.snapshot)).toBe(true);
		expect(restored.snapshot.items[0].id).toBe("todo-a");
		expect(restored.snapshot.generation).toBeGreaterThan(state.snapshot.generation);
	});

	it("applies only successful operation or verification evidence and lets later failure revoke evidence completion", () => {
		const state = new TodoStateMachine({ sessionId: "session-a", branchId: "branch-a", idFactory: () => "todo-a" });
		const added = state.prepareManualChange({ type: "add", title: "Run verification" });
		state.commit(added!);
		const scope = state.scope;

		const childReport = state.prepareEvidence({
			...scope,
			entryId: "child-entry",
			todoId: "todo-a",
			source: "child_report",
			outcome: "success",
		});
		expect(childReport).toBeDefined();
		state.commit(childReport!);
		expect(state.snapshot.items[0].status).toBe("pending");

		const success = state.prepareEvidence({
			...scope,
			entryId: "verification-ok",
			todoId: "todo-a",
			source: "verification",
			outcome: "success",
		});
		expect(success).toBeDefined();
		state.commit(success!);
		expect(state.snapshot.items[0]).toMatchObject({
			status: "done",
			completion: { kind: "evidence", entryId: "verification-ok" },
		});

		const failure = state.prepareEvidence({
			...scope,
			entryId: "verification-failed",
			todoId: "todo-a",
			source: "verification",
			outcome: "failure",
		});
		expect(failure).toBeDefined();
		state.commit(failure!);
		expect(state.snapshot.items[0]).toMatchObject({ status: "in_progress" });
		expect(state.snapshot.items[0].evidenceEntryIds).toEqual([
			"child-entry",
			"verification-ok",
			"verification-failed",
		]);

		const manualDone = state.prepareManualChange({ type: "status", id: "todo-a", status: "done" });
		state.commit(manualDone!);
		const laterFailure = state.prepareEvidence({
			...scope,
			entryId: "later-operation-failed",
			todoId: "todo-a",
			source: "operation",
			outcome: "failure",
		});
		state.commit(laterFailure!);
		expect(state.snapshot.items[0]).toMatchObject({ status: "done", completion: { kind: "manual" } });
	});

	it("completes model updates only from observed operation or verification success evidence", () => {
		const state = new TodoStateMachine({ sessionId: "session-a", branchId: "branch-a", idFactory: () => "todo-a" });
		const added = state.prepareManualChange({ type: "add", title: "Run verification" });
		state.commit(added!);
		const scope = state.scope;
		const staleCapture = state.capture();

		const success = state.prepareEvidence({
			...scope,
			entryId: "verification-ok",
			source: "verification",
			outcome: "success",
		});
		expect(success).toBeDefined();
		state.commit(success!);
		expect(state.snapshot.evidence[0]).not.toHaveProperty("todoId");
		expect(
			state.previewModelUpdate(staleCapture, {
				update: [{ id: "todo-a", status: "done", evidenceEntryIds: ["verification-ok"] }],
			}).kind,
		).toBe("unchanged");

		const childReport = state.prepareEvidence({
			...scope,
			entryId: "child-entry",
			todoId: "todo-a",
			source: "child_report",
			outcome: "success",
		});
		expect(childReport).toBeDefined();
		expect(state.commit(childReport!)).toBe(true);

		const failure = state.prepareEvidence({
			...scope,
			entryId: "verification-failed",
			source: "verification",
			outcome: "failure",
		});
		expect(failure).toBeDefined();
		expect(state.commit(failure!)).toBe(true);

		const capture = state.capture();
		expect(
			state.previewModelUpdate(capture, {
				update: [{ id: "todo-a", status: "done" }],
			}).kind,
		).toBe("unchanged");
		expect(
			state.previewModelUpdate(capture, {
				update: [{ id: "todo-a", status: "done", evidenceEntryIds: ["child-entry"] }],
			}).kind,
		).toBe("unchanged");
		expect(
			state.previewModelUpdate(capture, {
				update: [{ id: "todo-a", status: "done", evidenceEntryIds: ["verification-failed"] }],
			}).kind,
		).toBe("unchanged");

		const completed = state.previewModelUpdate(capture, {
			update: [{ id: "todo-a", status: "done", evidenceEntryIds: ["verification-ok"] }],
		});
		expect(completed.kind).toBe("candidate");
		if (completed.kind !== "candidate") return;
		expect(state.commit(completed.candidate)).toBe(true);
		expect(state.snapshot.items[0]).toMatchObject({
			status: "done",
			evidenceEntryIds: ["child-entry", "verification-ok"],
			completion: { kind: "evidence", entryId: "verification-ok" },
		});

		const restored = new TodoStateMachine({ sessionId: "session-b", branchId: "branch-b" });
		expect(restored.restore(state.snapshot)).toBe(true);
		expect(restored.snapshot.items[0].status).toBe("done");
		const laterFailure = state.prepareEvidence({
			...scope,
			entryId: "later-failure",
			source: "operation",
			outcome: "failure",
		});
		expect(laterFailure).toBeDefined();
		expect(state.commit(laterFailure!)).toBe(true);
		expect(state.snapshot.items[0].status).toBe("done");
		const reopened = state.previewModelUpdate(state.capture(), {
			update: [{ id: "todo-a", status: "done", evidenceEntryIds: ["later-failure"] }],
		});
		expect(reopened.kind).toBe("candidate");
		if (reopened.kind !== "candidate") return;
		expect(state.commit(reopened.candidate)).toBe(true);
		expect(state.snapshot.items[0]).toMatchObject({
			status: "in_progress",
			evidenceEntryIds: ["child-entry", "verification-ok", "later-failure"],
		});
		expect(state.snapshot.items[0]).not.toHaveProperty("completion");
	});

	it("rejects an older success when a later related failure exists but accepts a newer success", () => {
		const state = new TodoStateMachine({ sessionId: "session-a", branchId: "branch-a", idFactory: () => "todo-a" });
		const added = state.prepareManualChange({ type: "add", title: "Run verification" });
		state.commit(added!);
		const scope = state.scope;
		const success = state.prepareEvidence({
			...scope,
			entryId: "verification-ok",
			todoId: "todo-a",
			source: "verification",
			outcome: "success",
		});
		expect(success).toBeDefined();
		state.commit(success!);
		const oldCapture = state.capture();

		const failure = state.prepareEvidence({
			...scope,
			entryId: "verification-failed",
			todoId: "todo-a",
			source: "verification",
			outcome: "failure",
		});
		expect(failure).toBeDefined();
		state.commit(failure!);
		expect(state.snapshot.items[0].status).toBe("in_progress");

		const oldResponse = {
			update: [{ id: "todo-a", status: "done", evidenceEntryIds: ["verification-ok"] }],
		};
		expect(state.previewModelUpdate(oldCapture, oldResponse).kind).toBe("unchanged");
		expect(state.previewModelUpdate(state.capture(), oldResponse).kind).toBe("unchanged");

		const laterSuccess = state.prepareEvidence({
			...scope,
			entryId: "verification-recovered",
			source: "verification",
			outcome: "success",
		});
		expect(laterSuccess).toBeDefined();
		state.commit(laterSuccess!);
		const recovered = state.previewModelUpdate(state.capture(), {
			update: [{ id: "todo-a", status: "done", evidenceEntryIds: ["verification-recovered"] }],
		});
		expect(recovered.kind).toBe("candidate");
		if (recovered.kind !== "candidate") return;
		expect(state.commit(recovered.candidate)).toBe(true);
		expect(state.snapshot.items[0]).toMatchObject({
			status: "done",
			completion: { kind: "evidence", entryId: "verification-recovered" },
		});
	});

	it("rejects stale model versions and never accepts a model-only done status", () => {
		const state = new TodoStateMachine({ sessionId: "session-a", branchId: "branch-a", idFactory: () => "todo-a" });
		const added = state.prepareManualChange({ type: "add", title: "Check output" });
		state.commit(added!);
		const capture = state.capture();

		const done = state.previewModelUpdate(capture, { update: [{ id: "todo-a", status: "done" }] });
		expect(done.kind).toBe("unchanged");
		expect(state.snapshot.items[0].status).toBe("pending");

		state.noteUpdateRequest();
		const stale = state.previewModelUpdate(capture, { update: [{ id: "todo-a", status: "blocked" }] });
		expect(stale.kind).toBe("stale");
		expect(state.snapshot.items[0].status).toBe("pending");
	});

	it.each([undefined, "todo-b"])(
		"handles a new failure associated with %s without guessing a task",
		(failureTodoId) => {
			const ids = ["todo-a", "todo-b"];
			const state = new TodoStateMachine({
				sessionId: "session-a",
				branchId: "branch-a",
				idFactory: () => ids.shift()!,
			});
			state.commit(state.prepareManualChange({ type: "add", title: "First task" })!);
			state.commit(state.prepareManualChange({ type: "add", title: "Second task" })!);
			state.commit(
				state.prepareEvidence({ ...state.scope, entryId: "success", source: "verification", outcome: "success" })!,
			);
			const capture = state.capture();
			state.commit(
				state.prepareEvidence({
					...state.scope,
					entryId: "new-failure",
					source: "verification",
					outcome: "failure",
					...(failureTodoId ? { todoId: failureTodoId } : {}),
				})!,
			);
			const preview = state.previewModelUpdate(capture, {
				update: [{ id: "todo-a", status: "done", evidenceEntryIds: ["success"] }],
			});
			if (failureTodoId === undefined) expect(preview.kind).toBe("unchanged");
			else expect(preview.kind).toBe("candidate");
		},
	);

	it("rejects malformed snapshots without replacing the current session", () => {
		const state = new TodoStateMachine({ sessionId: "session-a", branchId: "branch-a" });
		const before = state.snapshot;
		expect(state.restore({ version: 1, sessionId: "other", branchId: "branch", items: [] })).toBe(false);
		expect(state.snapshot).toEqual(before);
	});
});
