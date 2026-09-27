import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import {
	HARNESS_CHILD_RESULT_ENTRY,
	HARNESS_CHILD_USAGE_ENTRY,
	sessionApiEquivalentCost,
} from "../../src/personal-harness/api-equivalent-cost.ts";

function usage(total: number, tokens = 1): Usage {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

function assistantEntry(id: string, value: Usage, stopReason: AssistantMessage["stopReason"] = "stop"): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-28T00:00:00.000Z",
		message: { role: "assistant", stopReason, usage: value },
	} as SessionEntry;
}

function childResultEntry(
	id: string,
	apiEquivalentCost?: { estimatedUsd: number; unknownCalls: number },
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-09-28T00:00:00.000Z",
		customType: HARNESS_CHILD_RESULT_ENTRY,
		data: { id, ...(apiEquivalentCost ? { apiEquivalentCost } : {}) },
	} as SessionEntry;
}

function childUsageEntry(id: string, apiEquivalentCost: { estimatedUsd: number; unknownCalls: number }): SessionEntry {
	return {
		type: "custom",
		id: `usage-${id}-${apiEquivalentCost.estimatedUsd}`,
		parentId: null,
		timestamp: "2026-09-28T00:00:00.000Z",
		customType: HARNESS_CHILD_USAGE_ENTRY,
		data: { id, apiEquivalentCost },
	} as SessionEntry;
}

describe("session API-equivalent cost", () => {
	it("sums main and child estimates across saved branches and compaction while excluding helper usage", () => {
		const entries: SessionEntry[] = [
			assistantEntry("main-before-compact", usage(0.5)),
			{
				type: "branch_summary",
				id: "branch-summary",
				parentId: "main-before-compact",
				timestamp: "2026-09-28T00:00:01.000Z",
				summary: "older branch summary",
				usage: usage(9),
			} as SessionEntry,
			{
				type: "compaction",
				id: "compaction",
				parentId: "branch-summary",
				timestamp: "2026-09-28T00:00:02.000Z",
				summary: "compacted context",
				firstKeptEntryId: "later-user",
				tokensBefore: 10,
				usage: usage(8),
			} as SessionEntry,
			{
				type: "usage",
				id: "memory-helper",
				parentId: "compaction",
				timestamp: "2026-09-28T00:00:03.000Z",
				kind: "memory",
				provider: "fixture",
				model: "helper",
				usage: usage(7),
			} as SessionEntry,
			{
				type: "message",
				id: "tool-result",
				parentId: "compaction",
				timestamp: "2026-09-28T00:00:04.000Z",
				message: { role: "toolResult", usage: usage(6) },
			} as SessionEntry,
			assistantEntry("main-after-resume", usage(0.25)),
			childResultEntry("child-a", { estimatedUsd: 0.125, unknownCalls: 1 }),
		];

		expect(sessionApiEquivalentCost(entries)).toEqual({ estimatedUsd: 0.875, unknownCalls: 1 });
	});

	it("uses the latest cumulative child snapshot or final result once", () => {
		const entries = [
			childUsageEntry("child-a", { estimatedUsd: 0.2, unknownCalls: 0 }),
			childUsageEntry("child-a", { estimatedUsd: 0.6, unknownCalls: 1 }),
			childResultEntry("child-a", { estimatedUsd: 0.8, unknownCalls: 1 }),
		];

		expect(sessionApiEquivalentCost(entries)).toEqual({ estimatedUsd: 0.8, unknownCalls: 1 });
	});

	it("restores an unfinished child's latest usage snapshot from saved session entries", () => {
		const restoredEntries = [
			childUsageEntry("saved-child", { estimatedUsd: 0.45, unknownCalls: 1 }),
			childUsageEntry("saved-child", { estimatedUsd: 0.7, unknownCalls: 1 }),
		];

		expect(sessionApiEquivalentCost(restoredEntries)).toEqual({ estimatedUsd: 0.7, unknownCalls: 1 });
	});

	it("keeps explicitly zero cost distinct from failed calls with placeholder zero usage", () => {
		const entries: SessionEntry[] = [
			assistantEntry("free-model", { ...usage(0), cost: { ...usage(0).cost, known: true } }),
			assistantEntry("failed-call", usage(0, 0), "error"),
		];

		expect(sessionApiEquivalentCost(entries)).toEqual({ estimatedUsd: 0, unknownCalls: 1 });
	});

	it("marks child results from old sessions without saved cost as unknown instead of free", () => {
		expect(sessionApiEquivalentCost([childResultEntry("legacy-child")])).toEqual({
			estimatedUsd: 0,
			unknownCalls: 1,
		});
	});
	it("marks missing prices and missing successful usage as unknown, but accepts explicitly reported zero", () => {
		const missingPrices = usage(0, 20);
		missingPrices.cost.known = false;
		const reportedZero = usage(0, 0);
		reportedZero.cost.known = true;
		const entries = [
			assistantEntry("missing-prices", missingPrices),
			assistantEntry("missing-usage", usage(0, 0)),
			assistantEntry("reported-zero", reportedZero),
		];
		expect(sessionApiEquivalentCost(entries)).toEqual({ estimatedUsd: 0, unknownCalls: 2 });
	});

	it("retains positive historical costs but does not count explicitly unknown costs", () => {
		const unknown = usage(9);
		unknown.cost.known = false;
		expect(
			sessionApiEquivalentCost([assistantEntry("historical", usage(2)), assistantEntry("unknown", unknown)]),
		).toEqual({ estimatedUsd: 2, unknownCalls: 1 });
	});
});
