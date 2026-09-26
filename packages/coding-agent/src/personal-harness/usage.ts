import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

export type HarnessUsagePurpose = "main" | "subagent" | "memory" | "compact" | "todo" | "hook";
export interface HarnessUsageRecord {
	purpose: HarnessUsagePurpose;
	model: string;
	durationMs: number;
	status: "success" | "error" | "aborted";
	usage?: Usage;
	cacheUsageReported?: boolean;
	costReported?: boolean;
}
export interface HarnessUsageTotals {
	calls: number;
	failed: number;
	unknownUsage: number;
	unreportedCacheCalls: number;
	unreportedCostCalls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	estimatedUsd: number;
	durationMs: number;
}
function emptyTotals(): HarnessUsageTotals {
	return {
		calls: 0,
		failed: 0,
		unknownUsage: 0,
		unreportedCacheCalls: 0,
		unreportedCostCalls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		estimatedUsd: 0,
		durationMs: 0,
	};
}

export function reportedModelUsage(message: Pick<AssistantMessage, "stopReason" | "usage">): Usage | undefined {
	const usage = message.usage;
	if (
		(message.stopReason === "error" || message.stopReason === "aborted") &&
		usage.input === 0 &&
		usage.output === 0 &&
		usage.cacheRead === 0 &&
		usage.cacheWrite === 0 &&
		usage.totalTokens === 0
	)
		return undefined;
	return usage;
}

/** Provider-reported counters stay separate; reasoning tokens are already part of output. */
export class HarnessUsageLedger {
	#totals = new Map<HarnessUsagePurpose, HarnessUsageTotals>();
	#onRecord: ((record: HarnessUsageRecord) => void) | undefined;

	constructor(onRecord?: (record: HarnessUsageRecord) => void) {
		this.#onRecord = onRecord;
	}

	record(record: HarnessUsageRecord): void {
		const totals = this.#totals.get(record.purpose) ?? emptyTotals();
		totals.calls++;
		if (record.status !== "success") totals.failed++;
		totals.durationMs += Math.max(0, record.durationMs);
		if (!record.usage) totals.unknownUsage++;
		else {
			if (record.cacheUsageReported === false) totals.unreportedCacheCalls++;
			if (record.costReported === false) totals.unreportedCostCalls++;
			totals.input += record.usage.input;
			totals.output += record.usage.output;
			totals.cacheRead += record.usage.cacheRead;
			totals.cacheWrite += record.usage.cacheWrite;
			totals.estimatedUsd += record.usage.cost.total;
		}
		this.#totals.set(record.purpose, totals);
		this.#onRecord?.(record);
	}

	snapshot(): Partial<Record<HarnessUsagePurpose, HarnessUsageTotals>> {
		return Object.fromEntries([...this.#totals].map(([key, value]) => [key, { ...value }]));
	}
}
