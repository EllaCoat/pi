import type {
	TodoCapture,
	TodoManualChange,
	TodoModelPreview,
	TodoScope,
	TodoSnapshot,
	TodoStateMachine,
	TodoStatus,
} from "./state.ts";

export const TODO_CHANGE_CHECK_INTERVAL_MS = 60_000;
export const TODO_MODEL_UPDATE_INTERVAL_MS = 300_000;

export type TodoChangeKind = "request" | "tool" | "verification" | "child" | "todo" | "memory";
export type TodoPersistenceReason = "manual" | "model" | "retry" | "shutdown";

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
}

export interface TodoModelRequest {
	changes: TodoModelChange[];
	currentTodo: TodoModelItem[];
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
	checkIntervalMs?: number;
	modelIntervalMs?: number;
}

export class TodoUpdateScheduler {
	readonly state: TodoStateMachine;
	#updateModel: TodoModelUpdater;
	#appendSessionEntry: TodoSessionEntryAppender;
	#notifyUi: TodoUiNotifier;
	#bufferedDeltas = new Map<string, TodoChangeDelta>();
	#pendingDeltas = new Map<string, TodoChangeDelta>();
	#inFlightChanges: TodoChangeDelta[] = [];
	#ownEntryIds = new Set<string>();
	#checkTimer: NodeJS.Timeout;
	#modelTimer: NodeJS.Timeout;
	#activeController: AbortController | undefined;
	#dispatchPromise: Promise<void> | undefined;
	#shutdownPromise: Promise<void> | undefined;
	#running = false;
	#closed = false;
	#persistingDepth = 0;
	#awaitingRequestDeltas = 0;
	#persistenceDirty = false;

	constructor(options: TodoUpdateSchedulerOptions) {
		const checkIntervalMs = options.checkIntervalMs ?? TODO_CHANGE_CHECK_INTERVAL_MS;
		const modelIntervalMs = options.modelIntervalMs ?? TODO_MODEL_UPDATE_INTERVAL_MS;
		if (!Number.isFinite(checkIntervalMs) || checkIntervalMs <= 0)
			throw new Error("TODO checkIntervalMs must be a positive number");
		if (!Number.isFinite(modelIntervalMs) || modelIntervalMs <= 0)
			throw new Error("TODO modelIntervalMs must be a positive number");
		this.state = options.state;
		this.#updateModel = options.updateModel;
		this.#appendSessionEntry = options.appendSessionEntry;
		this.#notifyUi = options.notifyUi;
		this.#checkTimer = setInterval(() => this.#collectDeltas(), checkIntervalMs);
		this.#modelTimer = setInterval(() => this.#runModelWindow(), modelIntervalMs);
		this.#checkTimer.unref();
		this.#modelTimer.unref();
	}

