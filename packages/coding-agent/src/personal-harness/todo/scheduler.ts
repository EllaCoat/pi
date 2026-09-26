import type {
	TodoCapture,
	TodoEvidenceInput,
	TodoItem,
	TodoManualChange,
	TodoModelEvidence,
	TodoModelPreview,
	TodoScope,
	TodoSnapshot,
	TodoStateMachine,
	TodoStatus,
} from "./state.ts";

export type TodoChangeKind = "request" | "tool" | "verification" | "child" | "todo" | "memory";
export type TodoPersistenceReason = "manual" | "evidence" | "model" | "retry" | "shutdown";

export interface TodoChangeDelta {
	scope: TodoScope;
	entryId: string;
	kind: TodoChangeKind;
	summary: string;
}
export interface TodoModelChange {
	entryId: string;
	kind: TodoChangeKind;
	summary: string;
}

export interface TodoModelItem {
	id: string;
	title: string;
	status: TodoStatus;
	evidenceEntryIds: string[];
}

export interface TodoModelRequest {
	changes: TodoModelChange[];
	currentTodo: TodoModelItem[];
	observedEvidence: TodoModelEvidence[];
}

export type TodoModelUpdater = (request: TodoModelRequest, signal: AbortSignal) => Promise<unknown>;
export type TodoSessionEntryAppender = (snapshot: TodoSnapshot, reason: TodoPersistenceReason) => string | undefined;

export type TodoUiNotification = { type: "updated"; snapshot: TodoSnapshot } | { type: "error"; message: string };
export type TodoUiNotifier = (notification: TodoUiNotification) => void;

export interface TodoUpdateSchedulerOptions {
	state: TodoStateMachine;
	updateModel: TodoModelUpdater;
	appendSessionEntry: TodoSessionEntryAppender;
	notifyUi: TodoUiNotifier;
	debounceMs?: number;
}

interface HeldModelResult {
	capture: TodoCapture;
	changes: TodoChangeDelta[];
	response: unknown;
}

export class TodoUpdateScheduler {
	readonly state: TodoStateMachine;
	#updateModel: TodoModelUpdater;
	#appendSessionEntry: TodoSessionEntryAppender;
	#notifyUi: TodoUiNotifier;
	#debounceMs: number;
	#pendingDeltas = new Map<string, TodoChangeDelta>();
	#inFlightChanges: TodoChangeDelta[] = [];
	#ownEntryIds = new Set<string>();
	#timer: NodeJS.Timeout | undefined;
	#activeController: AbortController | undefined;
	#heldResult: HeldModelResult | undefined;
	#running = false;
	#paused = false;
	#closed = false;
	#compressionHolds = 0;
	#persistingDepth = 0;
	#awaitingRequestDeltas = 0;
	#persistenceDirty = false;

	constructor(options: TodoUpdateSchedulerOptions) {
		if (!Number.isFinite(options.debounceMs ?? 250) || (options.debounceMs ?? 250) < 0) {
			throw new Error("TODO debounceMs must be a non-negative number");
		}
		this.state = options.state;
		this.#updateModel = options.updateModel;
		this.#appendSessionEntry = options.appendSessionEntry;
		this.#notifyUi = options.notifyUi;
		this.#debounceMs = options.debounceMs ?? 250;
	}

