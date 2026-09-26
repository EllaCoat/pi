import { DatabaseSync } from "node:sqlite";

export type MemoryRole = "user" | "assistant" | "tool";
export type MemoryOutcome = "completed" | "failed" | "unverified";
export type MemoryOrigin = "session" | "tool" | "derived-recall";

/** A finalized, normalized SessionManager record. The session log remains authoritative. */
export interface MemorySourceRecord {
	readonly sessionId: string;
	readonly branchId: string;
	readonly entryId: string;
	readonly sourceRevision: string;
	readonly ordinal: number;
	readonly role: MemoryRole;
	readonly origin: MemoryOrigin;
	readonly content: string;
	readonly timestamp?: string;
	readonly outcome?: MemoryOutcome;
}

export interface MemorySourceRef {
	readonly sessionId: string;
	readonly branchId: string;
	readonly entryId: string;
	readonly sourceRevision: string;
}

export interface MemoryScope {
	readonly sessionId?: string;
	readonly branchId?: string;
	/** Search pages are deliberately small so callers can inspect omitted candidates explicitly. */
	readonly limit?: number;
	readonly offset?: number;
}

export interface MemoryRange {
	readonly start: number;
	readonly end: number;
}

export interface MemoryExcerpt extends MemorySourceRef {
	readonly kind: "source" | "correction";
	readonly role: MemoryRole;
	readonly outcome: MemoryOutcome;
	readonly timestamp?: string;
	readonly excerpt: string;
	/** Offsets are UTF-16 code-unit offsets in the sanitized SQLite text, not raw JSONL bytes. */
	readonly range: MemoryRange;
	readonly totalCharacters: number;
	readonly redacted: boolean;
	readonly omittedBeforeCharacters: number;
	readonly omittedAfterCharacters: number;
	readonly correctionReason?: string;
}

export interface MemorySearchResult {
	readonly status: "matches" | "empty" | "sensitive-query" | "query-too-broad";
	readonly query: string;
	readonly generation: number;
	readonly candidates: readonly MemoryExcerpt[];
	readonly totalCandidates: number;
	readonly nextOffset?: number;
}

export interface MemoryIndexResult {
	readonly inserted: number;
	readonly updated: number;
	readonly skipped: number;
	readonly redacted: number;
	readonly generation: number;
}

export interface MemoryReadResult {
	readonly status: "ready" | "not-found" | "stale" | "excluded";
	readonly reference: MemorySourceRef;
	readonly range?: MemoryRange;
	readonly content?: string;
	readonly totalCharacters?: number;
	readonly redacted?: boolean;
	readonly generation: number;
}

export interface MemoryCitation extends MemorySourceRef {
	readonly kind: "source" | "correction";
	readonly range: MemoryRange;
}

export interface CuratedMemory {
	readonly text: string;
	readonly citations: readonly MemoryCitation[];
}

export type MemoryCurator = (
	query: string,
	records: readonly MemoryExcerpt[],
	signal: AbortSignal,
) => Promise<CuratedMemory>;

export interface MemoryDirectiveResult {
	readonly generation: number;
	readonly changed: boolean;
}

interface SourceRow {
	readonly id: number;
	readonly session_id: string;
	readonly branch_id: string;
	readonly entry_id: string;
	readonly source_revision: string;
	readonly ordinal: number;
	readonly role: MemoryRole;
	readonly outcome: MemoryOutcome;
	readonly content: string;
	readonly timestamp: string | null;
	readonly redacted: number;
}

interface DirectiveRow {
	readonly id: number;
	readonly session_id: string;
	readonly branch_id: string;
	readonly entry_id: string;
	readonly source_revision: string;
	readonly action: "exclude" | "correct" | "include";
	readonly reason: string;
	readonly correction: string | null;
	readonly updated_at: string;
	readonly redacted: number;
}

interface SearchIdRow {
	readonly id: number;
	readonly rank: number;
	readonly kind: "source" | "correction";
}

interface SearchRow {
	readonly id: number;
	readonly session_id: string;
	readonly branch_id: string;
	readonly entry_id: string;
	readonly source_revision: string;
	readonly ordinal: number | null;
	readonly role: MemoryRole | null;
	readonly outcome: MemoryOutcome | null;
	readonly content: string;
	readonly timestamp: string | null;
	readonly redacted: number;
	readonly correction_reason: string | null;
	readonly kind: "source" | "correction";
	readonly rank: number;
}

