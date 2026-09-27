import { randomUUID } from "node:crypto";
import { isRecord } from "../hooks/jev-types.ts";

export const TODO_SESSION_ENTRY_TYPE = "personal-harness-todo";

export type TodoStatus = "pending" | "in_progress" | "blocked" | "done";

export interface TodoItem {
	id: string;
	title: string;
	status: TodoStatus;
}

export interface TodoSnapshot {
	version: 1;
	sessionId: string;
	branchId: string;
	generation: number;
	revision: number;
	manualRevision: number;
	items: TodoItem[];
}

export interface TodoScope {
	sessionId: string;
	branchId: string;
	generation: number;
}

export interface TodoCapture extends TodoScope {
	revision: number;
	manualRevision: number;
}

export interface TodoCandidate {
	capture: TodoCapture;
	snapshot: TodoSnapshot;
	reason: "manual" | "model";
}

export type TodoManualChange =
	| { type: "add"; title: string }
	| { type: "edit"; id: string; title: string }
	| { type: "status"; id: string; status: TodoStatus }
	| { type: "remove"; id: string };

export interface TodoModelUpdate {
	add?: Array<{ title: string }>;
	update?: Array<{ id: string; title?: string; status?: TodoStatus }>;
}

export type TodoModelPreview =
	| { kind: "candidate"; candidate: TodoCandidate }
	| { kind: "unchanged" }
	| { kind: "invalid" }
	| { kind: "stale" };

export interface TodoStateOptions {
	sessionId: string;
	branchId: string;
	idFactory?: () => string;
}

export class TodoStateMachine {
	#snapshot: TodoSnapshot;
	#idFactory: () => string;

