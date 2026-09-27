import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../core/session-manager.ts";
import { isRecord } from "./hooks/jev-types.ts";

export const HARNESS_CHILD_RESULT_ENTRY = "personal-harness-child-result";
export const HARNESS_CHILD_USAGE_ENTRY = "personal-harness-child-usage";

export interface ApiEquivalentCostSummary {
	estimatedUsd: number;
	unknownCalls: number;
}

export function emptyApiEquivalentCost(): ApiEquivalentCostSummary {
	return { estimatedUsd: 0, unknownCalls: 0 };
}

export function addAssistantApiEquivalentCost(
	totals: ApiEquivalentCostSummary,
	message: Pick<AssistantMessage, "stopReason" | "usage">,
): void {
	const usage = message.usage;
	if (
		!Number.isFinite(usage.cost.total) ||
		usage.cost.total < 0 ||
		usage.cost.known === false ||
		(usage.cost.known !== true && usage.cost.total === 0)
	) {
		totals.unknownCalls++;
		return;
	}
	totals.estimatedUsd += usage.cost.total;
}

export function parseApiEquivalentCost(value: unknown): ApiEquivalentCostSummary | undefined {
	if (
		!isRecord(value) ||
		typeof value.estimatedUsd !== "number" ||
		!Number.isFinite(value.estimatedUsd) ||
		value.estimatedUsd < 0 ||
		typeof value.unknownCalls !== "number" ||
		!Number.isSafeInteger(value.unknownCalls) ||
		value.unknownCalls < 0
	)
		return undefined;
	return { estimatedUsd: value.estimatedUsd, unknownCalls: value.unknownCalls };
}

export function addSavedApiEquivalentCost(totals: ApiEquivalentCostSummary, value: unknown): void {
	const saved = parseApiEquivalentCost(value);
	if (!saved) {
		totals.unknownCalls++;
		return;
	}
	totals.estimatedUsd += saved.estimatedUsd;
	totals.unknownCalls += saved.unknownCalls;
}

export function sessionApiEquivalentCost(entries: readonly SessionEntry[]): ApiEquivalentCostSummary {
	const totals = emptyApiEquivalentCost();
	const childCosts = new Map<string, ApiEquivalentCostSummary | undefined>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			addAssistantApiEquivalentCost(totals, entry.message);
			continue;
		}
		if (
			entry.type !== "custom" ||
			(entry.customType !== HARNESS_CHILD_RESULT_ENTRY && entry.customType !== HARNESS_CHILD_USAGE_ENTRY)
		)
			continue;
		const data = isRecord(entry.data) ? entry.data : undefined;
		const childId = typeof data?.id === "string" ? data.id : undefined;
		if (childId) {
			childCosts.set(childId, parseApiEquivalentCost(data?.apiEquivalentCost));
		} else if (entry.customType === HARNESS_CHILD_RESULT_ENTRY) {
			addSavedApiEquivalentCost(totals, data?.apiEquivalentCost);
		} else {
			totals.unknownCalls++;
		}
	}
	for (const saved of childCosts.values()) {
		if (saved) addSavedApiEquivalentCost(totals, saved);
		else totals.unknownCalls++;
	}
	return totals;
}
