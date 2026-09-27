import type { SessionEntry } from "../../core/session-manager.ts";
import { isRecord } from "../hooks/jev-types.ts";

export interface TranscriptSnapshotEntry {
	readonly entryId: string;
	readonly seq: number;
	readonly parentEntryId: string | null;
	readonly userTurnId?: string;
	readonly entryType: string;
	readonly rawJson: string;
	readonly sessionEntry: SessionEntry;
}

export interface TranscriptSnapshot {
	readonly sessionId: string;
	readonly headerJson: string;
	readonly byteLength: number;
	readonly entries: readonly TranscriptSnapshotEntry[];
}

export interface TranscriptSyncStats {
	readonly sessionId: string;
	readonly inserted: number;
	readonly updated: number;
	readonly skipped: number;
	readonly deleted: number;
	readonly headerChanged: boolean;
	readonly processedByteOffset: number;
}

export type TranscriptSyncResult =
	| ({ readonly status: "synced" } & TranscriptSyncStats)
	| {
			readonly status: "not-persisted";
			readonly sessionId: string;
			readonly reason: "session-file-unavailable" | "session-file-missing";
	  };

export interface MemoryTurnEntry {
	readonly entryId: string;
	readonly seq: number;
	readonly parentEntryId: string | null;
	readonly userTurnId?: string;
	readonly entryType: string;
	readonly contentStatus: "available" | "corrected" | "excluded" | "not-indexed";
	readonly role?: "user" | "assistant" | "tool";
	readonly content?: string;
	readonly redacted?: boolean;
	readonly totalCharacters?: number;
	readonly omittedAfterCharacters?: number;
}

export interface MemoryTurnReadResult {
	readonly status: "ready" | "not-found";
	readonly sessionId: string;
	readonly userTurnId: string;
	readonly leafEntryId: string;
	readonly entries: readonly MemoryTurnEntry[];
}

function validateIdentifier(value: unknown, label: string): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 4_096 ||
		/[\u0000-\u001f\u007f]/u.test(value)
	) {
		throw new TypeError(`Invalid session JSONL ${label}`);
	}
}

function parseObject(line: string, lineNumber: number): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
	} catch {
		throw new TypeError(`Invalid session JSONL at line ${lineNumber}`);
	}
	if (!isRecord(parsed)) throw new TypeError(`Invalid session JSONL object at line ${lineNumber}`);
	return parsed;
}

/** Parse a persisted JSONL snapshot; in-memory SessionManager entries are intentionally not accepted. */
export function parseTranscriptSnapshot(contents: string, expectedSessionId: string): TranscriptSnapshot {
	validateIdentifier(expectedSessionId, "expected session ID");
	if (contents.length === 0) throw new TypeError("Session JSONL is empty");
	const lines = contents.split(/\r\n|\n/u);
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0 || lines.some((line) => line.length === 0)) {
		throw new TypeError("Session JSONL contains an empty record");
	}

	const header = parseObject(lines[0] ?? "", 1);
	if (header.type !== "session" || header.id !== expectedSessionId) {
		throw new TypeError("Session JSONL header does not match the expected session ID");
	}
	const entryIds = new Set<string>();
	const userTurnByEntryId = new Map<string, string | undefined>();
	const entries: TranscriptSnapshotEntry[] = [];
	for (let index = 1; index < lines.length; index++) {
		const rawJson = lines[index];
		if (rawJson === undefined) continue;
		const parsed = parseObject(rawJson, index + 1);
		const entryId = parsed.id;
		const entryType = parsed.type;
		validateIdentifier(entryId, `entry ID at line ${index + 1}`);
		validateIdentifier(entryType, `entry type at line ${index + 1}`);
		if (entryType === "session") throw new TypeError(`Unexpected session header at line ${index + 1}`);
		if (entryIds.has(entryId)) throw new TypeError(`Duplicate session entry ID at line ${index + 1}`);
		entryIds.add(entryId);

		let parentEntryId: string | null;
		if (parsed.parentId === null) parentEntryId = null;
		else {
			validateIdentifier(parsed.parentId, `parent entry ID at line ${index + 1}`);
			parentEntryId = parsed.parentId;
		}
		const message = parsed.message;
		const startsUserTurn = entryType === "message" && isRecord(message) && message.role === "user";
		const userTurnId = startsUserTurn
			? entryId
			: parentEntryId === null
				? undefined
				: userTurnByEntryId.get(parentEntryId);
		userTurnByEntryId.set(entryId, userTurnId);
		entries.push({
			entryId,
			seq: index - 1,
			parentEntryId,
			...(userTurnId !== undefined ? { userTurnId } : {}),
			entryType,
			rawJson,
			sessionEntry: parsed as unknown as SessionEntry,
		});
	}

	return {
		sessionId: expectedSessionId,
		headerJson: lines[0] ?? "",
		byteLength: Buffer.byteLength(contents, "utf8"),
		entries,
	};
}
