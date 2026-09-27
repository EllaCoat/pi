import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";

export const HARNESS_GOAL_ENTRY = "personal-harness-goal";
export interface HarnessGoalSnapshot {
	version: 1;
	id: string;
	objective: string;
	status: "active" | "blocked" | "paused" | "budget-limited" | "complete" | "dropped";
	createdAt: number;
	updatedAt: number;
	tokensUsed: number;
	tokenBudget?: number;
	blockReason?: string;
}

/** A goal records intent and budget; it never grants tool permissions. */
export class HarnessGoalStore {
	#snapshot: HarnessGoalSnapshot | undefined;
	#persist: (snapshot: HarnessGoalSnapshot) => void;

	constructor(persist: (snapshot: HarnessGoalSnapshot) => void) {
		this.#persist = persist;
	}

	get(): HarnessGoalSnapshot | undefined {
		return this.#snapshot ? { ...this.#snapshot } : undefined;
	}

	create(objective: string, tokenBudget?: number): HarnessGoalSnapshot {
		if (this.#snapshot && ["active", "blocked", "paused", "budget-limited"].includes(this.#snapshot.status))
			throw new Error("An unfinished goal already exists");
		if (!objective.trim()) throw new Error("Goal objective is required");
		if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0))
			throw new Error("tokenBudget must be a positive integer");
		const now = Date.now();
		return this.#commit({
			version: 1,
			id: randomUUID(),
			objective,
			status: "active",
			createdAt: now,
			updatedAt: now,
			tokensUsed: 0,
			...(tokenBudget === undefined ? {} : { tokenBudget }),
		});
	}

	block(reason: string): HarnessGoalSnapshot {
		if (!this.#snapshot) throw new Error("No goal exists");
		if (this.#snapshot.status === "complete" || this.#snapshot.status === "dropped")
			throw new Error("The goal is already finished");
		if (!reason.trim()) throw new Error("A block reason is required");
		return this.#commit({ ...this.#snapshot, status: "blocked", blockReason: reason.trim(), updatedAt: Date.now() });
	}

	edit(objective: string): HarnessGoalSnapshot {
		if (!this.#snapshot) throw new Error("No goal exists");
		if (this.#snapshot.status === "complete" || this.#snapshot.status === "dropped")
			throw new Error("The goal is already finished");
		if (!objective.trim()) throw new Error("Goal objective is required");
		return this.#commit({ ...this.#snapshot, objective, updatedAt: Date.now() });
	}

	transition(status: "paused" | "active" | "complete" | "dropped"): HarnessGoalSnapshot {
		if (!this.#snapshot) throw new Error("No goal exists");
		if (this.#snapshot.status === "complete" || this.#snapshot.status === "dropped")
			throw new Error("The goal is already finished");
		if (
			status === "active" &&
			this.#snapshot.tokenBudget !== undefined &&
			this.#snapshot.tokensUsed >= this.#snapshot.tokenBudget
		)
			throw new Error("Goal budget is exhausted; change it explicitly before resuming");
		const next = { ...this.#snapshot, status, updatedAt: Date.now() };
		delete next.blockReason;
		return this.#commit(next);
	}

	setBudget(tokenBudget: number | undefined): HarnessGoalSnapshot {
		if (!this.#snapshot) throw new Error("No goal exists");
		if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0))
			throw new Error("tokenBudget must be a positive integer");
		const next = { ...this.#snapshot, updatedAt: Date.now() };
		if (tokenBudget === undefined) delete next.tokenBudget;
		else next.tokenBudget = tokenBudget;
		return this.#commit(next);
	}

	recordUsage(usage: Usage | undefined): void {
		if (!usage || this.#snapshot?.status !== "active") return;
		const tokensUsed = this.#snapshot.tokensUsed + usage.input + usage.cacheWrite + usage.output;
		const status =
			this.#snapshot.tokenBudget !== undefined && tokensUsed >= this.#snapshot.tokenBudget
				? "budget-limited"
				: "active";
		this.#commit({ ...this.#snapshot, tokensUsed, status, updatedAt: Date.now() });
	}

	restore(value: unknown): boolean {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const data = value as Record<string, unknown>;
		if (
			data.version !== 1 ||
			typeof data.id !== "string" ||
			typeof data.objective !== "string" ||
			typeof data.status !== "string" ||
			!["active", "blocked", "paused", "budget-limited", "complete", "dropped"].includes(data.status)
		)
			return false;
		if (
			typeof data.createdAt !== "number" ||
			!Number.isFinite(data.createdAt) ||
			typeof data.updatedAt !== "number" ||
			!Number.isFinite(data.updatedAt) ||
			typeof data.tokensUsed !== "number" ||
			!Number.isFinite(data.tokensUsed) ||
			data.tokensUsed < 0
		)
			return false;
		if (
			data.tokenBudget !== undefined &&
			(typeof data.tokenBudget !== "number" || !Number.isSafeInteger(data.tokenBudget) || data.tokenBudget <= 0)
		)
			return false;
		if (data.status === "blocked" && (typeof data.blockReason !== "string" || !data.blockReason.trim())) return false;
		this.#snapshot = {
			version: 1,
			id: data.id,
			objective: data.objective,
			status: data.status as HarnessGoalSnapshot["status"],
			createdAt: data.createdAt,
			updatedAt: data.updatedAt,
			tokensUsed: data.tokensUsed,
			...(typeof data.tokenBudget === "number" ? { tokenBudget: data.tokenBudget } : {}),
			...(data.status === "blocked" && typeof data.blockReason === "string"
				? { blockReason: data.blockReason }
				: {}),
		};
		return true;
	}

	#commit(snapshot: HarnessGoalSnapshot): HarnessGoalSnapshot {
		this.#persist({ ...snapshot });
		this.#snapshot = snapshot;
		return { ...snapshot };
	}
}