	get pendingEntryIds(): readonly string[] {
		return [
			...new Set([
				...this.#pendingDeltas.keys(),
				...this.#inFlightChanges.map((change) => change.entryId),
				...(this.#heldResult?.changes.map((change) => change.entryId) ?? []),
			]),
		];
	}

	requestUpdate(change: TodoChangeDelta): boolean {
		if (
			this.#closed ||
			this.#persistingDepth > 0 ||
			change.kind === "todo" ||
			change.kind === "memory" ||
			!change.entryId ||
			typeof change.summary !== "string" ||
			!change.summary.trim() ||
			this.#ownEntryIds.has(change.entryId) ||
			!this.state.matchesScope(change.scope)
		) {
			return false;
		}
		if (change.kind === "request" && this.#awaitingRequestDeltas === 0) this.invalidateForNewRequest();
		const delta = { ...change, scope: { ...change.scope } };
		this.#pendingDeltas.delete(delta.entryId);
		this.#pendingDeltas.set(delta.entryId, delta);
		if (change.kind === "request") this.#awaitingRequestDeltas -= 1;
		this.#paused = this.#awaitingRequestDeltas > 0;
		this.#schedule();
		return true;
	}
	invalidateForNewRequest(): void {
		if (this.#closed) return;
		this.#clearTimer();
		this.state.noteUpdateRequest();
		this.#awaitingRequestDeltas += 1;
		this.#paused = true;
		if (this.#heldResult) {
			const held = this.#heldResult;
			this.#heldResult = undefined;
			this.#requeue(held.changes);
		}
		this.#activeController?.abort();
	}

	applyManualChange(change: TodoManualChange): boolean {
		if (this.#closed) return false;
		const candidate = this.state.prepareManualChange(change);
		if (!candidate || !this.state.commit(candidate)) return false;
		this.#notifyUpdated();
		this.#persistCommitted(candidate.snapshot, candidate.reason);
		return true;
	}

	addManualTodo(title: string): boolean {
		return this.applyManualChange({ type: "add", title });
	}

	editManualTodo(id: string, title: string): boolean {
		return this.applyManualChange({ type: "edit", id, title });
	}

	setManualStatus(id: string, status: TodoStatus): boolean {
		return this.applyManualChange({ type: "status", id, status });
	}

	removeManualTodo(id: string): boolean {
		return this.applyManualChange({ type: "remove", id });
	}

	recordEvidence(input: TodoEvidenceInput): boolean {
		if (this.#closed) return false;
		const candidate = this.state.prepareEvidence(input);
		if (!candidate || !this.state.commit(candidate)) return false;
		this.#notifyUpdated();
		this.#persistCommitted(candidate.snapshot, candidate.reason);
		return true;
	}

	flush(): void {
		this.#clearTimer();
		void this.#dispatch();
	}

	retryPending(): void {
		if (this.#closed) return;
		this.#paused = this.#awaitingRequestDeltas > 0;
		if (this.#persistenceDirty && !this.#persistCurrent("retry")) {
			this.#paused = true;
			return;
		}
		this.#schedule();
	}

	retryPersistence(): boolean {
		if (this.#closed) return false;
		if (!this.#persistenceDirty) return true;
		return this.#persistCurrent("retry");
	}

	abortCurrentUpdate(): void {
		if (this.#heldResult) {
			const held = this.#heldResult;
			this.#heldResult = undefined;
			this.#requeue(held.changes);
			this.#paused = true;
		}
		this.#activeController?.abort();
	}

	acquireCompressionHold(): () => void {
		if (this.#closed) throw new Error("TODO update scheduler is shut down");
		this.#compressionHolds += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#compressionHolds -= 1;
			if (this.#compressionHolds === 0) this.#releaseAfterCompression();
		};
	}

	async withCompressionHold<T>(operation: () => T | Promise<T>): Promise<T> {
		const release = this.acquireCompressionHold();
		try {
			return await operation();
		} finally {
			release();
		}
	}

	restore(snapshot: unknown): boolean {
		if (!this.state.restore(snapshot)) return false;
		this.#invalidateForScopeChange();
		return true;
	}

	switchScope(sessionId: string, branchId: string): void {
		this.state.resetScope(sessionId, branchId);
		this.#invalidateForScopeChange();
	}

	shutdown(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearTimer();
		this.#activeController?.abort();
		this.#pendingDeltas.clear();
		this.#heldResult = undefined;
		if (this.#persistenceDirty && this.#compressionHolds === 0) this.#persistCurrent("shutdown");
	}

	async #dispatch(): Promise<void> {
		if (
			this.#closed ||
			this.#paused ||
			this.#awaitingRequestDeltas > 0 ||
			this.#running ||
			this.#heldResult ||
			this.#pendingDeltas.size === 0
		) {
			return;
		}
		if (this.#persistenceDirty && !this.#persistCurrent("retry")) {
			this.#paused = true;
			return;
		}

		const changes = [...this.#pendingDeltas.values()];
		this.#inFlightChanges = changes;
		this.#pendingDeltas.clear();
		const snapshot = this.state.snapshot;
		const capture = this.state.capture();
		const currentTodo = snapshot.items.map((item) => this.#toModelItem(item));
		const relevantEvidenceIds = new Set(changes.map((change) => change.entryId));
		for (const item of currentTodo) {
			for (const entryId of item.evidenceEntryIds) relevantEvidenceIds.add(entryId);
		}
		const observedEvidence: TodoModelEvidence[] = [];
		for (const evidence of snapshot.evidence) {
			if (evidence.source === "child_report" || !relevantEvidenceIds.has(evidence.entryId)) continue;
			observedEvidence.push({
				entryId: evidence.entryId,
				source: evidence.source,
				outcome: evidence.outcome,
				generation: evidence.generation,
			});
		}
		const controller = new AbortController();
		this.#activeController = controller;
		this.#running = true;
		try {
			const response = await this.#updateModel(
				{
					changes: changes.map(({ entryId, kind, summary }) => ({ entryId, kind, summary })),
					currentTodo,
					observedEvidence,
				},
				controller.signal,
			);
			if (this.#closed || !this.state.matchesScope(capture)) return;
			if (controller.signal.aborted) {
				this.#requeue(changes);
				this.#paused =
					this.#awaitingRequestDeltas > 0 || this.state.capture().requestGeneration === capture.requestGeneration;
				return;
			}
			this.#inFlightChanges = [];
			const result: HeldModelResult = { capture, changes, response };
			if (this.#compressionHolds > 0) {
				this.#heldResult = result;
				return;
			}
			this.#applyModelResult(result);
		} catch {
			if (this.#closed || !this.state.matchesScope(capture)) return;
			this.#requeue(changes);
			this.#paused =
				this.#awaitingRequestDeltas > 0 || this.state.capture().requestGeneration === capture.requestGeneration;
			if (!controller.signal.aborted)
				this.#notifyError("Background TODO update failed; changes remain queued for retry.");
		} finally {
			this.#inFlightChanges = [];
			this.#running = false;
			this.#activeController = undefined;
			if (
				!this.#closed &&
				!this.#paused &&
				this.#awaitingRequestDeltas === 0 &&
				!this.#heldResult &&
				this.#pendingDeltas.size > 0
			)
				this.#schedule();
		}
	}

	#applyModelResult(result: HeldModelResult): void {
		if (this.#closed || !this.state.matchesScope(result.capture)) return;
		let preview: TodoModelPreview;
		try {
			preview = this.state.previewModelUpdate(result.capture, result.response);
		} catch {
			this.#requeue(result.changes);
			this.#paused = true;
			this.#notifyError("Background TODO update could not be prepared; changes remain queued for retry.");
			return;
		}
		if (preview.kind === "stale") {
			this.#requeue(result.changes);
			return;
		}
		if (preview.kind === "invalid") {
			this.#requeue(result.changes);
			this.#paused = true;
			this.#notifyError("Background TODO update returned invalid data; changes remain queued for retry.");
			return;
		}
		if (preview.kind === "unchanged") return;
		if (!this.#appendSnapshot(preview.candidate.snapshot, "model")) {
			this.#requeue(result.changes);
			this.#paused = true;
			return;
		}
		if (!this.state.commit(preview.candidate)) {
			this.#persistenceDirty = true;
			this.#requeue(result.changes);
			return;
		}
		this.#notifyUpdated();
	}

	#releaseAfterCompression(): void {
		if (this.#closed) return;
		const held = this.#heldResult;
		this.#heldResult = undefined;
		if (held) this.#applyModelResult(held);
		if (this.#persistenceDirty && !this.#heldResult) this.#persistCurrent("retry");
		if (!this.#paused && this.#pendingDeltas.size > 0) this.#schedule();
	}

	#persistCommitted(snapshot: TodoSnapshot, reason: TodoPersistenceReason): void {
		if (this.#compressionHolds > 0) {
			this.#persistenceDirty = true;
			return;
		}
		this.#appendSnapshot(snapshot, reason);
	}

	#persistCurrent(reason: TodoPersistenceReason): boolean {
		return this.#appendSnapshot(this.state.snapshot, reason);
	}

	#appendSnapshot(snapshot: TodoSnapshot, reason: TodoPersistenceReason): boolean {
		if (this.#compressionHolds > 0) {
			this.#persistenceDirty = true;
			return false;
		}
		this.#persistingDepth += 1;
		try {
			const entryId = this.#appendSessionEntry(cloneSnapshot(snapshot), reason);
			if (entryId) this.#ownEntryIds.add(entryId);
			this.#persistenceDirty = false;
			return true;
		} catch {
			this.#persistenceDirty = true;
			this.#notifyError("TODO session state could not be saved; changes remain available for retry.");
			return false;
		} finally {
			this.#persistingDepth -= 1;
		}
	}

	#notifyUpdated(): void {
		this.#notify({ type: "updated", snapshot: this.state.snapshot });
	}

	#notifyError(message: string): void {
		this.#notify({ type: "error", message });
	}

	#notify(notification: TodoUiNotification): void {
		try {
			this.#notifyUi(notification);
		} catch {
			// A detached UI must not break TODO state or model work.
		}
	}

	#requeue(changes: TodoChangeDelta[]): void {
		const merged = new Map<string, TodoChangeDelta>();
		for (const delta of [...changes, ...this.#pendingDeltas.values()]) {
			if (!this.state.matchesScope(delta.scope) || this.#ownEntryIds.has(delta.entryId)) continue;
			merged.delete(delta.entryId);
			merged.set(delta.entryId, delta);
		}
		this.#pendingDeltas = merged;
	}

	#schedule(): void {
		if (
			this.#closed ||
			this.#paused ||
			this.#awaitingRequestDeltas > 0 ||
			this.#pendingDeltas.size === 0 ||
			this.#heldResult
		) {
			return;
		}
		this.#clearTimer();
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.flush();
		}, this.#debounceMs);
	}

	#clearTimer(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#invalidateForScopeChange(): void {
		this.#clearTimer();
		this.#activeController?.abort();
		this.#pendingDeltas.clear();
		this.#heldResult = undefined;
		this.#ownEntryIds.clear();
		this.#persistenceDirty = false;
		this.#awaitingRequestDeltas = 0;
		this.#paused = false;
	}

	#toModelItem(item: TodoItem): TodoModelItem {
		return {
			id: item.id,
			title: item.title,
			status: item.status,
			evidenceEntryIds: [...item.evidenceEntryIds],
		};
	}
}

function cloneSnapshot(snapshot: TodoSnapshot): TodoSnapshot {
	return {
		...snapshot,
		items: snapshot.items.map((item) => ({
			...item,
			evidenceEntryIds: [...item.evidenceEntryIds],
			...(item.completion ? { completion: { ...item.completion } } : {}),
		})),
		evidence: snapshot.evidence.map((entry) => ({ ...entry })),
	};
}