interface RedactedText {
	readonly text: string;
	readonly changed: boolean;
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS memory_meta (
		key TEXT PRIMARY KEY,
		value INTEGER NOT NULL
	) STRICT;
	INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('generation', 0);
	CREATE TABLE IF NOT EXISTS memory_sources (
		id INTEGER PRIMARY KEY,
		session_id TEXT NOT NULL,
		branch_id TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		source_revision TEXT NOT NULL,
		ordinal INTEGER NOT NULL,
		role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
		outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'unverified')),
		content TEXT NOT NULL,
		timestamp TEXT,
		redacted INTEGER NOT NULL CHECK (redacted IN (0, 1)),
		UNIQUE (session_id, entry_id)
	) STRICT;
	CREATE VIRTUAL TABLE IF NOT EXISTS memory_source_fts USING fts5(searchable, tokenize='unicode61 remove_diacritics 2');
	CREATE TABLE IF NOT EXISTS memory_source_memberships (
		source_id INTEGER NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
		branch_id TEXT NOT NULL,
		PRIMARY KEY (source_id, branch_id)
	) STRICT;
	CREATE TABLE IF NOT EXISTS memory_directives (
		id INTEGER PRIMARY KEY,
		session_id TEXT NOT NULL,
		branch_id TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		source_revision TEXT NOT NULL,
		action TEXT NOT NULL CHECK (action IN ('exclude', 'correct', 'include')),
		reason TEXT NOT NULL,
		correction TEXT,
		updated_at TEXT NOT NULL,
		redacted INTEGER NOT NULL CHECK (redacted IN (0, 1)),
		UNIQUE (session_id, entry_id)
	) STRICT;
	CREATE VIRTUAL TABLE IF NOT EXISTS memory_directive_fts USING fts5(searchable, tokenize='unicode61 remove_diacritics 2');
