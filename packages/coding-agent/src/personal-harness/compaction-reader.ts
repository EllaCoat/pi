import { createHash } from "node:crypto";
import type { SessionEntry } from "../core/session-manager.ts";
import { isRecord } from "./hooks/jev-types.ts";
import { type MemorySourceRecord, redactSensitiveText } from "./memory/store.ts";
import { memoryRecordsFromBranch } from "./session-data.ts";

export const COMPACTION_READER_MAX_CHARACTERS = 1_000_000;
const MAX_RANGE_CHARACTERS = 16_000;
const MAX_READ_BATCH = 32;
const MAX_READ_RESPONSE_CHARACTERS = 30_000;
const MAX_LIST_PAGE_SIZE = 80;
const MAX_SEARCH_RESULTS = 20;
const MAX_COVERAGE_RANGES = 40;
const MAX_RECENT_USER_REQUESTS = 8;
const MAX_RECENT_USER_REQUEST_CHARACTERS = 16_000;
const MAX_RECENT_OTHER_MESSAGE_CHARACTERS = 4_000;

export interface CompactionTranscriptReaderOptions {
	readonly sessionId: string;
	readonly branchId: string;
	readonly sessionFile?: string;
	readonly branchEntries: readonly SessionEntry[];
	readonly firstKeptEntryId: string;
}

export interface CompactionRecordRange {
	readonly entryId: string;
	readonly start: number;
	readonly end: number;
}
export interface CompactionUnreadRange {
	readonly fromEntryId: string;
	readonly toEntryId: string;
	readonly fromCharacter: number;
	readonly toCharacter: number;
	readonly characters: number;
}

export interface CompactionReaderCoverage {
	readonly targetEntryCount: number;
	readonly targetTextRecordCount: number;
	readonly fullyReadRecords: number;
	readonly partiallyReadRecords: number;
	readonly unreadRecords: number;
	readonly totalTextCharacters: number;
	readonly uniqueReadCharacters: number;
	readonly unreadCharacters: number;
	readonly cumulativeCharactersReturned: number;
	readonly characterLimit: number;
	readonly remainingCharacterBudget: number;
	readonly unreadRanges: readonly CompactionUnreadRange[];
	readonly additionalUnreadRanges: number;
	readonly nonTextEntryCount: number;
	readonly omittedStructuredData: string;
}

interface ReaderRecord extends Omit<MemorySourceRecord, "role"> {
	readonly role: MemorySourceRecord["role"] | "custom";
	readonly content: string;
	readonly redacted: boolean;
}

interface EntryMetadata {
	readonly ordinal: number;
	readonly entryId: string;
	readonly parentEntryId: string | null;
	readonly timestamp: string;
	readonly entryType: string;
	readonly role?: string;
	readonly customType?: string;
	readonly toolName?: string;
	readonly toolCalls?: readonly string[];
	readonly failed?: boolean;
	readonly textCharacters?: number;
	readonly redacted?: boolean;
}

interface ReadInterval {
	readonly start: number;
	readonly end: number;
}

function sanitized(value: string): string {
	return redactSensitiveText(value).text;
}

function sanitizedJson(value: unknown): string | null {
	if (value === undefined) return null;
	try {
		return sanitized(
			JSON.stringify(value, (_key: string, item: unknown) => (typeof item === "string" ? sanitized(item) : item)) ??
				"null",
		);
	} catch {
		return "[unavailable: value could not be serialized]";
	}
}

