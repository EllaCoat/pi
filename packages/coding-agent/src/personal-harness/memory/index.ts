import {
	type CuratedMemory,
	type MemoryCitation,
	type MemoryCurator,
	type MemoryDirectiveResult,
	type MemoryExcerpt,
	MemoryIndex,
	type MemoryIndexResult,
	type MemoryRange,
	type MemoryReadResult,
	type MemoryScope,
	type MemorySearchResult,
	type MemorySourceRecord,
	type MemorySourceRef,
	redactSensitiveText,
} from "./store.ts";

export type {
	CuratedMemory,
	MemoryCitation,
	MemoryCurator,
	MemoryDirectiveResult,
	MemoryExcerpt,
	MemoryIndexResult,
	MemoryOrigin,
	MemoryOutcome,
	MemoryRange,
	MemoryReadResult,
	MemoryRole,
	MemoryScope,
	MemorySearchResult,
	MemorySourceRecord,
	MemorySourceRef,
} from "./store.ts";

export interface PersonalMemoryStoreOptions {
	readonly databasePath: string;
	/** Inject the host's task-adaptive model call. Usage accounting stays with that host. */
	readonly curate?: MemoryCurator;
}

export type MemoryRecallReason =
	| "curated"
	| "curator-unavailable"
	| "curation-failed"
	| "curation-aborted"
	| "sources-changed"
	| "invalid-citations"
	| "output-too-large"
	| "input-too-large"
	| "no-matches"
	| "sensitive-query"
	| "query-too-broad";

export interface MemoryRecallResult {
	readonly status: "curated" | "excerpt" | "empty" | "blocked";
	readonly reason: MemoryRecallReason;
	readonly query: string;
	readonly content: string;
	readonly citations: readonly MemoryCitation[];
	readonly records: readonly MemoryExcerpt[];
	readonly generation: number;
	readonly nextOffset?: number;
}

const MAX_CURATOR_INPUT_CHARACTERS = 12_000;
const MAX_CURATED_CHARACTERS = 1_000;

function citationIsAvailable(citation: MemoryCitation, records: readonly MemoryExcerpt[]): boolean {
	const range = citation?.range;
	if (!range || typeof range !== "object" || !Number.isInteger(range.start) || !Number.isInteger(range.end)) {
		return false;
	}
	return records.some(
		(record) =>
			record.kind === citation.kind &&
			record.sessionId === citation.sessionId &&
			record.branchId === citation.branchId &&
			record.entryId === citation.entryId &&
			record.sourceRevision === citation.sourceRevision &&
			range.start >= record.range.start &&
			range.end > range.start &&
			range.end <= record.range.end,
	);
}

function renderExcerpts(records: readonly MemoryExcerpt[]): string {
	return records
		.map((record, index) => {
			const source = `${record.sessionId}/${record.branchId}/${record.entryId}@${record.sourceRevision}`;
			const label = record.kind === "correction" ? "user correction" : `${record.role}; outcome=${record.outcome}`;
			const range = `sanitized-text UTF-16 characters ${record.range.start}-${record.range.end} of ${record.totalCharacters}`;
			const metadata = [`[${index + 1}] ${label}; ${source}; ${range}`];
			if (record.correctionReason) metadata.push(`Correction note: ${record.correctionReason}`);
			if (record.redacted) metadata.push("Known credential-shaped content was redacted before indexing.");
			if (record.omittedBeforeCharacters > 0 || record.omittedAfterCharacters > 0) {
				metadata.push(
					`Excerpt is incomplete: ${record.omittedBeforeCharacters} characters precede it and ${record.omittedAfterCharacters} follow it; retrieve additional ranges before treating it as complete.`,
				);
			}
			return `${metadata.join("\n")}\n${record.excerpt}`;
		})
		.join("\n\n");
}

/**
 * Public facade for the SQLite search copy and just-in-time recall. The Pi transcript remains
 * authoritative; this store keeps only sanitized text, source provenance, and user directives.
 */
export class PersonalMemoryStore {
	readonly #index: MemoryIndex;
	readonly #curate: MemoryCurator | undefined;

	constructor(options: PersonalMemoryStoreOptions) {
		this.#index = new MemoryIndex(options.databasePath);
		this.#curate = options.curate;
	}

	get generation(): number {
		return this.#index.generation;
	}

	index(records: readonly MemorySourceRecord[]): MemoryIndexResult {
		return this.#index.index(records);
	}

