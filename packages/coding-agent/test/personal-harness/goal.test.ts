import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionMode, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { createPersonalHarnessExtension } from "../../src/personal-harness/extension.ts";
import { HARNESS_GOAL_ENTRY, type HarnessGoalSnapshot, HarnessGoalStore } from "../../src/personal-harness/goal.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";

function snapshot(status: HarnessGoalSnapshot["status"] = "active"): HarnessGoalSnapshot {
	return {
		version: 1,
		id: "approved-goal",
		objective: "Finish the approved fixture",
		status,
		createdAt: 1,
		updatedAt: 1,
		tokensUsed: 0,
		...(status === "blocked" ? { blockReason: "Need a user decision" } : {}),
	};
}
const call = (op: string, fields: Record<string, unknown> = {}) =>
	fauxAssistantMessage([fauxToolCall("goal", { op, ...fields })], { stopReason: "toolUse" });
function savedGoal(harness: Harness): HarnessGoalSnapshot {
	const entry = harness.sessionManager
		.getBranch()
		.findLast((entry) => entry.type === "custom" && entry.customType === HARNESS_GOAL_ENTRY);
	if (entry?.type !== "custom") throw new Error("Missing Goal snapshot");
	return entry.data as HarnessGoalSnapshot;
}

describe("Goal block and edit state", () => {
	it("preserves identity, status and history across block/edit/restore/resume", () => {
		const history: HarnessGoalSnapshot[] = [];
		const store = new HarnessGoalStore((value) => history.push(value));
		const created = store.create("original");
		expect(store.block(" waiting for user ")).toMatchObject({
			id: created.id,
			status: "blocked",
			blockReason: "waiting for user",
		});
		expect(() => store.create("replacement")).toThrow("unfinished");
		const edited = store.edit("revised");
		expect(edited).toMatchObject({
			id: created.id,
			status: "blocked",
			objective: "revised",
			createdAt: created.createdAt,
			tokensUsed: 0,
		});
		const restored = new HarnessGoalStore((value) => history.push(value));
		expect(restored.restore(JSON.parse(JSON.stringify(edited)))).toBe(true);
		expect(restored.get()).toEqual(edited);
		expect(restored.transition("active")).toMatchObject({ id: created.id, objective: "revised", status: "active" });
		expect(restored.get()?.blockReason).toBeUndefined();
		expect(history.map((value) => value.status)).toEqual(["active", "blocked", "blocked", "active"]);
	});
	it.each(["active", "paused", "budget-limited"] as const)(
		"editing %s does not restart or reset the Goal",
		(status) => {
			const store = new HarnessGoalStore(() => {});
			const initial = { ...snapshot(status), tokenBudget: 100, tokensUsed: 25 };
			expect(store.restore(initial)).toBe(true);
			expect(store.edit("new objective")).toMatchObject({
				...initial,
				objective: "new objective",
				updatedAt: expect.any(Number),
			});
		},
	);
	it.each(["complete", "dropped"] as const)("does not reopen %s through edit/block", (status) => {
		const store = new HarnessGoalStore(() => {});
		store.restore(snapshot(status));
		expect(() => store.edit("new")).toThrow("finished");
		expect(() => store.block("reason")).toThrow("finished");
	});
	it("rejects empty changes and malformed blocked snapshots without changing state", () => {
		const store = new HarnessGoalStore(() => {});
		expect(() => store.edit("new")).toThrow("No goal");
		expect(() => store.block("reason")).toThrow("No goal");
		const initial = store.create("keep");
		expect(() => store.edit("  ")).toThrow("required");
		expect(() => store.block("  ")).toThrow("required");
		expect(store.restore({ ...snapshot("blocked"), blockReason: "" })).toBe(false);
		expect(store.get()).toEqual(initial);
	});
	it("does not change the in-memory state if persistence fails", () => {
		const persist = vi.fn();
		const store = new HarnessGoalStore(persist);
		const initial = store.create("keep");
		persist.mockImplementation(() => {
			throw new Error("write failed");
		});
		expect(() => store.edit("new")).toThrow("write failed");
		expect(() => store.block("reason")).toThrow("write failed");
		expect(store.get()).toEqual(initial);
	});
});

