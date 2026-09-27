import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { type MemorySourceRecord, PersonalMemoryStore } from "../../src/personal-harness/memory/index.ts";

const sessionId = "session-transcript-fixture";
const header = {
	type: "session",
	version: 3,
	id: sessionId,
	timestamp: "2026-09-27T20:00:00.000Z",
	cwd: "C:/temporary/pi-fixture",
	parentSession: "parent-session-fixture",
};

function fixtureEntries(): Record<string, unknown>[] {
	return [
		{
			type: "message",
			id: "user-a",
			parentId: null,
			timestamp: "2026-09-27T20:00:01.000Z",
			message: { role: "user", content: "API_KEY=fixture-turn-secret-value explain both branches" },
		},
		{
			type: "message",
			id: "assistant-alpha",
			parentId: "user-a",
			timestamp: "2026-09-27T20:00:02.000Z",
			message: {
				role: "assistant",
				content: "aalphaonly991",
				stopReason: "toolUse",
				toolCall: { name: "lookup", arguments: { credential: "fixture-tool-secret-value" } },
			},
		},
		{
			type: "message",
			id: "tool-alpha",
			parentId: "assistant-alpha",
			timestamp: "2026-09-27T20:00:03.000Z",
			message: { role: "toolResult", toolName: "lookup", content: "toolonly993", isError: false },
		},
		{
			type: "message",
			id: "assistant-beta",
			parentId: "user-a",
			timestamp: "2026-09-27T20:00:04.000Z",
			message: { role: "assistant", content: "bbetaonly992", stopReason: "stop" },
		},
		{
			type: "message",
			id: "user-b",
			parentId: "tool-alpha",
			timestamp: "2026-09-27T20:00:05.000Z",
			message: { role: "user", content: "continue alpha in a new turn" },
		},
		{
			type: "message",
			id: "assistant-next",
			parentId: "user-b",
			timestamp: "2026-09-27T20:00:06.000Z",
			message: { role: "assistant", content: "second turn response", stopReason: "stop" },
		},
	];
}