function metadataFor(entry: SessionEntry, ordinal: number, record?: ReaderRecord): EntryMetadata {
	const message =
		entry.type === "message" && isRecord(entry.message) ? (entry.message as Record<string, unknown>) : undefined;
	const content = message && Array.isArray(message.content) ? message.content : undefined;
	const toolCalls = content
		?.flatMap((part) =>
			isRecord(part) && part.type === "toolCall" && typeof part.name === "string" ? [sanitized(part.name)] : [],
		)
		.slice(0, 24);
	return {
		ordinal,
		entryId: sanitized(entry.id),
		parentEntryId: entry.parentId ? sanitized(entry.parentId) : null,
		timestamp: sanitized(entry.timestamp),
		entryType: sanitized(entry.type),
		...(message && typeof message.role === "string" ? { role: sanitized(message.role) } : {}),
		...(entry.type === "custom_message" ? { role: "custom", customType: sanitized(entry.customType) } : {}),
		...(message && typeof message.toolName === "string" ? { toolName: sanitized(message.toolName) } : {}),
		...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
		...(message && message.role === "toolResult" && typeof message.isError === "boolean"
			? { failed: message.isError }
			: {}),
		...(record ? { textCharacters: record.content.length, redacted: record.redacted } : {}),
	};
}

function entryFingerprint(entry: SessionEntry): string {
	return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

function excerpt(value: string, limit: number): { text: string; omittedCharacters: number; ranges: ReadInterval[] } {
	if (value.length <= limit) return { text: value, omittedCharacters: 0, ranges: [{ start: 0, end: value.length }] };
	const leading = Math.ceil(limit / 2);
	const trailing = Math.floor(limit / 2);
	return {
		text: `${value.slice(0, leading)}\n[… ${value.length - limit} characters omitted …]\n${trailing > 0 ? value.slice(-trailing) : ""}`,
		omittedCharacters: value.length - limit,
		ranges: [
			{ start: 0, end: leading },
			{ start: value.length - trailing, end: value.length },
		],
	};
}

function combineUsageIntervals(intervals: readonly ReadInterval[], next: ReadInterval): ReadInterval[] {
	const sorted = [...intervals, next].sort((left, right) => left.start - right.start);
	const combined: ReadInterval[] = [];
	for (const interval of sorted) {
		const previous = combined.at(-1);
		if (!previous || interval.start > previous.end) {
			combined.push({ ...interval });
		} else {
			combined[combined.length - 1] = { start: previous.start, end: Math.max(previous.end, interval.end) };
		}
	}
	return combined;
}

function uncoveredIntervals(length: number, covered: readonly ReadInterval[]): ReadInterval[] {
	const missing: ReadInterval[] = [];
	let cursor = 0;
	for (const interval of covered) {
		if (interval.start > cursor) missing.push({ start: cursor, end: interval.start });
		cursor = Math.max(cursor, interval.end);
	}
	if (cursor < length) missing.push({ start: cursor, end: length });
	return missing;
}

export class CompactionTranscriptReader {
	readonly sessionId: string;
	readonly branchId: string;
	readonly firstKeptEntryId: string;
	readonly targetEndEntryId: string | null;
	readonly targetEntryCount: number;
	readonly sourcePath: string | null;
	readonly #entries: readonly SessionEntry[];
	readonly #boundaryIndex: number;
	readonly #metadata: readonly EntryMetadata[];
	readonly #records: readonly ReaderRecord[];
	readonly #recordById: ReadonlyMap<string, ReaderRecord>;
	readonly #targetRecords: readonly ReaderRecord[];
	readonly #fingerprintsThroughBoundary: readonly string[];
	readonly #deliveredRanges = new Map<string, ReadInterval[]>();
	#charactersReturned = 0;

	constructor(options: CompactionTranscriptReaderOptions) {
		this.sessionId = options.sessionId;
		this.branchId = options.branchId;
		this.firstKeptEntryId = options.firstKeptEntryId;
		this.sourcePath = options.sessionFile ? sanitized(options.sessionFile) : null;
		this.#entries = structuredClone(options.branchEntries);
		const boundaryMatches = this.#entries.flatMap((entry, index) =>
			entry.id === options.firstKeptEntryId ? [index] : [],
		);
		if (boundaryMatches.length !== 1) throw new Error("Compaction boundary is missing or ambiguous");
		this.#boundaryIndex = boundaryMatches[0]!;
		this.targetEntryCount = this.#boundaryIndex;
		this.targetEndEntryId = this.#entries[this.#boundaryIndex - 1]?.id ?? null;

		const redactedArguments = new Set<string>();
		const readableEntries = this.#entries.map((entry): SessionEntry => {
			if (entry.type === "custom_message") {
				return {
					...entry,
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: `[Custom message: ${entry.customType}]` },
							...(typeof entry.content === "string" ? [{ type: "text", text: entry.content }] : entry.content),
						],
					},
				} as unknown as SessionEntry;
			}
			if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content))
				return entry;
			return {
				...entry,
				message: {
					...entry.message,
					content: entry.message.content.map((part) => {
						if (part.type !== "toolCall") return part;
						const argumentsText = JSON.stringify(part.arguments, (key: string, value: unknown) => {
							if (key === "thinkingSignature" || key === "encrypted_content") {
								redactedArguments.add(entry.id);
								return "[opaque omitted]";
							}
							if (typeof value !== "string") return value;
							const sanitizedValue = redactSensitiveText(value);
							if (sanitizedValue.changed) redactedArguments.add(entry.id);
							return sanitizedValue.text;
						});
						return {
							type: "text" as const,
							text: `[Tool call: ${part.name}; id: ${part.id}]\n${argumentsText ?? "{}"}`,
						};
					}),
				},
			};
		});
		const sourceRecords = memoryRecordsFromBranch(readableEntries, this.sessionId, this.branchId);
		this.#records = sourceRecords.map((record) => {
			const redaction = redactSensitiveText(record.content);
			return {
				...record,
				role: this.#entries[record.ordinal]?.type === "custom_message" ? ("custom" as const) : record.role,
				content: redaction.text,
				redacted: redaction.changed || redactedArguments.has(record.entryId),
			};
		});
		this.#recordById = new Map(this.#records.map((record) => [record.entryId, record]));
		this.#targetRecords = this.#records.filter((record) => record.ordinal < this.#boundaryIndex);
		this.#metadata = this.#entries.map((entry, ordinal) =>
			metadataFor(entry, ordinal, this.#recordById.get(entry.id)),
		);
		this.#fingerprintsThroughBoundary = this.#entries.map((entry) => entryFingerprint(entry));
	}

	initialContext(input: {
		readonly previousSummary?: string;
		readonly currentGoal?: unknown;
		readonly currentTodo?: unknown;
		readonly customInstructions?: string;
	}): Record<string, unknown> {
		const latestUserRequests = this.#latestContextRecords(
			"user",
			MAX_RECENT_USER_REQUESTS,
			MAX_RECENT_USER_REQUEST_CHARACTERS,
		);
		const recentAssistantAndTools = this.#latestContextRecords(
			"assistant-or-tool",
			12,
			MAX_RECENT_OTHER_MESSAGE_CHARACTERS,
		);
		const typeCounts: Record<string, number> = {};
		const roleCounts: Record<string, number> = {};
		for (const item of this.#metadata.slice(0, this.#boundaryIndex)) {
			typeCounts[item.entryType] = (typeCounts[item.entryType] ?? 0) + 1;
			if (item.role) roleCounts[item.role] = (roleCounts[item.role] ?? 0) + 1;
		}
		return {
			source: {
				kind: "frozen branch-entry snapshot",
				sessionId: sanitized(this.sessionId),
				branchId: sanitized(this.branchId),
				jsonlPathReference: this.sourcePath,
				firstEntryId: this.#metadata[0]?.entryId ?? null,
				targetEndEntryId: this.targetEndEntryId ? sanitized(this.targetEndEntryId) : null,
				firstKeptEntryId: sanitized(this.firstKeptEntryId),
				targetEntryCount: this.targetEntryCount,
				boundary:
					"The target consists only of branch entries before firstKeptEntryId. Later entries remain outside this snapshot.",
			},
			previousSummary: input.previousSummary ? sanitized(input.previousSummary) : null,
			currentGoal: sanitizedJson(input.currentGoal),
			currentTodo: sanitizedJson(input.currentTodo),
			latestUserRequests,
			recentAssistantAndToolMessages: recentAssistantAndTools,
			targetOverview: {
				targetEntries: this.targetEntryCount,
				textRecords: this.#targetRecords.length,
				textCharacters: this.#targetRecords.reduce((total, record) => total + record.content.length, 0),
				entriesByType: typeCounts,
				messagesByRole: roleCounts,
				oldestEntryId: this.#metadata[0]?.entryId ?? null,
				newestTargetEntryId: this.targetEndEntryId ? sanitized(this.targetEndEntryId) : null,
			},
			readOnlyTools: [
				{
					name: "transcript_list",
					purpose: "Page through entry IDs, order, roles, tools, and text lengths for the frozen target.",
				},
				{
					name: "transcript_search",
					purpose: "Search sanitized message text in the frozen target and return short cited excerpts.",
				},
				{
					name: "transcript_read",
					purpose: "Batch-read specified character ranges from sanitized original message text.",
				},
			],
			customInstructions: input.customInstructions?.trim() ? sanitized(input.customInstructions.trim()) : null,
			coverageAtStart: this.coverage(),
		};
	}

	list(input: { readonly offset?: number; readonly limit?: number } = {}): Record<string, unknown> {
		const offset = Number.isSafeInteger(input.offset) && (input.offset ?? 0) >= 0 ? (input.offset ?? 0) : 0;
		const requestedLimit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? (input.limit ?? 40) : 40;
		const limit = Math.min(requestedLimit, MAX_LIST_PAGE_SIZE);
		const items = this.#metadata.slice(offset, Math.min(this.#boundaryIndex, offset + limit));
		return {
			source: this.#sourceReference(),
			target: this.#targetReference(),
			entries: items,
			offset,
			totalEntries: this.#boundaryIndex,
			nextOffset: offset + items.length < this.#boundaryIndex ? offset + items.length : null,
			textContentsNotIncluded: "This is a metadata listing, not evidence that message text was read.",
			coverage: this.coverage(),
		};
	}

	search(input: { readonly query: string; readonly limit?: number }): Record<string, unknown> {
		const queryText = sanitized(input.query);
		if (queryText.length === 0 || queryText.length > 512) {
			return { status: "invalid-query", maximumCharacters: 512, coverage: this.coverage() };
		}
		const requestedLimit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? (input.limit ?? 10) : 10;
		const limit = Math.min(requestedLimit, MAX_SEARCH_RESULTS);
		const matches: Array<{ record: ReaderRecord; start: number; end: number }> = [];
		for (const record of this.#targetRecords) {
			const start = record.content.indexOf(queryText);
			if (start >= 0) matches.push({ record, start, end: start + queryText.length });
		}
		const hits: Array<Record<string, unknown>> = [];
		for (const match of matches.slice(0, limit)) {
			const remaining = Math.max(0, COMPACTION_READER_MAX_CHARACTERS - this.#charactersReturned);
			if (remaining === 0) break;
			const start = Math.max(0, match.start - 240);
			const end = Math.min(match.record.content.length, match.end + 420, start + remaining, start + 900);
			const content = match.record.content.slice(start, end);
			if (!content) break;
			this.#recordDelivery(match.record.entryId, start, end, content.length);
			hits.push({
				entryId: sanitized(match.record.entryId),
				ordinal: match.record.ordinal,
				role: match.record.role,
				outcome: match.record.outcome ?? "unverified",
				toolName: this.#metadata[match.record.ordinal]?.toolName ?? null,
				range: { start, end },
				totalCharacters: match.record.content.length,
				redacted: match.record.redacted,
				excerpt: content,
			});
		}
		return {
			status: "matches",
			source: this.#sourceReference(),
			target: this.#targetReference(),
			query: queryText,
			searchedTextRecords: this.#targetRecords.length,
			matchingRecords: matches.length,
			returnedRecords: hits.length,
			moreRecords: matches.length > hits.length,
			hits,
			coverage: this.coverage(),
		};
	}

	read(input: { readonly entries: readonly CompactionRecordRange[] }): Record<string, unknown> {
		if (input.entries.length === 0 || input.entries.length > MAX_READ_BATCH) {
			return { status: "invalid-batch", maximumEntries: MAX_READ_BATCH, coverage: this.coverage() };
		}
		let batchCharacters = 0;
		const entries: Array<Record<string, unknown>> = [];
		for (const request of input.entries) {
			const record = this.#recordById.get(request.entryId);
			if (!record || record.ordinal >= this.#boundaryIndex) {
				entries.push({ entryId: sanitized(request.entryId), status: "outside-target-or-no-text-record" });
				continue;
			}
			if (
				!Number.isSafeInteger(request.start) ||
				!Number.isSafeInteger(request.end) ||
				request.start < 0 ||
				request.end < request.start ||
				request.end > record.content.length ||
				request.end - request.start > MAX_RANGE_CHARACTERS
			) {
				entries.push({
					entryId: sanitized(request.entryId),
					status: "invalid-range",
					totalCharacters: record.content.length,
				});
				continue;
			}
			const available = Math.min(
				COMPACTION_READER_MAX_CHARACTERS - this.#charactersReturned,
				MAX_READ_RESPONSE_CHARACTERS - batchCharacters,
				request.end - request.start,
			);
			const end = request.start + Math.max(0, available);
			const content = record.content.slice(request.start, end);
			if (content.length > 0) {
				this.#recordDelivery(record.entryId, request.start, end, content.length);
				batchCharacters += content.length;
			}
			entries.push({
				entryId: sanitized(record.entryId),
				ordinal: record.ordinal,
				role: record.role,
				outcome: record.outcome ?? "unverified",
				toolName: this.#metadata[record.ordinal]?.toolName ?? null,
				requestedRange: { start: request.start, end: request.end },
				returnedRange: { start: request.start, end },
				totalCharacters: record.content.length,
				redacted: record.redacted,
				content,
				complete: end === request.end,
				...(end < request.end ? { omittedCharacters: request.end - end } : {}),
			});
		}
		return {
			status: "read",
			source: this.#sourceReference(),
			target: this.#targetReference(),
			entries,
			batchCharacters,
			coverage: this.coverage(),
		};
	}

	coverage(): CompactionReaderCoverage {
		let fullyReadRecords = 0;
		let partiallyReadRecords = 0;
		let unreadRecords = 0;
		let totalTextCharacters = 0;
		let uniqueReadCharacters = 0;
		let unreadCharacters = 0;
		const unread: CompactionUnreadRange[] = [];
		for (const record of this.#targetRecords) {
			const length = record.content.length;
			totalTextCharacters += length;
			const covered = this.#deliveredRanges.get(record.entryId) ?? [];
			const readCharacters = covered.reduce((total, interval) => total + interval.end - interval.start, 0);
			const missing = uncoveredIntervals(length, covered);
			uniqueReadCharacters += readCharacters;
			if (missing.length === 0) fullyReadRecords++;
			else {
				if (readCharacters > 0) partiallyReadRecords++;
				else unreadRecords++;
				for (const interval of missing) {
					unreadCharacters += interval.end - interval.start;
					unread.push({
						fromEntryId: sanitized(record.entryId),
						toEntryId: sanitized(record.entryId),
						fromCharacter: interval.start,
						toCharacter: interval.end,
						characters: interval.end - interval.start,
					});
				}
			}
		}
		return {
			targetEntryCount: this.#boundaryIndex,
			targetTextRecordCount: this.#targetRecords.length,
			fullyReadRecords,
			partiallyReadRecords,
			unreadRecords,
			totalTextCharacters,
			uniqueReadCharacters,
			unreadCharacters,
			cumulativeCharactersReturned: this.#charactersReturned,
			characterLimit: COMPACTION_READER_MAX_CHARACTERS,
			remainingCharacterBudget: Math.max(0, COMPACTION_READER_MAX_CHARACTERS - this.#charactersReturned),
			unreadRanges: unread.slice(0, MAX_COVERAGE_RANGES),
			additionalUnreadRanges: Math.max(0, unread.length - MAX_COVERAGE_RANGES),
			nonTextEntryCount: Math.max(0, this.#boundaryIndex - this.#targetRecords.length),
			omittedStructuredData:
				"Thinking payloads, image pixels, and non-message state payloads are not exposed. Tool-call arguments and custom notices are readable after secret and opaque-value filtering.",
		};
	}

	assertUnchanged(sessionId: string, currentBranch: readonly SessionEntry[]): void {
		if (sessionId !== this.sessionId) throw new Error("Compaction session changed while the summary was generated");
		const boundaryMatches = currentBranch.flatMap((entry, index) =>
			entry.id === this.firstKeptEntryId ? [index] : [],
		);
		if (boundaryMatches.length !== 1 || boundaryMatches[0] !== this.#boundaryIndex) {
			throw new Error("Compaction target boundary changed while the summary was generated");
		}
		for (let index = 0; index < this.#entries.length; index++) {
			const entry = currentBranch[index];
			if (
				!entry ||
				entry.id !== this.#entries[index]?.id ||
				entryFingerprint(entry) !== this.#fingerprintsThroughBoundary[index]
			) {
				throw new Error("Compaction target records changed while the summary was generated");
			}
		}
	}

	#latestContextRecords(
		role: "user" | "assistant-or-tool",
		limit: number,
		characterBudget: number,
	): Array<Record<string, unknown>> {
		const selected = this.#records.filter((record) =>
			role === "user"
				? record.role === "user"
				: record.role === "assistant" || record.role === "tool" || record.role === "custom",
		);
		const recent = selected.slice(-limit).reverse();
		const result: Array<Record<string, unknown>> = [];
		let remaining = characterBudget;
		for (const record of recent) {
			if (remaining <= 0) break;
			const allowance = Math.min(role === "user" ? 4_000 : 450, remaining);
			const snippet = excerpt(record.content, allowance);
			remaining -= snippet.text.length;
			for (const [index, range] of snippet.ranges.entries()) {
				this.#recordDelivery(record.entryId, range.start, range.end, index === 0 ? snippet.text.length : 0);
			}
			result.push({
				entryId: sanitized(record.entryId),
				ordinal: record.ordinal,
				retainedAfterCompactionBoundary: record.ordinal >= this.#boundaryIndex,
				role: record.role,
				outcome: record.outcome ?? "unverified",
				toolName: this.#metadata[record.ordinal]?.toolName ?? null,
				totalCharacters: record.content.length,
				redacted: record.redacted,
				contentExcerpt: snippet.text,
				omittedCharacters: snippet.omittedCharacters,
				shownRanges: snippet.ranges,
			});
		}
		return result.reverse();
	}

	#recordDelivery(entryId: string, start: number, end: number, returnedCharacters: number): void {
		this.#charactersReturned += returnedCharacters;
		if (end <= start) return;
		const record = this.#recordById.get(entryId);
		if (!record || record.ordinal >= this.#boundaryIndex) return;
		this.#deliveredRanges.set(
			entryId,
			combineUsageIntervals(this.#deliveredRanges.get(entryId) ?? [], { start, end }),
		);
	}

	#sourceReference(): Record<string, unknown> {
		return {
			sessionId: sanitized(this.sessionId),
			branchId: sanitized(this.branchId),
			jsonlPathReference: this.sourcePath,
			textRepresentation:
				"Sanitized message text, tool calls, and custom notices; character ranges address this readable representation.",
		};
	}

	#targetReference(): Record<string, unknown> {
		return {
			startEntryId: this.#metadata[0]?.entryId ?? null,
			endEntryId: this.targetEndEntryId ? sanitized(this.targetEndEntryId) : null,
			firstKeptEntryId: sanitized(this.firstKeptEntryId),
			entryCount: this.#boundaryIndex,
		};
	}
}
