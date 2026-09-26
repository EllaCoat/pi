import { randomUUID } from "node:crypto";

export const TODO_SESSION_ENTRY_TYPE = "personal-harness-todo";

export type TodoStatus = "pending" | "in_progress" | "blocked" | "done";
export type TodoModelStatus = Exclude<TodoStatus, "done">;
export type TodoEvidenceSource = "operation" | "verification" | "child_report";
export type TodoEvidenceOutcome = "success" | "failure";

export interface TodoCompletion {
	kind: "manual";
}

export interface EvidenceTodoCompletion {
	kind: "evidence";
	entryId: string;
}

export interface TodoItem {
	id: string;
	title: string;
	status: TodoStatus;
	evidenceEntryIds: string[];
	completion?: TodoCompletion | EvidenceTodoCompletion;
}

export interface TodoEvidence {
	entryId: string;
	todoId?: string;
	source: TodoEvidenceSource;
	outcome: TodoEvidenceOutcome;
	generation: number;
}

export type TodoObservedEvidenceSource = Exclude<TodoEvidenceSource, "child_report">;

export interface TodoModelEvidence {
	entryId: string;
	source: TodoObservedEvidenceSource;
	outcome: TodoEvidenceOutcome;
	generation: number;
}

export interface TodoSnapshot {
	version: 1;
	sessionId: string;
	branchId: string;
	generation: number;
	revision: number;
	manualRevision: number;
	requestGeneration: number;
	evidenceGeneration: number;
	items: TodoItem[];
	evidence: TodoEvidence[];
}

export interface TodoScope {
	sessionId: string;
	branchId: string;
	generation: number;
}

export interface TodoCapture extends TodoScope {
	revision: number;
	manualRevision: number;
	requestGeneration: number;
	evidenceGeneration: number;
}

export interface TodoCandidate {
	capture: TodoCapture;
	snapshot: TodoSnapshot;
	reason: "manual" | "evidence" | "model";
}

export type TodoManualChange =
	| { type: "add"; title: string }
	| { type: "edit"; id: string; title: string }
	| { type: "status"; id: string; status: TodoStatus }
	| { type: "remove"; id: string };

export type TodoEvidenceInput =
	| (TodoScope & {
			entryId: string;
			todoId?: string;
			source: "operation" | "verification";
			outcome: TodoEvidenceOutcome;
	  })
	| (TodoScope & {
			entryId: string;
			todoId: string;
			source: "child_report";
			outcome: TodoEvidenceOutcome;
	  });