`;

const MAX_QUERY_CHARACTERS = 512;
const MAX_QUERY_TERMS = 96;
const MAX_PAGE_SIZE = 3;
const MAX_OFFSET = 500;
const MAX_EXCERPT_CHARACTERS = 2_500;
const MAX_READ_CHARACTERS = 16_000;
const BUSY_TIMEOUT_MS = 5_000;

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/giu;
const BEARER_SECRET = /\bBearer[ \t]+(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:\\.|[^"'\r\n,;}\]])+)/giu;
const TOKEN_SECRET =
	/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/giu;
const SECRET_ASSIGNMENT =
	/(["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|session[_-]?cookie|client[_-]?secret|secret|password|passwd|private[_-]?key)\b["']?\s*[:=]\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\[(?:\s*"(?:\\.|[^"\\])*"\s*,?)*\s*\])|([^\s,;}"'\]\r\n]+))/giu;
const URL_SECRET = /([?&](?:token|key|password|secret|code)=)[^&#\s]+/giu;
const TOKEN_PARTS =
	/[\p{Script=Latin}\p{N}_$]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{Script=Greek}\p{Script=Cyrillic}]+/gu;
const CJK_PART = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

export function redactSensitiveText(value: string): RedactedText {
	let changed = false;
	let text = value.replace(PRIVATE_KEY, () => {
		changed = true;
		return "[REDACTED PRIVATE KEY]";
	});
	text = text.replace(
		/(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/giu,
		(_match, label: string) => {
			changed = true;
			return `${label}[REDACTED HEADER]`;
		},
	);
	text = text.replace(BEARER_SECRET, () => {
		changed = true;
		return "Bearer [REDACTED]";
	});
	text = text.replace(TOKEN_SECRET, () => {
		changed = true;
		return "[REDACTED TOKEN]";
	});
	text = text.replace(
		SECRET_ASSIGNMENT,
		(
			_match,
			label: string,
			doubleQuoted: string | undefined,
			singleQuoted: string | undefined,
			arrayValue: string | undefined,
		) => {
			changed = true;
			if (arrayValue !== undefined) return `${label}["[REDACTED]"]`;
			if (doubleQuoted !== undefined) return `${label}"[REDACTED]"`;
			if (singleQuoted !== undefined) return `${label}'[REDACTED]'`;
			return `${label}[REDACTED]`;
		},
	);
	text = text.replace(URL_SECRET, (_match, label: string) => {
		changed = true;
		return `${label}[REDACTED]`;
	});
	return { text, changed };
}

function tokenize(value: string, splitIdentifiers = true): string[] {
	const normalized = value.normalize("NFKC");
	const tokens = new Set<string>();
	for (const match of normalized.matchAll(TOKEN_PARTS)) {
		const rawPart = match[0];
		const part = rawPart.toLocaleLowerCase("und");
		if (CJK_PART.test(part)) {
			const characters = Array.from(part);
			if (characters.length === 1) tokens.add(part);
			for (let index = 0; index < characters.length - 1; index++) {
				tokens.add(characters[index] + characters[index + 1]);
			}
			continue;
		}

		tokens.add(part);
		if (splitIdentifiers) {
			const splitIdentifier = rawPart
				.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
				.replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2");
			for (const piece of splitIdentifier.split(/[_$\s]+/u)) {
				if (piece) tokens.add(piece.toLocaleLowerCase("und"));
			}
		}
	}
	return [...tokens];
}

function buildFtsQuery(tokens: readonly string[]): string {
	return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function validateText(value: unknown, label: string, maxCharacters = 512): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxCharacters) {
		throw new TypeError(`Memory ${label} must be a non-empty string of at most ${maxCharacters} characters`);
	}
}
function validateSafeText(value: unknown, label: string, maxCharacters = 512): asserts value is string {
	validateText(value, label, maxCharacters);
	if (redactSensitiveText(value).changed) {
		throw new TypeError(`Memory ${label} must not contain a recognized credential-shaped value`);
	}
}

function validateReference(reference: MemorySourceRef): void {
	validateSafeText(reference.sessionId, "session ID", 128);
	validateSafeText(reference.branchId, "branch ID", 128);
	validateSafeText(reference.entryId, "entry ID", 128);
	validateSafeText(reference.sourceRevision, "source revision", 128);
}

function validateScope(scope: MemoryScope): { readonly limit: number; readonly offset: number } {
	if (scope.sessionId !== undefined) validateSafeText(scope.sessionId, "scope session ID", 128);
	if (scope.branchId !== undefined) validateSafeText(scope.branchId, "scope branch ID", 128);
	const limit = scope.limit ?? MAX_PAGE_SIZE;
	const offset = scope.offset ?? 0;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
		throw new RangeError(`Memory page size must be between 1 and ${MAX_PAGE_SIZE}`);
	}
	if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
		throw new RangeError(`Memory offset must be between 0 and ${MAX_OFFSET}`);
	}
	return { limit, offset };
}

function getSafeId(rowId: number | bigint): number {
	const id = Number(rowId);
	if (!Number.isSafeInteger(id) || id < 1) throw new Error("SQLite returned an unsafe memory record ID");
	return id;
}

function generationFromRow(row: Record<string, number | bigint | string> | undefined): number {
	const generation = row?.generation;
	if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
		throw new Error("SQLite memory generation is invalid");
	}
	return generation;
}

function excerptRange(content: string, query: string): MemoryRange {
	const length = content.length;
	if (length <= MAX_EXCERPT_CHARACTERS) return { start: 0, end: length };

	const lowerContent = content.toLocaleLowerCase("und");
	const offsets = tokenize(query, false)
		.map((term) => lowerContent.indexOf(term))
		.filter((offset) => offset >= 0);
	const matchOffset = offsets.length > 0 ? Math.min(...offsets) : 0;
	let start = Math.max(
		0,
		Math.min(matchOffset - Math.floor(MAX_EXCERPT_CHARACTERS / 3), length - MAX_EXCERPT_CHARACTERS),
	);
	let end = Math.min(length, start + MAX_EXCERPT_CHARACTERS);
	if (start > 0 && /[\uDC00-\uDFFF]/u.test(content[start] ?? "")) start++;
	if (end < length && /[\uD800-\uDBFF]/u.test(content[end - 1] ?? "")) end--;
	return { start, end };
}

function toExcerpt(row: SearchRow, query: string): MemoryExcerpt {
	const redactedContent = row.content;
	const range = excerptRange(redactedContent, query);
	const base: MemoryExcerpt = {
		sessionId: row.session_id,
		branchId: row.branch_id,
		entryId: row.entry_id,
		sourceRevision: row.source_revision,
		kind: row.kind,
		role: row.role ?? "user",
		outcome: row.outcome ?? "unverified",
		...(row.timestamp ? { timestamp: row.timestamp } : {}),
		excerpt: redactedContent.slice(range.start, range.end),
		range,
		totalCharacters: redactedContent.length,
		redacted: row.redacted === 1,
		omittedBeforeCharacters: range.start,
		omittedAfterCharacters: redactedContent.length - range.end,
	};
	return row.kind === "correction" && row.correction_reason !== null
		? { ...base, correctionReason: row.correction_reason }
		: base;
}

function isValidOutcome(value: unknown): value is MemoryOutcome {
	return value === "completed" || value === "failed" || value === "unverified";
}

function isValidRole(value: unknown): value is MemoryRole {
	return value === "user" || value === "assistant" || value === "tool";
}

function sourceIdentity(reference: MemorySourceRef): readonly [string, string] {
	return [reference.sessionId, reference.entryId];
}

/** SQLite-backed source index and persistent correction/exclusion state. */
export class MemoryIndex {
	readonly #database: DatabaseSync;

	constructor(databasePath: string) {
		validateText(databasePath, "database path", 4_096);
		this.#database = new DatabaseSync(databasePath, { timeout: BUSY_TIMEOUT_MS });
		try {
			this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
			this.#database.exec(SCHEMA);
		} catch (error) {
			this.#database.close();
			throw error;
		}
	}

	get generation(): number {
		this.#assertOpen();
		return this.#readGeneration();
	}

	index(records: readonly MemorySourceRecord[]): MemoryIndexResult {
		this.#assertOpen();
		let inserted = 0;
		let updated = 0;
		let skipped = 0;
		let redacted = 0;
		let changed = false;
		this.#database.exec("BEGIN IMMEDIATE;");
		try {
			for (const record of records) {
				if (record.origin === "derived-recall") {
					skipped++;
					continue;
				}
				const indexed = this.#indexRecord(record);
				if (indexed.action === "inserted") inserted++;
				else if (indexed.action === "updated") updated++;
				else skipped++;
				if (indexed.redacted) redacted++;
				if (indexed.action !== "skipped") changed = true;
			}
			if (changed) this.#bumpGeneration();
			this.#database.exec("COMMIT;");
		} catch (error) {
			this.#rollback();
			throw error;
		}
		return { inserted, updated, skipped, redacted, generation: this.#readGeneration() };
	}

	rebuild(records: readonly MemorySourceRecord[]): MemoryIndexResult {
		this.#assertOpen();
		let inserted = 0;
		let updated = 0;
		let skipped = 0;
		let redacted = 0;
		this.#database.exec("BEGIN IMMEDIATE;");
		try {
			this.#database.exec(`
				CREATE TEMP TABLE IF NOT EXISTS memory_rebuild_origins (
					session_id TEXT NOT NULL,
					entry_id TEXT NOT NULL,
					branch_id TEXT NOT NULL,
					PRIMARY KEY (session_id, entry_id)
				) STRICT;
				DELETE FROM temp.memory_rebuild_origins;
				INSERT INTO temp.memory_rebuild_origins (session_id, entry_id, branch_id)
					SELECT session_id, entry_id, branch_id FROM memory_sources;
				DELETE FROM memory_source_fts;
				DELETE FROM memory_sources;
			`);
			const previousOrigin = this.#database.prepare(
				"SELECT branch_id FROM temp.memory_rebuild_origins WHERE session_id = ? AND entry_id = ?",
			);
			for (const record of records) {
				if (record.origin === "derived-recall") {
					skipped++;
					continue;
				}
				const origin = previousOrigin.get(record.sessionId, record.entryId) as
					| { readonly branch_id: string }
					| undefined;
				const indexed = this.#indexRecord(record, origin?.branch_id ?? record.branchId);
				if (indexed.action === "inserted") inserted++;
				else if (indexed.action === "updated") updated++;
				else skipped++;
				if (indexed.redacted) redacted++;
			}
			this.#bumpGeneration();
			this.#database.exec("COMMIT;");
		} catch (error) {
			this.#rollback();
			throw error;
		}
		return { inserted, updated, skipped, redacted, generation: this.#readGeneration() };
	}

	search(query: string, scope: MemoryScope = {}): MemorySearchResult {
		this.#assertOpen();
		validateText(query, "query", MAX_QUERY_CHARACTERS);
		const page = validateScope(scope);
		const sanitized = redactSensitiveText(query);
		if (sanitized.changed) {
			return {
				status: "sensitive-query",
				query: sanitized.text,
				generation: this.#readGeneration(),
				candidates: [],
				totalCandidates: 0,
			};
		}
		const terms = tokenize(sanitized.text, false);
		if (terms.length === 0) {
			return {
				status: "empty",
				query: sanitized.text,
				generation: this.#readGeneration(),
				candidates: [],
				totalCandidates: 0,
			};
		}
		if (terms.length > MAX_QUERY_TERMS) {
			return {
				status: "query-too-broad",
				query: sanitized.text,
				generation: this.#readGeneration(),
				candidates: [],
				totalCandidates: 0,
			};
		}

		const match = buildFtsQuery(terms);
		const scopeFilter = `(? IS NULL OR s.session_id = ?) AND (? IS NULL OR EXISTS (
			SELECT 1 FROM memory_source_memberships AS m WHERE m.source_id = s.id AND m.branch_id = ?
		))`;
		this.#database.exec("BEGIN;");
		try {
			const generation = this.#readGeneration();
			const sourceTotal = this.#countSourceMatches(match, scope);
			const correctionTotal = this.#countCorrectionMatches(match, scope);
			const totalCandidates = sourceTotal + correctionTotal;
			if (totalCandidates === 0 || page.offset >= totalCandidates) {
				this.#database.exec("COMMIT;");
				return {
					status: "empty",
					query: sanitized.text,
					generation,
					candidates: [],
					totalCandidates,
				};
			}

			const fetchCount = page.offset + page.limit;
			const sourceIds = this.#database
				.prepare(
					`SELECT s.id AS id, bm25(memory_source_fts) AS rank, 'source' AS kind
					FROM memory_source_fts
				JOIN memory_sources AS s ON s.id = memory_source_fts.rowid
				LEFT JOIN memory_directives AS d
					ON d.session_id = s.session_id AND d.entry_id = s.entry_id
				WHERE memory_source_fts MATCH ? AND (${scopeFilter})
					AND (d.id IS NULL OR d.action = 'include')
				ORDER BY rank ASC, s.ordinal DESC LIMIT ?`,
				)
				.all(
					match,
					scope.sessionId ?? null,
					scope.sessionId ?? null,
					scope.branchId ?? null,
					scope.branchId ?? null,
					fetchCount,
				) as unknown as SearchIdRow[];
			const correctionIds = this.#database
				.prepare(
					`SELECT d.id AS id, bm25(memory_directive_fts) AS rank, 'correction' AS kind
					FROM memory_directive_fts
					JOIN memory_directives AS d ON d.id = memory_directive_fts.rowid
					JOIN memory_sources AS s ON s.session_id = d.session_id AND s.entry_id = d.entry_id
					WHERE memory_directive_fts MATCH ? AND d.action = 'correct'
						AND (${scopeFilter})
					ORDER BY rank ASC, d.updated_at DESC LIMIT ?`,
				)
				.all(
					match,
					scope.sessionId ?? null,
					scope.sessionId ?? null,
					scope.branchId ?? null,
					scope.branchId ?? null,
					fetchCount,
				) as unknown as SearchIdRow[];
			const selected = [...sourceIds, ...correctionIds]
				.sort(
					(left, right) =>
						left.rank - right.rank || (left.kind === right.kind ? 0 : left.kind === "correction" ? -1 : 1),
				)
				.slice(page.offset, page.offset + page.limit);
			const candidates = selected.map((item) => {
				const row = this.#readSearchRow(item);
				if (!row) throw new Error("SQLite memory index changed inside a read transaction");
				return toExcerpt(row, sanitized.text);
			});
			this.#database.exec("COMMIT;");
			return {
				status: candidates.length > 0 ? "matches" : "empty",
				query: sanitized.text,
				generation,
				candidates,
				totalCandidates,
				...(page.offset + candidates.length < totalCandidates
					? { nextOffset: page.offset + candidates.length }
					: {}),
			};
		} catch (error) {
			this.#rollback();
			throw error;
		}
	}

	readSource(reference: MemorySourceRef, range: MemoryRange): MemoryReadResult {
		this.#assertOpen();
		validateReference(reference);
		if (
			!Number.isInteger(range.start) ||
			!Number.isInteger(range.end) ||
			range.start < 0 ||
			range.end < range.start ||
			range.end - range.start > MAX_READ_CHARACTERS
		) {
			throw new RangeError(`Memory reads must request a valid range of at most ${MAX_READ_CHARACTERS} characters`);
		}
		const generation = this.#readGeneration();
		const row = this.#database
			.prepare(
				`SELECT source_revision, content, redacted FROM memory_sources
				WHERE session_id = ? AND entry_id = ?`,
			)
			.get(...sourceIdentity(reference)) as
			| { readonly source_revision: string; readonly content: string; readonly redacted: number }
			| undefined;
		if (!row) return { status: "not-found", reference, generation };
		if (row.source_revision !== reference.sourceRevision) return { status: "stale", reference, generation };
		const directive = this.#database
			.prepare("SELECT action FROM memory_directives WHERE session_id = ? AND entry_id = ?")
			.get(...sourceIdentity(reference)) as { readonly action: string } | undefined;
		if (directive?.action === "exclude" || directive?.action === "correct") {
			return { status: "excluded", reference, generation };
		}
		if (range.start > row.content.length || range.end > row.content.length) {
			throw new RangeError("Memory read range is outside the indexed source text");
		}
		return {
			status: "ready",
			reference,
			range,
			content: row.content.slice(range.start, range.end),
			totalCharacters: row.content.length,
			redacted: row.redacted === 1,
			generation,
		};
	}

	exclude(reference: MemorySourceRef, reason: string): MemoryDirectiveResult {
		return this.#setDirective(reference, "exclude", reason, null);
	}

	correct(reference: MemorySourceRef, correction: string, reason = "User correction"): MemoryDirectiveResult {
		validateText(correction, "correction", 64_000);
		const sanitized = redactSensitiveText(correction);
		if (sanitized.text.trim().length === 0)
			throw new TypeError("Memory correction must contain text after redaction");
		return this.#setDirective(reference, "correct", reason, sanitized.text, sanitized.changed);
	}

	include(reference: MemorySourceRef, reason = "Source restored"): MemoryDirectiveResult {
		return this.#setDirective(reference, "include", reason, null);
	}

	close(): void {
		if (this.#database.isOpen) this.#database.close();
	}

	#validateRecord(record: MemorySourceRecord): void {
		validateSafeText(record.sessionId, "session ID", 128);
		validateSafeText(record.branchId, "branch ID", 128);
		validateSafeText(record.entryId, "entry ID", 128);
		validateSafeText(record.sourceRevision, "source revision", 128);
		if (!Number.isSafeInteger(record.ordinal) || record.ordinal < 0)
			throw new TypeError("Memory ordinal must be a non-negative safe integer");
		if (!isValidRole(record.role)) throw new TypeError("Memory role must be user, assistant, or tool");
		if (record.origin !== "session" && record.origin !== "tool")
			throw new TypeError("Memory source origin is invalid");
		if (typeof record.content !== "string") throw new TypeError("Memory source content must be text");
		if (record.timestamp !== undefined) validateSafeText(record.timestamp, "timestamp", 128);
		if (record.outcome !== undefined && !isValidOutcome(record.outcome))
			throw new TypeError("Memory outcome is invalid");
	}

	#indexRecord(
		record: MemorySourceRecord,
		sourceBranchId = record.branchId,
	): { readonly action: "inserted" | "updated" | "skipped"; readonly redacted: boolean } {
		this.#validateRecord(record);
		const sanitized = redactSensitiveText(record.content);
		const searchable = tokenize(sanitized.text).join(" ");
		const existing = this.#database
			.prepare(
				`SELECT id, source_revision, ordinal, role, outcome, content, timestamp, redacted
				FROM memory_sources WHERE session_id = ? AND entry_id = ?`,
			)
			.get(record.sessionId, record.entryId) as
			| Pick<
					SourceRow,
					"id" | "source_revision" | "ordinal" | "role" | "outcome" | "content" | "timestamp" | "redacted"
			  >
			| undefined;
		const outcome = record.outcome ?? "unverified";
		const timestamp = record.timestamp ?? null;
		const sourceUnchanged =
			existing !== undefined &&
			existing.source_revision === record.sourceRevision &&
			existing.ordinal === record.ordinal &&
			existing.role === record.role &&
			existing.outcome === outcome &&
			existing.content === sanitized.text &&
			existing.timestamp === timestamp &&
			existing.redacted === Number(sanitized.changed);
		const id = existing ? getSafeId(existing.id) : undefined;
		const hasMembership =
			id !== undefined &&
			this.#database
				.prepare("SELECT 1 FROM memory_source_memberships WHERE source_id = ? AND branch_id = ?")
				.get(id, record.branchId) !== undefined;
		if (sourceUnchanged && hasMembership) return { action: "skipped", redacted: sanitized.changed };

		let sourceId: number;
		if (existing) {
			sourceId = getSafeId(existing.id);
			if (!sourceUnchanged) {
				this.#database.prepare("DELETE FROM memory_source_fts WHERE rowid = ?").run(sourceId);
				this.#database
					.prepare(
						`UPDATE memory_sources SET source_revision = ?, ordinal = ?, role = ?, outcome = ?, content = ?, timestamp = ?, redacted = ?
						WHERE id = ?`,
					)
					.run(
						record.sourceRevision,
						record.ordinal,
						record.role,
						outcome,
						sanitized.text,
						timestamp,
						Number(sanitized.changed),
						sourceId,
					);
				this.#database
					.prepare("INSERT INTO memory_source_fts (rowid, searchable) VALUES (?, ?)")
					.run(sourceId, searchable);
			}
		} else {
			const result = this.#database
				.prepare(
					`INSERT INTO memory_sources
					(session_id, branch_id, entry_id, source_revision, ordinal, role, outcome, content, timestamp, redacted)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					record.sessionId,
					sourceBranchId,
					record.entryId,
					record.sourceRevision,
					record.ordinal,
					record.role,
					outcome,
					sanitized.text,
					timestamp,
					Number(sanitized.changed),
				);
			sourceId = getSafeId(result.lastInsertRowid);
			this.#database
				.prepare("INSERT INTO memory_source_fts (rowid, searchable) VALUES (?, ?)")
				.run(sourceId, searchable);
		}
		if (!hasMembership) {
			this.#database
				.prepare("INSERT INTO memory_source_memberships (source_id, branch_id) VALUES (?, ?)")
				.run(sourceId, record.branchId);
		}
		return { action: existing ? "updated" : "inserted", redacted: sanitized.changed };
	}

	#setDirective(
		reference: MemorySourceRef,
		action: "exclude" | "correct" | "include",
		reason: string,
		correction: string | null,
		correctionRedacted = false,
	): MemoryDirectiveResult {
		this.#assertOpen();
		validateReference(reference);
		validateText(reason, "directive reason", 512);
		const safeReason = redactSensitiveText(reason);
		const safeCorrection = correction === null ? null : redactSensitiveText(correction);
		const redacted = safeReason.changed || correctionRedacted || (safeCorrection?.changed ?? false);
		this.#database.exec("BEGIN IMMEDIATE;");
		try {
			const current = this.#database
				.prepare("SELECT source_revision FROM memory_sources WHERE session_id = ? AND entry_id = ?")
				.get(...sourceIdentity(reference)) as { readonly source_revision: string } | undefined;
			const previous = this.#database
				.prepare(
					`SELECT id, source_revision, action, reason, correction, updated_at, redacted
					FROM memory_directives WHERE session_id = ? AND entry_id = ?`,
				)
				.get(...sourceIdentity(reference)) as
				| Omit<DirectiveRow, "session_id" | "branch_id" | "entry_id">
				| undefined;
			if (current && current.source_revision !== reference.sourceRevision) {
				throw new Error("Memory source revision changed; search again before changing its directive");
			}
			if (!current && (!previous || previous.source_revision !== reference.sourceRevision)) {
				throw new Error("Memory source is not indexed at the referenced revision");
			}
			if (
				previous &&
				previous.action === action &&
				previous.reason === safeReason.text &&
				previous.correction === (safeCorrection?.text ?? null) &&
				previous.redacted === Number(redacted)
			) {
				this.#database.exec("COMMIT;");
				return { generation: this.#readGeneration(), changed: false };
			}

			if (previous)
				this.#database.prepare("DELETE FROM memory_directive_fts WHERE rowid = ?").run(getSafeId(previous.id));
			const updatedAt = new Date().toISOString();
			const result = this.#database
				.prepare(
					`INSERT INTO memory_directives
					(session_id, branch_id, entry_id, source_revision, action, reason, correction, updated_at, redacted)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(session_id, entry_id) DO UPDATE SET
					branch_id = excluded.branch_id, source_revision = excluded.source_revision, action = excluded.action, reason = excluded.reason,
					correction = excluded.correction, updated_at = excluded.updated_at, redacted = excluded.redacted
				RETURNING id`,
				)
				.get(
					reference.sessionId,
					reference.branchId,
					reference.entryId,
					reference.sourceRevision,
					action,
					safeReason.text,
					safeCorrection?.text ?? null,
					updatedAt,
					Number(redacted),
				) as { readonly id: number | bigint } | undefined;
			if (!result) throw new Error("SQLite did not return the memory directive ID");
			if (action === "correct" && safeCorrection) {
				this.#database
					.prepare("INSERT INTO memory_directive_fts (rowid, searchable) VALUES (?, ?)")
					.run(getSafeId(result.id), tokenize(safeCorrection.text).join(" "));
			}
			this.#bumpGeneration();
			this.#database.exec("COMMIT;");
			return { generation: this.#readGeneration(), changed: true };
		} catch (error) {
			this.#rollback();
			throw error;
		}
	}

	#countSourceMatches(match: string, scope: MemoryScope): number {
		const row = this.#database
			.prepare(
				`SELECT count(*) AS total FROM memory_source_fts
				JOIN memory_sources AS s ON s.id = memory_source_fts.rowid
				LEFT JOIN memory_directives AS d
					ON d.session_id = s.session_id AND d.entry_id = s.entry_id
				WHERE memory_source_fts MATCH ?
				AND (? IS NULL OR s.session_id = ?) AND (? IS NULL OR EXISTS (
					SELECT 1 FROM memory_source_memberships AS m
					WHERE m.source_id = s.id AND m.branch_id = ?
				))
				AND (d.id IS NULL OR d.action = 'include')`,
			)
			.get(
				match,
				scope.sessionId ?? null,
				scope.sessionId ?? null,
				scope.branchId ?? null,
				scope.branchId ?? null,
			) as { readonly total: number } | undefined;
		return row?.total ?? 0;
	}

	#countCorrectionMatches(match: string, scope: MemoryScope): number {
		const row = this.#database
			.prepare(
				`SELECT count(*) AS total FROM memory_directive_fts
				JOIN memory_directives AS d ON d.id = memory_directive_fts.rowid
				JOIN memory_sources AS s ON s.session_id = d.session_id AND s.entry_id = d.entry_id
				WHERE memory_directive_fts MATCH ? AND d.action = 'correct'
				AND (? IS NULL OR s.session_id = ?) AND (? IS NULL OR EXISTS (
					SELECT 1 FROM memory_source_memberships AS m
					WHERE m.source_id = s.id AND m.branch_id = ?
				))`,
			)
			.get(
				match,
				scope.sessionId ?? null,
				scope.sessionId ?? null,
				scope.branchId ?? null,
				scope.branchId ?? null,
			) as { readonly total: number } | undefined;
		return row?.total ?? 0;
	}

	#readSearchRow(item: SearchIdRow): SearchRow | undefined {
		if (item.kind === "source") {
			const row = this.#database
				.prepare(
					`SELECT s.id, s.session_id, s.branch_id, s.entry_id, s.source_revision, s.ordinal, s.role, s.outcome,
						s.content, s.timestamp, s.redacted, NULL AS correction_reason, 'source' AS kind, ? AS rank
					FROM memory_sources AS s WHERE s.id = ?`,
				)
				.get(item.rank, item.id) as SearchRow | undefined;
			return row;
		}
		const row = this.#database
			.prepare(
				`SELECT d.id, d.session_id, s.branch_id, d.entry_id, d.source_revision, NULL AS ordinal, 'user' AS role,
						'unverified' AS outcome, d.correction AS content, d.updated_at AS timestamp, d.redacted,
					d.reason AS correction_reason, 'correction' AS kind, ? AS rank
				FROM memory_directives AS d
				JOIN memory_sources AS s ON s.session_id = d.session_id AND s.entry_id = d.entry_id
				WHERE d.id = ? AND d.action = 'correct'`,
			)
			.get(item.rank, item.id) as SearchRow | undefined;
		return row;
	}

	#bumpGeneration(): void {
		this.#database.prepare("UPDATE memory_meta SET value = value + 1 WHERE key = 'generation'").run();
	}

	#readGeneration(): number {
		return generationFromRow(
			this.#database.prepare("SELECT value AS generation FROM memory_meta WHERE key = 'generation'").get() as
				| Record<string, number | bigint | string>
				| undefined,
		);
	}

	#rollback(): void {
		if (this.#database.isTransaction) this.#database.exec("ROLLBACK;");
	}

	#assertOpen(): void {
		if (!this.#database.isOpen) throw new Error("SQLite memory index is closed");
	}
}