function jsonl(entries: readonly Record<string, unknown>[]): string {
	return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function withFixture(run: (directory: string, sessionFile: string, databasePath: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "pi-memory-transcript-"));
	const sessionFile = join(directory, "session.jsonl");
	const databasePath = join(directory, "memory.sqlite");
	try {
		writeFileSync(sessionFile, jsonl(fixtureEntries()), "utf8");
		run(directory, sessionFile, databasePath);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function otherSessionRecord(): MemorySourceRecord {
	return {
		sessionId: "other-session-fixture",
		branchId: "other-branch",
		entryId: "other-entry",
		sourceRevision: "other-revision",
		ordinal: 0,
		role: "user",
		origin: "session",
		content: "other-session-preserved-marker",
	};
}

describe("personal harness transcript mirror", () => {
	test("keeps exact JSONL separate from FTS and restores branch-scoped turns after restart", () => {
		withFixture((_directory, sessionFile, databasePath) => {
			const exactJsonl = jsonl(fixtureEntries());
			const memory = new PersonalMemoryStore({ databasePath });
			try {
				const first = memory.syncTranscript(sessionFile, sessionId);
				expect(first).toMatchObject({
					status: "synced",
					inserted: fixtureEntries().length,
					updated: 0,
					skipped: 0,
					deleted: 0,
					processedByteOffset: Buffer.byteLength(exactJsonl, "utf8"),
				});
				expect(memory.search("aalphaonly991", { sessionId, branchId: "assistant-alpha" }).totalCandidates).toBe(0);

				const persisted = new DatabaseSync(databasePath, { readOnly: true });
				try {
					const storedHeader = persisted
						.prepare("SELECT raw_json, processed_byte_offset FROM memory_transcript_headers WHERE session_id = ?")
						.get(sessionId) as { readonly raw_json: string; readonly processed_byte_offset: number };
					expect(storedHeader.raw_json).toBe(JSON.stringify(header));
					expect(storedHeader.processed_byte_offset).toBe(Buffer.byteLength(exactJsonl, "utf8"));
					const storedEntry = persisted
						.prepare(
							"SELECT seq, parent_entry_id, user_turn_id, raw_json FROM memory_transcript_entries WHERE session_id = ? AND entry_id = ?",
						)
						.get(sessionId, "assistant-alpha") as {
						readonly seq: number;
						readonly parent_entry_id: string;
						readonly user_turn_id: string;
						readonly raw_json: string;
					};
					expect(storedEntry).toMatchObject({
						seq: 1,
						parent_entry_id: "user-a",
						user_turn_id: "user-a",
					});
					expect(storedEntry.raw_json).toBe(JSON.stringify(fixtureEntries()[1]));
					expect(storedEntry.raw_json).toContain("fixture-tool-secret-value");
					expect(persisted.prepare("SELECT count(*) AS total FROM memory_sources").get()).toMatchObject({
						total: 0,
					});
				} finally {
					persisted.close();
				}
			} finally {
				memory.close();
			}

			const reopened = new PersonalMemoryStore({ databasePath });
			try {
				const repeated = reopened.syncTranscript(sessionFile, sessionId);
				expect(repeated).toMatchObject({
					status: "synced",
					inserted: 0,
					updated: 0,
					skipped: fixtureEntries().length,
					deleted: 0,
					headerChanged: false,
				});
				reopened.index([otherSessionRecord()]);
				const rebuilt = reopened.rebuildFromTranscript(sessionFile, sessionId);
				expect(rebuilt.status).toBe("rebuilt");
				expect(rebuilt).toMatchObject({
					transcript: { inserted: 0, updated: 0, skipped: fixtureEntries().length, deleted: 0 },
					index: { inserted: 6, updated: 1, skipped: 0 },
				});
				expect(
					reopened
						.search("aalphaonly991", { sessionId, branchId: "assistant-alpha" })
						.candidates.map((row) => row.entryId),
				).toContain("assistant-alpha");
				expect(reopened.search("bbetaonly992", { sessionId, branchId: "assistant-alpha" }).totalCandidates).toBe(0);
				expect(
					reopened.search("bbetaonly992", { sessionId, branchId: "assistant-beta" }).candidates[0]?.entryId,
				).toBe("assistant-beta");
				expect(
					reopened.search("other-session-preserved-marker", { sessionId: "other-session-fixture" })
						.totalCandidates,
				).toBe(1);

				const betaTurn = reopened.readTurn(sessionId, "user-a", "assistant-beta");
				expect(betaTurn.status).toBe("ready");
				expect(betaTurn.entries.map((entry) => entry.entryId)).toEqual(["user-a", "assistant-beta"]);
				expect(JSON.stringify(betaTurn)).not.toContain("fixture-turn-secret-value");
				expect(JSON.stringify(betaTurn)).not.toContain("fixture-tool-secret-value");
				expect(betaTurn.entries[0]?.content).toContain("[REDACTED]");

				const nextTurn = reopened.readTurn(sessionId, "user-a", "assistant-next");
				expect(nextTurn.entries.map((entry) => entry.entryId)).toEqual(["user-a", "assistant-alpha", "tool-alpha"]);
			} finally {
				reopened.close();
			}
		});
	});

	test("preserves corrections and exclusions while rebuilding all branches from JSONL", () => {
		withFixture((_directory, sessionFile, databasePath) => {
			const memory = new PersonalMemoryStore({ databasePath });
			try {
				memory.rebuildFromTranscript(sessionFile, sessionId);
				const alpha = memory.search("aalphaonly991", { sessionId, branchId: "assistant-alpha" }).candidates[0];
				const tool = memory.search("toolonly993", { sessionId, branchId: "assistant-alpha" }).candidates[0];
				expect(alpha?.entryId).toBe("assistant-alpha");
				expect(tool?.entryId).toBe("tool-alpha");
				if (!alpha || !tool) throw new Error("Transcript fixture sources were not indexed");
				memory.correct(alpha, "ccorrectedonly994", "Fixture correction");
				memory.exclude(tool, "Fixture exclusion");

				memory.rebuildFromTranscript(sessionFile, sessionId);
				expect(memory.search("aalphaonly991", { sessionId, branchId: "assistant-alpha" }).totalCandidates).toBe(0);
				expect(
					memory.search("ccorrectedonly994", { sessionId, branchId: "assistant-alpha" }).candidates[0],
				).toMatchObject({ kind: "correction", entryId: "assistant-alpha" });
				expect(memory.search("toolonly993", { sessionId, branchId: "assistant-alpha" }).totalCandidates).toBe(0);
				const turn = memory.readTurn(sessionId, "user-a", "tool-alpha");
				expect(turn.entries.find((entry) => entry.entryId === "assistant-alpha")).toMatchObject({
					contentStatus: "corrected",
					content: "ccorrectedonly994",
				});
				expect(turn.entries.find((entry) => entry.entryId === "tool-alpha")).toMatchObject({
					contentStatus: "excluded",
				});
			} finally {
				memory.close();
			}
		});
	});

	test("does not advance the JSONL position or replace FTS when transcript rebuild fails", () => {
		withFixture((directory, sessionFile, databasePath) => {
			const memory = new PersonalMemoryStore({ databasePath });
			try {
				memory.rebuildFromTranscript(sessionFile, sessionId);
				const before = new DatabaseSync(databasePath, { readOnly: true });
				let previousOffset: number;
				try {
					previousOffset = (
						before
							.prepare("SELECT processed_byte_offset FROM memory_transcript_headers WHERE session_id = ?")
							.get(sessionId) as { readonly processed_byte_offset: number }
					).processed_byte_offset;
				} finally {
					before.close();
				}

				const triggerDb = new DatabaseSync(databasePath);
				try {
					triggerDb.exec(
						"CREATE TRIGGER fail_transcript_fixture BEFORE INSERT ON memory_transcript_entries WHEN NEW.entry_id = 'blocked-entry' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
					);
				} finally {
					triggerDb.close();
				}
				const changedEntries = fixtureEntries().map((entry) => ({ ...entry }));
				changedEntries[0] = {
					...changedEntries[0],
					message: { role: "user", content: "modifiedonly995" },
				};
				changedEntries.push({
					type: "message",
					id: "blocked-entry",
					parentId: "user-a",
					timestamp: "2026-09-27T20:01:00.000Z",
					message: { role: "assistant", content: "never committed" },
				});
				writeFileSync(sessionFile, jsonl(changedEntries), "utf8");
				expect(() => memory.rebuildFromTranscript(sessionFile, sessionId)).toThrow();

				const after = new DatabaseSync(databasePath, { readOnly: true });
				try {
					const headerRow = after
						.prepare("SELECT processed_byte_offset FROM memory_transcript_headers WHERE session_id = ?")
						.get(sessionId) as { readonly processed_byte_offset: number };
					const firstEntry = after
						.prepare("SELECT raw_json FROM memory_transcript_entries WHERE session_id = ? AND entry_id = ?")
						.get(sessionId, "user-a") as { readonly raw_json: string };
					expect(headerRow.processed_byte_offset).toBe(previousOffset);
					expect(firstEntry.raw_json).toBe(JSON.stringify(fixtureEntries()[0]));
					expect(
						after
							.prepare(
								"SELECT count(*) AS total FROM memory_transcript_entries WHERE entry_id = 'blocked-entry'",
							)
							.get(),
					).toMatchObject({
						total: 0,
					});
				} finally {
					after.close();
				}
				expect(memory.search("aalphaonly991", { sessionId, branchId: "assistant-alpha" }).totalCandidates).toBe(1);
				expect(memory.search("modifiedonly995", { sessionId }).totalCandidates).toBe(0);
				const missing = memory.syncTranscript(join(directory, "not-created.jsonl"), sessionId);
				expect(missing).toEqual({ status: "not-persisted", sessionId, reason: "session-file-missing" });
				expect(memory.syncTranscript(undefined, sessionId)).toEqual({
					status: "not-persisted",
					sessionId,
					reason: "session-file-unavailable",
				});
			} finally {
				memory.close();
			}
		});
	});

	test("rolls back raw transcript, FTS rows, offsets, and directives when a transcript FTS rebuild fails", () => {
		withFixture((_directory, sessionFile, databasePath) => {
			const memory = new PersonalMemoryStore({ databasePath });
			try {
				memory.rebuildFromTranscript(sessionFile, sessionId);
				const alpha = memory.search("aalphaonly991", { sessionId, branchId: "assistant-alpha" }).candidates[0];
				const tool = memory.search("toolonly993", { sessionId, branchId: "assistant-alpha" }).candidates[0];
				if (!alpha || !tool) throw new Error("Transcript fixture sources were not indexed");
				memory.correct(alpha, "persistedCorrectionMarker", "Keep the corrected fixture guidance");
				memory.exclude(tool, "Keep the excluded fixture out");
				const previousGeneration = memory.generation;
				const previousOffset = Buffer.byteLength(jsonl(fixtureEntries()), "utf8");

				const triggerDb = new DatabaseSync(databasePath);
				try {
					triggerDb.exec(
						"CREATE TRIGGER fail_transcript_fts_fixture BEFORE INSERT ON memory_source_memberships WHEN NEW.branch_id = 'assistant-beta' BEGIN SELECT RAISE(ABORT, 'fixture FTS rebuild failure'); END;",
					);
				} finally {
					triggerDb.close();
				}
				const changedEntries = fixtureEntries().map((entry) => ({ ...entry }));
				changedEntries[3] = {
					...changedEntries[3],
					message: { role: "assistant", content: "rebuildfailuremarker" },
				};
				writeFileSync(sessionFile, jsonl(changedEntries), "utf8");
				expect(() => memory.rebuildFromTranscript(sessionFile, sessionId)).toThrow(/fixture FTS rebuild failure/u);

				const after = new DatabaseSync(databasePath, { readOnly: true });
				try {
					const headerRow = after
						.prepare("SELECT processed_byte_offset FROM memory_transcript_headers WHERE session_id = ?")
						.get(sessionId) as { readonly processed_byte_offset: number };
					const betaEntry = after
						.prepare("SELECT raw_json FROM memory_transcript_entries WHERE session_id = ? AND entry_id = ?")
						.get(sessionId, "assistant-beta") as { readonly raw_json: string };
					const betaSource = after
						.prepare("SELECT content FROM memory_sources WHERE session_id = ? AND entry_id = ?")
						.get(sessionId, "assistant-beta") as { readonly content: string };
					const directives = after
						.prepare(
							"SELECT entry_id, action, correction FROM memory_directives WHERE session_id = ? ORDER BY entry_id",
						)
						.all(sessionId);
					expect(headerRow.processed_byte_offset).toBe(previousOffset);
					expect(betaEntry.raw_json).toBe(JSON.stringify(fixtureEntries()[3]));
					expect(betaSource.content).toBe("bbetaonly992");
					expect(directives).toEqual([
						{ entry_id: "assistant-alpha", action: "correct", correction: "persistedCorrectionMarker" },
						{ entry_id: "tool-alpha", action: "exclude", correction: null },
					]);
				} finally {
					after.close();
				}

				expect(memory.generation).toBe(previousGeneration);
				expect(
					memory.search("bbetaonly992", { sessionId, branchId: "assistant-beta" }).candidates[0]?.entryId,
				).toBe("assistant-beta");
				expect(memory.search("rebuildfailuremarker", { sessionId }).candidates).toHaveLength(0);
				expect(memory.search("persistedCorrectionMarker", { sessionId }).candidates[0]).toMatchObject({
					kind: "correction",
					entryId: "assistant-alpha",
				});
				expect(memory.search("toolonly993", { sessionId }).candidates).toHaveLength(0);
			} finally {
				memory.close();
			}
		});
	});
});