export interface TodoModelUpdate {
	add?: Array<{ title: string }>;
	update?: Array<{ id: string; title?: string; status?: TodoStatus; evidenceEntryIds?: string[] }>;
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
			requestGeneration: 0,
			evidenceGeneration: 0,
			items: [],
			evidence: [],
		};
	}

	get snapshot(): TodoSnapshot {
		return cloneSnapshot(this.#snapshot);
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

	noteUpdateRequest(): void {
		this.#snapshot = { ...this.#snapshot, requestGeneration: this.#snapshot.requestGeneration + 1 };
	}

	prepareManualChange(change: TodoManualChange): TodoCandidate | undefined {
		const capture = this.capture();
		const items = this.#snapshot.items.map(cloneItem);
		let evidence = this.#snapshot.evidence.map((entry) => ({ ...entry }));
		if (change.type === "add") {
			const title = change.title.trim();
			if (!title) return undefined;
			const id = this.#idFactory();
			if (!id || items.some((item) => item.id === id))
				throw new Error("TODO idFactory must return a unique non-empty id");
			items.push({ id, title, status: "pending", evidenceEntryIds: [] });
		} else {
			const index = items.findIndex((item) => item.id === change.id);
			if (index < 0) return undefined;
			const item = items[index];
			if (change.type === "edit") {
				const title = change.title.trim();
				if (!title || title === item.title) return undefined;
				items[index] = { ...item, title };
			} else if (change.type === "status") {
				const completion = change.status === "done" ? { kind: "manual" as const } : undefined;
				if (item.status === change.status && sameCompletion(item.completion, completion)) return undefined;
				items[index] = { ...item, status: change.status, completion };
			} else {
				items.splice(index, 1);
				evidence = evidence.filter((entry) => entry.todoId !== change.id);
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
				evidence,
			},
		};
	}

	prepareEvidence(input: TodoEvidenceInput): TodoCandidate | undefined {
		if (!this.matchesScope(input)) return undefined;
		if (!input.entryId || !isEvidenceSource(input.source) || !isEvidenceOutcome(input.outcome)) return undefined;
		if (input.source === "child_report" && !input.todoId) return undefined;
		if (
			input.todoId !== undefined &&
			(!input.todoId || !this.#snapshot.items.some((item) => item.id === input.todoId))
		)
			return undefined;
		if (this.#snapshot.evidence.some((evidence) => evidence.entryId === input.entryId)) return undefined;

		const capture = this.capture();
		const generation = this.#snapshot.evidenceGeneration + 1;
		const evidence: TodoEvidence = {
			entryId: input.entryId,
			...(input.todoId ? { todoId: input.todoId } : {}),
			source: input.source,
			outcome: input.outcome,
			generation,
		};
		const items = this.#snapshot.items.map(cloneItem);
		const item = input.todoId ? items.find((candidate) => candidate.id === input.todoId) : undefined;
		if (item) {
			if (!item.evidenceEntryIds.includes(evidence.entryId)) item.evidenceEntryIds.push(evidence.entryId);
			if (input.source !== "child_report" && input.outcome === "success") {
				item.status = "done";
				item.completion = { kind: "evidence", entryId: evidence.entryId };
			} else if (
				input.source !== "child_report" &&
				input.outcome === "failure" &&
				item.completion?.kind === "evidence"
			) {
				item.status = "in_progress";
				delete item.completion;
			}
		}

		return {
			capture,
			reason: "evidence",
			snapshot: {
				...this.#snapshot,
				revision: this.#snapshot.revision + 1,
				evidenceGeneration: generation,
				items,
				evidence: [...this.#snapshot.evidence.map((entry) => ({ ...entry })), evidence],
			},
		};
	}

	previewModelUpdate(capture: TodoCapture, input: unknown): TodoModelPreview {
		if (
			!this.matchesScope(capture) ||
			this.#snapshot.manualRevision !== capture.manualRevision ||
			this.#snapshot.requestGeneration !== capture.requestGeneration ||
			capture.revision > this.#snapshot.revision ||
			capture.evidenceGeneration > this.#snapshot.evidenceGeneration
		) {
			return { kind: "stale" };
		}
		const update = parseModelUpdate(input);
		if (!update) return { kind: "invalid" };

		const items = this.#snapshot.items.map(cloneItem);
		for (const addition of update.add ?? []) {
			const id = this.#idFactory();
			if (!id || items.some((item) => item.id === id))
				throw new Error("TODO idFactory must return a unique non-empty id");
			items.push({ id, title: addition.title, status: "pending", evidenceEntryIds: [] });
		}
		for (const change of update.update ?? []) {
			const item = items.find((candidate) => candidate.id === change.id);
			if (!item) continue;
			if (change.title !== undefined && change.title !== item.title) item.title = change.title;
			if (item.status === "done") {
				if (item.completion?.kind === "evidence" && change.evidenceEntryIds !== undefined) {
					const evidence = resolveModelEvidence(
						this.#snapshot,
						item.id,
						change.evidenceEntryIds,
						false,
						capture.evidenceGeneration,
					);
					if (evidence?.some((entry) => entry.outcome === "failure")) {
						for (const entry of evidence) {
							if (!item.evidenceEntryIds.includes(entry.entryId)) item.evidenceEntryIds.push(entry.entryId);
						}
						item.status = change.status !== undefined && change.status !== "done" ? change.status : "in_progress";
						delete item.completion;
					}
				}
				continue;
			}

			if (change.status === "done") {
				const evidence = resolveModelEvidence(
					this.#snapshot,
					item.id,
					change.evidenceEntryIds ?? [],
					true,
					capture.evidenceGeneration,
				);
				if (!evidence?.length) continue;
				const latestSuccessGeneration = Math.max(...evidence.map((entry) => entry.generation));
				const hasNewerRelatedFailure = this.#snapshot.evidence.some(
					(entry) =>
						entry.outcome === "failure" &&
						(entry.todoId === item.id || item.evidenceEntryIds.includes(entry.entryId)) &&
						entry.generation > latestSuccessGeneration,
				);
				const hasUnclassifiedNewFailure = this.#snapshot.evidence.some(
					(entry) =>
						entry.outcome === "failure" &&
						entry.generation > capture.evidenceGeneration &&
						entry.todoId === undefined &&
						!this.#snapshot.items.some((candidate) => candidate.evidenceEntryIds.includes(entry.entryId)),
				);
				if (hasNewerRelatedFailure || hasUnclassifiedNewFailure) continue;
				for (const entry of evidence) {
					if (!item.evidenceEntryIds.includes(entry.entryId)) item.evidenceEntryIds.push(entry.entryId);
				}
				item.status = "done";
				item.completion = { kind: "evidence", entryId: evidence[0].entryId };
				continue;
			}

			if (change.evidenceEntryIds !== undefined) {
				const evidence = resolveModelEvidence(
					this.#snapshot,
					item.id,
					change.evidenceEntryIds,
					false,
					capture.evidenceGeneration,
				);
				if (evidence) {
					for (const entry of evidence) {
						if (!item.evidenceEntryIds.includes(entry.entryId)) item.evidenceEntryIds.push(entry.entryId);
					}
				}
			}
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
					evidence: this.#snapshot.evidence.map((evidence) => ({ ...evidence })),
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
		this.#snapshot = cloneSnapshot(candidate.snapshot);
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
			requestGeneration: 0,
			evidenceGeneration: 0,
			items: [],
			evidence: [],
		};
	}
}

function parseModelUpdate(input: unknown): TodoModelUpdate | undefined {
	if (!isRecord(input)) return undefined;
	const result: TodoModelUpdate = {};
	if ("add" in input) {
		if (!Array.isArray(input.add)) return undefined;
		const additions: Array<{ title: string }> = [];
		for (const item of input.add) {
			if (!isRecord(item) || typeof item.title !== "string" || !item.title.trim()) return undefined;
			additions.push({ title: item.title.trim() });
		}
		result.add = additions;
	}
	if ("update" in input) {
		if (!Array.isArray(input.update)) return undefined;
		const changes: NonNullable<TodoModelUpdate["update"]> = [];
		for (const item of input.update) {
			if (!isRecord(item) || typeof item.id !== "string" || !item.id) return undefined;
			const change: NonNullable<TodoModelUpdate["update"]>[number] = { id: item.id };
			if ("title" in item) {
				if (typeof item.title !== "string" || !item.title.trim()) return undefined;
				change.title = item.title.trim();
			}
			if ("status" in item) {
				if (!isTodoStatus(item.status)) return undefined;
				change.status = item.status;
			}
			if ("evidenceEntryIds" in item) {
				if (!Array.isArray(item.evidenceEntryIds)) return undefined;
				const evidenceEntryIds: string[] = [];
				for (const entryId of item.evidenceEntryIds as unknown[]) {
					if (typeof entryId !== "string" || !entryId) return undefined;
					if (!evidenceEntryIds.includes(entryId)) evidenceEntryIds.push(entryId);
				}
				change.evidenceEntryIds = evidenceEntryIds;
			}
			changes.push(change);
		}
		result.update = changes;
	}
	return result;
}

function resolveModelEvidence(
	snapshot: TodoSnapshot,
	todoId: string,
	entryIds: string[],
	successfulOnly: boolean,
	maximumGeneration: number,
): TodoEvidence[] | undefined {
	const evidence: TodoEvidence[] = [];
	for (const entryId of entryIds) {
		const entry = snapshot.evidence.find((candidate) => candidate.entryId === entryId);
		if (
			!entry ||
			entry.source === "child_report" ||
			entry.generation > maximumGeneration ||
			(entry.todoId !== undefined && entry.todoId !== todoId) ||
			(successfulOnly && entry.outcome !== "success")
		) {
			return undefined;
		}
		evidence.push(entry);
	}
	return evidence;
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
		!isNonNegativeInteger(input.requestGeneration) ||
		!isNonNegativeInteger(input.evidenceGeneration) ||
		!Array.isArray(input.items) ||
		!Array.isArray(input.evidence)
	) {
		return undefined;
	}

	const items: TodoItem[] = [];
	const itemIds = new Set<string>();
	for (const value of input.items) {
		if (!isRecord(value) || typeof value.id !== "string" || !value.id || itemIds.has(value.id)) return undefined;
		if (typeof value.title !== "string" || !value.title.trim() || !isTodoStatus(value.status)) return undefined;
		if (!Array.isArray(value.evidenceEntryIds) || !value.evidenceEntryIds.every((id) => typeof id === "string" && id))
			return undefined;
		const evidenceEntryIds = [...new Set(value.evidenceEntryIds as string[])];
		let completion: TodoItem["completion"];
		if (value.status === "done") {
			if (!isRecord(value.completion)) return undefined;
			if (value.completion.kind === "manual") {
				completion = { kind: "manual" };
			} else if (
				value.completion.kind === "evidence" &&
				typeof value.completion.entryId === "string" &&
				value.completion.entryId
			) {
				completion = { kind: "evidence", entryId: value.completion.entryId };
			} else {
				return undefined;
			}
		} else if (value.completion !== undefined) {
			return undefined;
		}
		itemIds.add(value.id);
		items.push({
			id: value.id,
			title: value.title,
			status: value.status,
			evidenceEntryIds,
			...(completion ? { completion } : {}),
		});
	}

	const evidence: TodoEvidence[] = [];
	const evidenceIds = new Set<string>();
	for (const value of input.evidence) {
		if (!isRecord(value)) return undefined;
		const todoId = value.todoId;
		if (
			typeof value.entryId !== "string" ||
			!value.entryId ||
			evidenceIds.has(value.entryId) ||
			(todoId !== undefined && (typeof todoId !== "string" || !itemIds.has(todoId))) ||
			(value.source === "child_report" && typeof todoId !== "string") ||
			!isEvidenceSource(value.source) ||
			!isEvidenceOutcome(value.outcome) ||
			!isNonNegativeInteger(value.generation) ||
			value.generation === 0 ||
			value.generation > input.evidenceGeneration
		) {
			return undefined;
		}
		evidenceIds.add(value.entryId);
		evidence.push({
			entryId: value.entryId,
			...(typeof todoId === "string" ? { todoId } : {}),
			source: value.source,
			outcome: value.outcome,
			generation: value.generation,
		});
	}

	for (const item of items) {
		if (
			item.evidenceEntryIds.some((id) => {
				const entry = evidence.find((candidate) => candidate.entryId === id);
				return !entry || (entry.todoId !== undefined && entry.todoId !== item.id);
			})
		) {
			return undefined;
		}
		const completion = item.completion;
		if (completion?.kind === "evidence") {
			const completionEvidence = evidence.find((entry) => entry.entryId === completion.entryId);
			if (
				!completionEvidence ||
				(completionEvidence.todoId !== undefined && completionEvidence.todoId !== item.id) ||
				!item.evidenceEntryIds.includes(completion.entryId) ||
				completionEvidence.source === "child_report" ||
				completionEvidence.outcome !== "success"
			) {
				return undefined;
			}
		}
	}

	return {
		version: 1,
		sessionId: input.sessionId,
		branchId: input.branchId,
		generation: input.generation,
		revision: input.revision,
		manualRevision: input.manualRevision,
		requestGeneration: input.requestGeneration,
		evidenceGeneration: input.evidenceGeneration,
		items,
		evidence,
	};
}

function captureOf(snapshot: TodoSnapshot): TodoCapture {
	return {
		sessionId: snapshot.sessionId,
		branchId: snapshot.branchId,
		generation: snapshot.generation,
		revision: snapshot.revision,
		manualRevision: snapshot.manualRevision,
		requestGeneration: snapshot.requestGeneration,
		evidenceGeneration: snapshot.evidenceGeneration,
	};
}

function sameCapture(snapshot: TodoSnapshot, capture: TodoCapture): boolean {
	return (
		snapshot.sessionId === capture.sessionId &&
		snapshot.branchId === capture.branchId &&
		snapshot.generation === capture.generation &&
		snapshot.revision === capture.revision &&
		snapshot.manualRevision === capture.manualRevision &&
		snapshot.requestGeneration === capture.requestGeneration &&
		snapshot.evidenceGeneration === capture.evidenceGeneration
	);
}

function cloneSnapshot(snapshot: TodoSnapshot): TodoSnapshot {
	return {
		...snapshot,
		items: snapshot.items.map(cloneItem),
		evidence: snapshot.evidence.map((entry) => ({ ...entry })),
	};
}

function cloneItem(item: TodoItem): TodoItem {
	return {
		...item,
		evidenceEntryIds: [...item.evidenceEntryIds],
		...(item.completion ? { completion: { ...item.completion } } : {}),
	};
}

function itemsEqual(left: TodoItem[], right: TodoItem[]): boolean {
	return (
		left.length === right.length &&
		left.every((item, index) => {
			const other = right[index];
			return (
				item.id === other.id &&
				item.title === other.title &&
				item.status === other.status &&
				item.evidenceEntryIds.length === other.evidenceEntryIds.length &&
				item.evidenceEntryIds.every((id, idIndex) => id === other.evidenceEntryIds[idIndex]) &&
				sameCompletion(item.completion, other.completion)
			);
		})
	);
}

function sameCompletion(left: TodoItem["completion"], right: TodoItem["completion"]): boolean {
	if (!left || !right) return left === right;
	return (
		left.kind === right.kind &&
		(left.kind === "manual" || (right.kind === "evidence" && left.entryId === right.entryId))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "blocked" || value === "done";
}

function isEvidenceSource(value: unknown): value is TodoEvidenceSource {
	return value === "operation" || value === "verification" || value === "child_report";
}

function isEvidenceOutcome(value: unknown): value is TodoEvidenceOutcome {
	return value === "success" || value === "failure";
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
