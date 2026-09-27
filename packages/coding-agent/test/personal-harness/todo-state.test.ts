import { describe, expect, it } from "vitest";
import { TodoStateMachine } from "../../src/personal-harness/todo/state.ts";

describe("TodoStateMachine", () => {
	it("keeps manual changes isolated from returned snapshots and supports every status", () => {
		const state = new TodoStateMachine({
			sessionId: "session-a",
			branchId: "branch-a",
			idFactory: () => "todo-a",
		});
		const added = state.prepareManualChange({ type: "add", title: "  Inspect the result  " });
		expect(added).toBeDefined();
		expect(state.commit(added!)).toBe(true);

		const snapshot = state.snapshot;
		snapshot.items[0]!.title = "mutated caller copy";
		expect(state.snapshot.items[0]?.title).toBe("Inspect the result");

		const manualDone = state.prepareManualChange({ type: "status", id: "todo-a", status: "done" });
		expect(manualDone).toBeDefined();
		expect(state.commit(manualDone!)).toBe(true);
		expect(state.snapshot.items[0]).toEqual({ id: "todo-a", title: "Inspect the result", status: "done" });
		expect(state.snapshot).not.toHaveProperty("evidence");
	});

	it("accepts a reasonable model completion without evidence IDs", () => {
		const state = new TodoStateMachine({
			sessionId: "session-a",
			branchId: "branch-a",
			idFactory: () => "todo-a",
		});
		state.commit(state.prepareManualChange({ type: "add", title: "Run verification" })!);

		const preview = state.previewModelUpdate(state.capture(), {
			update: [{ id: "todo-a", status: "done" }],
		});
		expect(preview.kind).toBe("candidate");
		if (preview.kind !== "candidate") return;
		expect(state.commit(preview.candidate)).toBe(true);
		expect(state.snapshot.items[0]?.status).toBe("done");
		expect(state.snapshot.items[0]).not.toHaveProperty("completion");
	});

	it("rejects stale model responses after a manual edit", () => {
		const state = new TodoStateMachine({
			sessionId: "session-a",
			branchId: "branch-a",
			idFactory: () => "todo-a",
		});
		state.commit(state.prepareManualChange({ type: "add", title: "Original title" })!);
		const beforeEdit = state.capture();
		state.commit(state.prepareManualChange({ type: "edit", id: "todo-a", title: "Manual correction" })!);
		expect(
			state.previewModelUpdate(beforeEdit, { update: [{ id: "todo-a", title: "stale model title" }] }).kind,
		).toBe("stale");
		expect(state.snapshot.items[0]?.title).toBe("Manual correction");
	});

	it("rejects malformed updates without accepting legacy evidence fields", () => {
		const state = new TodoStateMachine({ sessionId: "session-a", branchId: "branch-a" });
		const capture = state.capture();
		expect(
			state.previewModelUpdate(capture, { update: [{ id: "missing", status: "done", evidenceEntryIds: [] }] }).kind,
		).toBe("invalid");
		expect(state.previewModelUpdate(capture, { update: [{ id: "missing", status: "finished" }] }).kind).toBe(
			"invalid",
		);
		expect(state.snapshot.items).toEqual([]);
	});

	it("restores saved version-1 TODO statuses while discarding the obsolete evidence ledger", () => {
		const restored = new TodoStateMachine({ sessionId: "session-x", branchId: "branch-x" });
		const legacySnapshot = {
			version: 1,
			sessionId: "session-a",
			branchId: "branch-a",
			generation: 3,
			revision: 7,
			manualRevision: 4,
			requestGeneration: 2,
			evidenceGeneration: 1,
			items: [
				{
					id: "todo-a",
					title: "Previously completed task",
					status: "done",
					evidenceEntryIds: ["verification-entry"],
					completion: { kind: "evidence", entryId: "verification-entry" },
				},
			],
			evidence: [
				{
					entryId: "verification-entry",
					source: "verification",
					outcome: "success",
					generation: 1,
				},
			],
		};

		expect(restored.restore(legacySnapshot)).toBe(true);
		expect(restored.snapshot.items).toEqual([{ id: "todo-a", title: "Previously completed task", status: "done" }]);
		expect(restored.snapshot.generation).toBeGreaterThan(3);
		expect(restored.snapshot).not.toHaveProperty("evidence");
	});

	it("rejects malformed snapshots without replacing the current session", () => {
		const state = new TodoStateMachine({ sessionId: "session-a", branchId: "branch-a" });
		const before = state.snapshot;
		expect(state.restore({ version: 1, sessionId: "other", branchId: "branch", items: [] })).toBe(false);
		expect(state.snapshot).toEqual(before);
	});
});