	rebuild(records: readonly MemorySourceRecord[]): MemoryIndexResult {
		return this.#index.rebuild(records);
	}

	search(query: string, scope?: MemoryScope): MemorySearchResult {
		return this.#index.search(query, scope);
	}

	readSource(reference: MemorySourceRef, range: MemoryRange): MemoryReadResult {
		return this.#index.readSource(reference, range);
	}

	exclude(reference: MemorySourceRef, reason: string): MemoryDirectiveResult {
		return this.#index.exclude(reference, reason);
	}

	correct(reference: MemorySourceRef, correction: string, reason?: string): MemoryDirectiveResult {
		return reason === undefined
			? this.#index.correct(reference, correction)
			: this.#index.correct(reference, correction, reason);
	}

	include(reference: MemorySourceRef, reason?: string): MemoryDirectiveResult {
		return reason === undefined ? this.#index.include(reference) : this.#index.include(reference, reason);
	}

	async recall(query: string, scope?: MemoryScope, signal?: AbortSignal): Promise<MemoryRecallResult> {
		const search = this.#index.search(query, scope);
		if (search.status === "sensitive-query" || search.status === "query-too-broad") {
			return {
				status: "blocked",
				reason: search.status,
				query: search.query,
				content: "",
				citations: [],
				records: [],
				generation: search.generation,
			};
		}
		if (search.candidates.length === 0) {
			return {
				status: "empty",
				reason: "no-matches",
				query: search.query,
				content: "",
				citations: [],
				records: [],
				generation: search.generation,
			};
		}
		if (!this.#curate) return this.#excerptResult(search, "curator-unavailable");
		if (signal?.aborted) return this.#currentExcerptResult(search, scope, "curation-aborted");
		if (JSON.stringify({ query: search.query, records: search.candidates }).length > MAX_CURATOR_INPUT_CHARACTERS) {
			return this.#excerptResult(search, "input-too-large");
		}

		const activeSignal = signal ?? new AbortController().signal;
		let curated: CuratedMemory;
		try {
			curated = await this.#curate(search.query, search.candidates, activeSignal);
		} catch {
			return this.#currentExcerptResult(
				search,
				scope,
				activeSignal.aborted ? "curation-aborted" : "curation-failed",
			);
		}
		if (activeSignal.aborted) return this.#currentExcerptResult(search, scope, "curation-aborted");
		if (this.#index.generation !== search.generation) {
			return this.#currentExcerptResult(search, scope, "sources-changed");
		}
		if (typeof curated?.text !== "string" || !Array.isArray(curated.citations) || curated.citations.length === 0) {
			return this.#excerptResult(search, "invalid-citations");
		}
		if (curated.citations.some((citation) => !citationIsAvailable(citation, search.candidates))) {
			return this.#excerptResult(search, "invalid-citations");
		}

		const text = redactSensitiveText(curated.text).text;
		if (text.length === 0) return this.#excerptResult(search, "invalid-citations");
		if (text.length > MAX_CURATED_CHARACTERS) return this.#excerptResult(search, "output-too-large");
		if (this.#index.generation !== search.generation) {
			return this.#currentExcerptResult(search, scope, "sources-changed");
		}
		return {
			status: "curated",
			reason: "curated",
			query: search.query,
			content: text,
			citations: curated.citations,
			records: search.candidates,
			generation: search.generation,
			...(search.nextOffset !== undefined ? { nextOffset: search.nextOffset } : {}),
		};
	}

	close(): void {
		this.#index.close();
	}

	#excerptResult(search: MemorySearchResult, reason: MemoryRecallReason): MemoryRecallResult {
		return {
			status: search.candidates.length > 0 ? "excerpt" : "empty",
			reason,
			query: search.query,
			content: renderExcerpts(search.candidates),
			citations: search.candidates.map((record) => ({
				sessionId: record.sessionId,
				branchId: record.branchId,
				entryId: record.entryId,
				sourceRevision: record.sourceRevision,
				kind: record.kind,
				range: record.range,
			})),
			records: search.candidates,
			generation: search.generation,
			...(search.nextOffset !== undefined ? { nextOffset: search.nextOffset } : {}),
		};
	}
	#currentExcerptResult(
		search: MemorySearchResult,
		scope: MemoryScope | undefined,
		reason: MemoryRecallReason,
	): MemoryRecallResult {
		if (this.#index.generation !== search.generation) {
			return this.#excerptResult(this.#index.search(search.query, scope), "sources-changed");
		}
		return this.#excerptResult(search, reason);
	}
}
