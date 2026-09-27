import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createPersonalHarnessExtension } from "../../src/personal-harness/extension.ts";
import { HARNESS_GOAL_ENTRY } from "../../src/personal-harness/goal.ts";
import { branchIdForEntries } from "../../src/personal-harness/session-data.ts";
import { HarnessSubagents } from "../../src/personal-harness/subagents.ts";
import { createHarness } from "../suite/harness.ts";

it("restores an ancestor scope immediately without adding a user message or flushing future state", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "pi-r6-navigation-"));
	let api: ExtensionAPI | undefined;
	const closed = vi.spyOn(HarnessSubagents.prototype, "close");
	const harness = await createHarness({
		tools: [],
		settings: { cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } },
		extensionFactories: [
			createPersonalHarnessExtension({ dataDir, todoDebounceMs: 60_000 }),
			(pi) => {
				api = pi;
			},
		],
	});
	try {
		const base = { version: 1, id: "navigation-goal", status: "paused", createdAt: 1, updatedAt: 1, tokensUsed: 0 };
		const older = harness.sessionManager.appendCustomEntry(HARNESS_GOAL_ENTRY, {
			...base,
			objective: "OLDER_NAVIGATION_GOAL",
		});
		harness.sessionManager.appendCustomEntry(HARNESS_GOAL_ENTRY, { ...base, objective: "FUTURE_NAVIGATION_GOAL" });
		await harness.session.bindExtensions({ mode: "rpc" });
		if (!api) throw new Error("Missing extension API");
		harness.setResponses([fauxAssistantMessage("The future request has been observed.")]);
		await harness.session.prompt("FUTURE_REQUEST_PENDING_TODO");
		const execute = (name: string, args: Parameters<ExtensionAPI["executeTool"]>[1]) =>
			api!.executeTool(name, args, { assistantMessage: fauxAssistantMessage("scope check") });
		expect(JSON.stringify(await execute("goal", { op: "get" }))).toContain("FUTURE_NAVIGATION_GOAL");
		await execute("eval", {
			language: "javascript",
			code: "globalThis.futureNavigationValue = 73; display(futureNavigationValue);",
		});
		const beforeBranch = branchIdForEntries(
			harness.sessionManager.getEntries(),
			harness.sessionManager.getBranch(),
			harness.sessionManager.getSessionId(),
		);
		const beforeClosed = closed.mock.calls.length;
		await harness.session.navigateTree(older, { summarize: false });
		expect(
			branchIdForEntries(
				harness.sessionManager.getEntries(),
				harness.sessionManager.getBranch(),
				harness.sessionManager.getSessionId(),
			),
		).toBe(beforeBranch);
		expect(harness.sessionManager.getLeafId()).toBe(older);
		expect(closed.mock.calls.length).toBeGreaterThan(beforeClosed);
		const count = harness.sessionManager.getEntries().length;
		const restored = JSON.stringify(await execute("goal", { op: "get" }));
		expect(restored).toContain("OLDER_NAVIGATION_GOAL");
		expect(restored).not.toContain("FUTURE_NAVIGATION_GOAL");
		expect(harness.sessionManager.getEntries()).toHaveLength(count);
		const state = JSON.stringify(
			await execute("eval", { language: "javascript", code: "display(typeof globalThis.futureNavigationValue);" }),
		);
		expect(state).toContain("undefined");
		expect(state).not.toContain('"73"');
		expect(JSON.stringify(harness.sessionManager.getBranch())).not.toContain("FUTURE_REQUEST_PENDING_TODO");
	} finally {
		await harness.session.dispose();
		harness.cleanup();
		vi.restoreAllMocks();
		rmSync(dataDir, { recursive: true, force: true });
	}
});