	constructor(options: TodoStateOptions) {
		if (!options.sessionId || !options.branchId) throw new Error("TODO sessionId and branchId are required");
		this.#idFactory = options.idFactory ?? randomUUID;
		this.#snapshot = {
			version: 1,
			sessionId: options.sessionId,
			branchId: options.branchId,
			generation: 0,
			revision: 0,
			manualRevision: 0,
			items: [],
		};
	}

	get snapshot(): TodoSnapshot {
		return structuredClone(this.#snapshot);
	}

	get scope(): TodoScope {
		return {
			sessionId: this.#snapshot.sessionId,
			branchId: this.#snapshot.branchId,
			generation: this.#snapshot.generation,
		};
	}

	capture(): TodoCapture {
		return captureOf(this.#snapshot);
	}

	matches(capture: TodoCapture): boolean {
		return sameCapture(this.#snapshot, capture);
	}

	matchesScope(scope: TodoScope): boolean {
		return (
			this.#snapshot.sessionId === scope.sessionId &&
			this.#snapshot.branchId === scope.branchId &&
			this.#snapshot.generation === scope.generation
		);
	}

	prepareManualChange(change: TodoManualChange): TodoCandidate | undefined {
		const capture = this.capture();
		const items = this.#snapshot.items.map((item) => ({ ...item }));
		if (change.type === "add") {
			const title = change.title.trim();
			if (!title) return undefined;
			const id = this.#idFactory();
			if (!id || items.some((item) => item.id === id))
				throw new Error("TODO idFactory must return a unique non-empty id");
			items.push({ id, title, status: "pending" });
		} else {
			const index = items.findIndex((item) => item.id === change.id);
			if (index < 0) return undefined;
			const item = items[index];
			if (!item) return undefined;
			if (change.type === "edit") {
				const title = change.title.trim();
				if (!title || title === item.title) return undefined;
				items[index] = { ...item, title };
			} else if (change.type === "status") {
				if (item.status === change.status) return undefined;
				items[index] = { ...item, status: change.status };
			} else {
				items.splice(index, 1);
			}
		}
		return {
			capture,
			reason: "manual",
			snapshot: {
				...this.#snapshot,
				revision: this.#snapshot.revision + 1,
				manualRevision: this.#snapshot.manualRevision + 1,
				items,
			},
		};
	}

	previewModelUpdate(capture: TodoCapture, input: unknown): TodoModelPreview {
		if (
			!this.matchesScope(capture) ||
			this.#snapshot.manualRevision !== capture.manualRevision ||
			capture.revision > this.#snapshot.revision
		) {
			return { kind: "stale" };
		}
		const update = parseModelUpdate(input);
		if (!update) return { kind: "invalid" };

		const items = this.#snapshot.items.map((item) => ({ ...item }));
		for (const addition of update.add ?? []) {
			const id = this.#idFactory();
			if (!id || items.some((item) => item.id === id))
				throw new Error("TODO idFactory must return a unique non-empty id");
			items.push({ id, title: addition.title, status: "pending" });
		}
		for (const change of update.update ?? []) {
			const item = items.find((candidate) => candidate.id === change.id);
			if (!item) continue;
			if (change.title !== undefined) item.title = change.title;
			if (change.status !== undefined) item.status = change.status;
		}
		if (itemsEqual(items, this.#snapshot.items)) return { kind: "unchanged" };
		return {
			kind: "candidate",
			candidate: {
				capture: this.capture(),
				reason: "model",
				snapshot: {
					...this.#snapshot,
					revision: this.#snapshot.revision + 1,
					items,
				},
			},
		};
	}

	commit(candidate: TodoCandidate): boolean {
		if (!this.matches(candidate.capture)) return false;
		if (
			candidate.snapshot.sessionId !== this.#snapshot.sessionId ||
			candidate.snapshot.branchId !== this.#snapshot.branchId ||
			candidate.snapshot.generation !== this.#snapshot.generation ||
			candidate.snapshot.revision !== this.#snapshot.revision + 1
		) {
			return false;
		}
		this.#snapshot = structuredClone(candidate.snapshot);
		return true;
	}

	restore(input: unknown): boolean {
		const restored = parseSnapshot(input);
		if (!restored) return false;
		this.#snapshot = {
			...restored,
			generation: Math.max(this.#snapshot.generation, restored.generation) + 1,
		};
		return true;
	}

	resetScope(sessionId: string, branchId: string): void {
		if (!sessionId || !branchId) throw new Error("TODO sessionId and branchId are required");
		this.#snapshot = {
			version: 1,
			sessionId,
			branchId,
			generation: this.#snapshot.generation + 1,
			revision: 0,
			manualRevision: 0,
			items: [],
		};
	}
}

function parseModelUpdate(input: unknown): TodoModelUpdate | undefined {
	if (!isRecord(input) || Object.keys(input).some((key) => key !== "add" && key !== "update")) return undefined;
	const result: TodoModelUpdate = {};
	if ("add" in input) {
		if (!Array.isArray(input.add)) return undefined;
		const additions: Array<{ title: string }> = [];
		for (const item of input.add) {
			if (
				!isRecord(item) ||
				Object.keys(item).some((key) => key !== "title") ||
				typeof item.title !== "string" ||
				!item.title.trim()
			)
				return undefined;
			additions.push({ title: item.title.trim() });
		}
		result.add = additions;
	}
	if ("update" in input) {
		if (!Array.isArray(input.update)) return undefined;
		const changes: NonNullable<TodoModelUpdate["update"]> = [];
		for (const item of input.update) {
			if (!isRecord(item) || Object.keys(item).some((key) => key !== "id" && key !== "title" && key !== "status"))
				return undefined;
			if (typeof item.id !== "string" || !item.id) return undefined;
			const change: NonNullable<TodoModelUpdate["update"]>[number] = { id: item.id };
			if ("title" in item) {
				if (typeof item.title !== "string" || !item.title.trim()) return undefined;
				change.title = item.title.trim();
			}
			if ("status" in item) {
				if (!isTodoStatus(item.status)) return undefined;
				change.status = item.status;
			}
			changes.push(change);
		}
		result.update = changes;
	}
	return result;
}

function parseSnapshot(input: unknown): TodoSnapshot | undefined {
	if (!isRecord(input) || input.version !== 1) return undefined;
	if (
		typeof input.sessionId !== "string" ||
		!input.sessionId ||
		typeof input.branchId !== "string" ||
		!input.branchId ||
		!isNonNegativeInteger(input.generation) ||
		!isNonNegativeInteger(input.revision) ||
		!isNonNegativeInteger(input.manualRevision) ||
		!Array.isArray(input.items)
	) {
		return undefined;
	}

	const items: TodoItem[] = [];
	const itemIds = new Set<string>();
	for (const value of input.items) {
		if (!isRecord(value) || typeof value.id !== "string" || !value.id || itemIds.has(value.id)) return undefined;
		if (typeof value.title !== "string" || !value.title.trim() || !isTodoStatus(value.status)) return undefined;
		itemIds.add(value.id);
		items.push({ id: value.id, title: value.title, status: value.status });
	}

	return {
		version: 1,
		sessionId: input.sessionId,
		branchId: input.branchId,
		generation: input.generation,
		revision: input.revision,
		manualRevision: input.manualRevision,
		items,
	};
}

function captureOf(snapshot: TodoSnapshot): TodoCapture {
	return {
		sessionId: snapshot.sessionId,
		branchId: snapshot.branchId,
		generation: snapshot.generation,
		revision: snapshot.revision,
		manualRevision: snapshot.manualRevision,
	};
}

function sameCapture(snapshot: TodoSnapshot, capture: TodoCapture): boolean {
	return (
		snapshot.sessionId === capture.sessionId &&
		snapshot.branchId === capture.branchId &&
		snapshot.generation === capture.generation &&
		snapshot.revision === capture.revision &&
		snapshot.manualRevision === capture.manualRevision
	);
}

function itemsEqual(left: TodoItem[], right: TodoItem[]): boolean {
	return (
		left.length === right.length &&
		left.every((item, index) => {
			const other = right[index];
			return item.id === other?.id && item.title === other.title && item.status === other.status;
		})
	);
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "blocked" || value === "done";
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