describe("Goal in the real AgentSession loop", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	async function create(
		status: HarnessGoalSnapshot["status"] = "active",
		mode: ExtensionMode = "tui",
		factory?: (pi: ExtensionAPI) => void,
	) {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-r7-goal-"));
		dirs.push(dataDir);
		const harness = await createHarness({
			tools: [],
			settings: { cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } },
			extensionFactories: [
				createPersonalHarnessExtension({ dataDir, todoDebounceMs: 60_000 }),
				...(factory ? [factory] : []),
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendCustomEntry(HARNESS_GOAL_ENTRY, snapshot(status));
		await harness.session.bindExtensions({
			mode,
			uiContext: {
				confirm: async () => true,
				notify: () => {},
				setWidget: () => {},
			} as unknown as ExtensionUIContext,
		});
		return harness;
	}
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.cleanup();
		}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	it("prioritizes queued user input instead of adding a duplicate Goal continuation", async () => {
		let queued = false;
		const harness = await create("active", "tui", (pi) => {
			pi.on("agent_end", () => {
				if (!queued) {
					queued = true;
					pi.sendUserMessage("Block the Goal now", { deliverAs: "followUp" });
				}
			});
		});
		harness.setResponses([
			fauxAssistantMessage("Partial"),
			call("block", { reason: "User requested a stop" }),
			fauxAssistantMessage("Stopped"),
		]);
		await harness.session.prompt("Begin");
		expect(savedGoal(harness).status).toBe("blocked");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(
			harness.session.messages.filter(
				(m) => m.role === "custom" && m.customType === "personal-harness-goal-continuation",
			),
		).toHaveLength(0);
	});
	it("the user can pause between runs before automatic continuation", async () => {
		let pause: (() => Promise<void>) | undefined;
		const harness = await create("active", "tui", (pi) => {
			pi.on("agent_end", async () => {
				await pause?.();
			});
		});
		pause = () => harness.session.prompt("/goal pause");
		harness.setResponses([fauxAssistantMessage("Partial"), fauxAssistantMessage("Must not run")]);
		await harness.session.prompt("Begin");
		expect(savedGoal(harness).status).toBe("paused");
		expect(harness.getPendingResponseCount()).toBe(1);
	});
	it("slash resume from idle starts the approved Goal without an extra user prompt", async () => {
		const harness = await create("blocked");
		const settled = Promise.withResolvers<void>();
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.resolve();
		});
		harness.setResponses([call("complete"), fauxAssistantMessage("Completed after explicit resume")]);
		await harness.session.prompt("/goal resume");
		await settled.promise;
		expect(savedGoal(harness).status).toBe("complete");
		expect(harness.getPendingResponseCount()).toBe(0);
	});
	it("does not expose or automatically continue the parent Goal in a child session", async () => {
		const contexts: string[] = [];
		const harness = await create("active", "tui", (pi) => {
			pi.on("context", (event) => {
				contexts.push(JSON.stringify(event.messages));
			});
		});
		const header = harness.sessionManager.getHeader();
		if (!header) throw new Error("Missing session header");
		const spy = vi
			.spyOn(harness.sessionManager, "getHeader")
			.mockReturnValue({ ...header, parentSession: "parent-session" });
		try {
			harness.setResponses([
				call("block", { reason: "Not allowed from child" }),
				fauxAssistantMessage("No parent control"),
				fauxAssistantMessage("Must not run"),
			]);
			await harness.session.prompt("Child fixture");
			expect(savedGoal(harness).status).toBe("active");
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(contexts.at(-1)).not.toContain("personal-harness-goal-context");
			expect(harness.session.messages.find((m) => m.role === "toolResult" && m.toolName === "goal")).toMatchObject({
				isError: true,
			});
		} finally {
			spy.mockRestore();
		}
	});
	it("continues partial answers, uses the edited objective, then stops on complete", async () => {
		const contexts: string[] = [];
		const harness = await create("active", "tui", (pi) => {
			pi.on("context", (event) => {
				contexts.push(JSON.stringify(event.messages));
			});
		});
		harness.setResponses([
			fauxAssistantMessage("First portion only"),
			call("edit", { objective: "Revised approved fixture" }),
			fauxAssistantMessage("Another portion"),
			call("complete"),
			fauxAssistantMessage("Verified and finished"),
		]);
		await harness.session.prompt("Work on the Goal");
		expect(savedGoal(harness)).toMatchObject({
			id: "approved-goal",
			status: "complete",
			objective: "Revised approved fixture",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(
			harness.session.messages.filter(
				(m) => m.role === "custom" && m.customType === "personal-harness-goal-continuation",
			),
		).toHaveLength(2);
		expect(contexts.at(-1)).toContain("Revised approved fixture");
		expect(contexts.at(-1)).toContain("personal-harness-goal-context");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
	it("lets the model block with a reason without silently resuming", async () => {
		const harness = await create();
		harness.setResponses([
			call("block", { reason: "Approval needed for the next operation" }),
			fauxAssistantMessage("Waiting for approval"),
		]);
		await harness.session.prompt("Continue within permission");
		expect(savedGoal(harness)).toMatchObject({
			status: "blocked",
			blockReason: "Approval needed for the next operation",
		});
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		harness.setResponses([
			call("edit", { objective: "Edited while blocked" }),
			fauxAssistantMessage("Still blocked"),
		]);
		await harness.session.prompt("Correct the wording only");
		expect(savedGoal(harness)).toMatchObject({ status: "blocked", objective: "Edited while blocked" });
	});
	it.each(["blocked", "paused", "budget-limited", "complete", "dropped"] as const)(
		"does not auto-continue a restored %s Goal",
		async (status) => {
			const harness = await create(status);
			harness.setResponses([fauxAssistantMessage("Status noted"), fauxAssistantMessage("Must not run")]);
			await harness.session.prompt("Show status");
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(savedGoal(harness).status).toBe(status);
		},
	);
	it.each(["rpc", "print", "json"] as const)("does not auto-run in %s mode", async (mode) => {
		const harness = await create("active", mode);
		harness.setResponses([fauxAssistantMessage("Single response"), fauxAssistantMessage("Must not run")]);
		await harness.session.prompt("Report only");
		expect(harness.getPendingResponseCount()).toBe(1);
	});
	it("does not auto-retry after a model error", async () => {
		const harness = await create();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture error" }),
			fauxAssistantMessage("Must not run"),
		]);
		await harness.session.prompt("Try once");
		expect(harness.getPendingResponseCount()).toBe(1);
	});
	it("honors an explicit abort at the end of a partial response", async () => {
		let abort: (() => void) | undefined;
		const harness = await create("active", "tui", (pi) => {
			pi.on("agent_end", () => {
				abort?.();
			});
		});
		abort = () => {
			void harness.session.abort();
		};
		harness.setResponses([fauxAssistantMessage("Partial"), fauxAssistantMessage("Must not run")]);
		await harness.session.prompt("Work until interrupted");
		expect(harness.getPendingResponseCount()).toBe(1);
	});
	it("resumes a blocked Goal explicitly and continues to completion", async () => {
		const harness = await create("blocked");
		harness.setResponses([
			call("resume"),
			fauxAssistantMessage("Resumed partial result"),
			call("complete"),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("I approve resuming this Goal");
		expect(savedGoal(harness).status).toBe("complete");
		expect(harness.getPendingResponseCount()).toBe(0);
	});
	it("supports block and edit through Code Mode", async () => {
		const harness = await create();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("eval", {
						language: "javascript",
						code: "await tool.goal({op:'edit',objective:'Code Mode revised'}); await tool.goal({op:'block',reason:'User input needed'});",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Blocked"),
		]);
		await harness.session.prompt("Edit and block the fixture");
		expect(savedGoal(harness)).toMatchObject({
			status: "blocked",
			objective: "Code Mode revised",
			blockReason: "User input needed",
		});
		expect(harness.session.messages.findLast((m) => m.role === "toolResult" && m.toolName === "eval")).toMatchObject({
			isError: false,
		});
	});
	it("handles slash edit/block/show without truncating the text", async () => {
		const harness = await create();
		await harness.session.prompt("/goal edit Revised multi word objective");
		await harness.session.prompt("/goal block Waiting for a user decision");
		await harness.session.prompt("/goal show");
		expect(savedGoal(harness)).toMatchObject({
			objective: "Revised multi word objective",
			status: "blocked",
			blockReason: "Waiting for a user decision",
		});
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
	});
	it("rejects invalid edit/block input as tool errors and retains the Goal", async () => {
		const harness = await create("paused");
		harness.setResponses([call("edit", { objective: " " }), call("block"), fauxAssistantMessage("Rejected")]);
		await harness.session.prompt("Exercise invalid inputs");
		const results = harness.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "goal");
		expect(results).toHaveLength(2);
		expect(results.every((m) => m.role === "toolResult" && m.isError)).toBe(true);
		expect(getMessageText(results[0]!)).toContain("required");
		expect(savedGoal(harness)).toMatchObject({ status: "paused", objective: "Finish the approved fixture" });
	});
});
