import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { createPersonalHarnessExtension } from "../../src/personal-harness/extension.ts";
import { HARNESS_GOAL_ENTRY } from "../../src/personal-harness/goal.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";

const question = {
	questions: [
		{
			id: "style",
			prompt: "Which style?",
			options: [
				{ value: "plain", label: "Plain" },
				{ value: "detail", label: "Detailed" },
			],
		},
	],
};

describe("ask through the AgentSession", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	async function create() {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-r7-ask-session-"));
		dirs.push(dataDir);
		const harness = await createHarness({
			tools: [],
			settings: { cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } },
			extensionFactories: [createPersonalHarnessExtension({ dataDir, todoDebounceMs: 60_000 })],
		});
		harnesses.push(harness);
		return harness;
	}
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.cleanup();
		}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	it("returns through Code Mode before the answer, lets work finish, then delivers the answer", async () => {
		const harness = await create();
		const answer = Promise.withResolvers<string | undefined>();
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: {
				select: () => answer.promise,
				notify: () => {},
				setWidget: () => {},
			} as unknown as ExtensionUIContext,
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("eval", {
						language: "javascript",
						code: `const question = ${JSON.stringify(question)}; display(await tool.ask(question));`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Independent work completed while the question is pending"),
		]);
		await harness.session.prompt("Ask, then finish independent work");
		expect(harness.getPendingResponseCount()).toBe(0);
		const evalResult = harness.session.messages.findLast((m) => m.role === "toolResult" && m.toolName === "eval");
		expect(evalResult).toMatchObject({ isError: false });
		expect(getMessageText(evalResult!)).toContain("pending");
		expect(
			harness.session.messages.some((m) => m.role === "custom" && m.customType === "personal-harness-ask-answer"),
		).toBe(false);
		harness.setResponses([fauxAssistantMessage("Received the choice")]);
		answer.resolve("1. Plain");
		await vi.waitFor(() =>
			expect(harness.session.messages.some((m) => getMessageText(m).includes("Received the choice"))).toBe(true),
		);
		await harness.session.waitForIdle();
		const delivered = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "personal-harness-ask-answer",
		);
		expect(delivered).toMatchObject({
			details: {
				status: "answered",
				questionIds: ["style"],
				answers: [{ questionId: "style", selections: [{ value: "plain" }] }],
			},
		});
	});
	it("asking does not block an active Goal or prevent automatic continuation", async () => {
		const harness = await create();
		const answer = Promise.withResolvers<string | undefined>();
		harness.sessionManager.appendCustomEntry(HARNESS_GOAL_ENTRY, {
			version: 1,
			id: "ask-goal",
			objective: "Finish independent work",
			status: "active",
			createdAt: 1,
			updatedAt: 1,
			tokensUsed: 0,
		});
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: {
				select: () => answer.promise,
				notify: () => {},
				setWidget: () => {},
			} as unknown as ExtensionUIContext,
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ask", question)], { stopReason: "toolUse" }),
			fauxAssistantMessage("Question pending; independent work remains"),
			fauxAssistantMessage([fauxToolCall("goal", { op: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Independent Goal finished without waiting for the optional answer"),
		]);
		await harness.session.prompt("Ask an optional question and continue the Goal");
		expect(harness.getPendingResponseCount()).toBe(0);
		const goals = harness.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === HARNESS_GOAL_ENTRY)
			.map((e) => (e.type === "custom" ? (e.data as { status: string }) : undefined));
		expect(goals.every((g) => g?.status !== "blocked")).toBe(true);
		expect(goals.at(-1)?.status).toBe("complete");
		expect(
			harness.session.messages.filter(
				(m) => m.role === "custom" && m.customType === "personal-harness-goal-continuation",
			),
		).toHaveLength(1);
		await harness.session.abort();
		answer.resolve("1. Plain");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(
			harness.session.messages.some((m) => m.role === "custom" && m.customType === "personal-harness-ask-answer"),
		).toBe(false);
	});
	it("reports unavailable ask as an actual tool error outside TUI", async () => {
		const harness = await create();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ask", question)], { stopReason: "toolUse" }),
			fauxAssistantMessage("Question unavailable"),
		]);
		await harness.session.prompt("Ask in noninteractive mode");
		expect(harness.session.messages.findLast((m) => m.role === "toolResult" && m.toolName === "ask")).toMatchObject({
			isError: true,
		});
	});
});