	get pendingEntryIds(): readonly string[] {
		return [
			...new Set([
				...this.#bufferedDeltas.keys(),
				...this.#pendingDeltas.keys(),
				...this.#inFlightChanges.map((change) => change.entryId),
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
		if (change.kind === "request" && this.#awaitingRequestDeltas === 0) this.beginRequest();
		const delta = { ...change, scope: { ...change.scope } };
		this.#bufferedDeltas.delete(delta.entryId);
		this.#bufferedDeltas.set(delta.entryId, delta);
		if (change.kind === "request") this.#awaitingRequestDeltas -= 1;
		return true;
	}

	beginRequest(): void {
		if (this.#closed) return;
		this.#awaitingRequestDeltas += 1;
	}

	completeRequestWithoutDelta(): void {
		if (this.#closed || this.#awaitingRequestDeltas === 0) return;
		this.#awaitingRequestDeltas -= 1;
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

	retryPersistence(): boolean {
		if (this.#closed) return false;
		if (!this.#persistenceDirty) return true;
		return this.#persistCurrent("retry");
	}

	abortCurrentUpdate(): void {
		this.#activeController?.abort();
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

	/**
	 * Abort active work and wait for its update callback to settle so final usage can be recorded.
	 * If the updater ignores abort and never settles, shutdown remains pending.
	 */
	shutdown(): Promise<void> {
		if (this.#shutdownPromise) return this.#shutdownPromise;
		this.#closed = true;
		this.#clearTimers();
		this.#activeController?.abort();
		if (this.#persistenceDirty) this.#persistCurrent("shutdown");
		this.#bufferedDeltas.clear();
		this.#pendingDeltas.clear();
		this.#shutdownPromise = this.#dispatchPromise ?? Promise.resolve();
		return this.#shutdownPromise;
	}

	#collectDeltas(): void {
		if (this.#closed || this.#bufferedDeltas.size === 0) return;
		for (const delta of this.#bufferedDeltas.values()) {
			if (!this.state.matchesScope(delta.scope) || this.#ownEntryIds.has(delta.entryId)) continue;
			this.#pendingDeltas.delete(delta.entryId);
			this.#pendingDeltas.set(delta.entryId, delta);
		}
		this.#bufferedDeltas.clear();
	}

	#runModelWindow(): void {
		if (this.#closed) return;
		this.#collectDeltas();
		if (this.#running || this.#awaitingRequestDeltas > 0 || this.#pendingDeltas.size === 0) return;
		if (this.#persistenceDirty && !this.#persistCurrent("retry")) return;

		const changes = [...this.#pendingDeltas.values()];
		this.#pendingDeltas.clear();
		this.#inFlightChanges = changes;
		const snapshot = this.state.snapshot;
		const capture = this.state.capture();
		const request: TodoModelRequest = {
			changes: changes.map(({ entryId, kind, summary }) => ({ entryId, kind, summary })),
			currentTodo: snapshot.items.map(({ id, title, status }) => ({ id, title, status })),
		};
		const controller = new AbortController();
		this.#activeController = controller;
		this.#running = true;
		const dispatch = this.#dispatch(request, capture, changes, controller);
		let tracked: Promise<void>;
		tracked = dispatch.finally(() => {
			if (this.#dispatchPromise === tracked) this.#dispatchPromise = undefined;
		});
		this.#dispatchPromise = tracked;
	}

	async #dispatch(
		request: TodoModelRequest,
		capture: TodoCapture,
		changes: TodoChangeDelta[],
		controller: AbortController,
	): Promise<void> {
		try {
			const response = await this.#updateModel(request, controller.signal);
			if (this.#closed || !this.state.matchesScope(capture)) return;
			if (controller.signal.aborted) {
				this.#requeue(changes);
				return;
			}
			this.#inFlightChanges = [];
			this.#applyModelResult({ capture, changes, response });
		} catch {
			if (this.#closed || !this.state.matchesScope(capture)) return;
			this.#requeue(changes);
			if (!controller.signal.aborted)
				this.#notifyError("Background TODO update failed; changes remain queued for the next update window.");
		} finally {
			this.#inFlightChanges = [];
			this.#running = false;
			this.#activeController = undefined;
		}
	}

	#applyModelResult(result: { capture: TodoCapture; changes: TodoChangeDelta[]; response: unknown }): void {
		if (this.#closed || !this.state.matchesScope(result.capture)) return;
		let preview: TodoModelPreview;
		try {
			preview = this.state.previewModelUpdate(result.capture, result.response);
		} catch {
			this.#requeue(result.changes);
			this.#notifyError(
				"Background TODO update could not be prepared; changes remain queued for the next update window.",
			);
			return;
		}
		if (preview.kind === "stale") {
			this.#requeue(result.changes);
			return;
		}
		if (preview.kind === "invalid") {
			this.#requeue(result.changes);
			this.#notifyError(
				"Background TODO update returned invalid data; changes remain queued for the next update window.",
			);
			return;
		}
		if (preview.kind === "unchanged") return;
		if (!this.#appendSnapshot(preview.candidate.snapshot, "model")) {
			this.#requeue(result.changes);
			return;
		}
		if (!this.state.commit(preview.candidate)) {
			this.#persistenceDirty = true;
			this.#requeue(result.changes);
			return;
		}
		this.#notifyUpdated();
	}

	#persistCommitted(snapshot: TodoSnapshot, reason: TodoPersistenceReason): void {
		this.#appendSnapshot(snapshot, reason);
	}

	#persistCurrent(reason: TodoPersistenceReason): boolean {
		return this.#appendSnapshot(this.state.snapshot, reason);
	}

	#appendSnapshot(snapshot: TodoSnapshot, reason: TodoPersistenceReason): boolean {
		this.#persistingDepth += 1;
		try {
			const entryId = this.#appendSessionEntry(structuredClone(snapshot), reason);
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
		for (const delta of changes) {
			if (!this.state.matchesScope(delta.scope) || this.#ownEntryIds.has(delta.entryId)) continue;
			this.#pendingDeltas.delete(delta.entryId);
			this.#pendingDeltas.set(delta.entryId, delta);
		}
	}

	#invalidateForScopeChange(): void {
		this.#activeController?.abort();
		this.#bufferedDeltas.clear();
		this.#pendingDeltas.clear();
		this.#ownEntryIds.clear();
		this.#persistenceDirty = false;
		this.#awaitingRequestDeltas = 0;
	}

	#clearTimers(): void {
		clearInterval(this.#checkTimer);
		clearInterval(this.#modelTimer);
	}
}
