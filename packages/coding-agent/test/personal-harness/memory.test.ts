import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import {
	type CuratedMemory,
	type MemoryExcerpt,
	type MemorySourceRecord,
	type MemorySourceRef,
	PersonalMemoryStore,
} from "../../src/personal-harness/memory/index.ts";
import { redactSensitiveText } from "../../src/personal-harness/memory/store.ts";

function makeRecord(overrides: Partial<MemorySourceRecord> = {}): MemorySourceRecord {
	return {
		sessionId: "session-a",
		branchId: "branch-a",
		entryId: "entry-a",
		sourceRevision: "revision-1",
		ordinal: 1,
		role: "user",
		origin: "session",
		content: "Pi SessionManager stores this 日本語コード記憶. DatabaseSync keeps FTS search local.",
		outcome: "unverified",
		...overrides,
	};
}

function referenceOf(record: MemorySourceRecord): MemorySourceRef {
	return {
		sessionId: record.sessionId,
		branchId: record.branchId,
		entryId: record.entryId,
		sourceRevision: record.sourceRevision,
	};
}

async function withDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "pi-personal-memory-"));
	try {
		await run(join(directory, "memory.sqlite"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function citationOf(record: MemoryExcerpt): CuratedMemory["citations"][number] {
	return {
		sessionId: record.sessionId,
		branchId: record.branchId,
		entryId: record.entryId,
		sourceRevision: record.sourceRevision,
		kind: record.kind,
		range: record.range,
	};
}

describe("personal harness memory", () => {
	test("searches Japanese and code text, skips derived recalls, and masks known credential shapes", async () => {
		await withDatabase(async (databasePath) => {
			const memory = new PersonalMemoryStore({ databasePath });
			try {
				const source = makeRecord({
					content:
						"PiのSessionManagerは日本語コード混在の検索を支える。DatabaseSync と node:sqlite。API_KEY=known_test_secret_value_9381",
				});
				const derived = makeRecord({
					entryId: "derived-a",
					origin: "derived-recall",
					content: "derived-recall-only-never-index-this",
				});

				const indexed = memory.index([source, derived]);
				expect(indexed.inserted).toBe(1);
				expect(indexed.skipped).toBe(1);
				expect(indexed.redacted).toBe(1);
				expect(
					memory.search("日本語コード混在", { sessionId: "session-a", branchId: "branch-a" }).candidates[0]
						?.entryId,
				).toBe("entry-a");
				expect(memory.search("DatabaseSync").candidates[0]?.entryId).toBe("entry-a");
				expect(memory.search("session").candidates[0]?.entryId).toBe("entry-a");
				expect(memory.search("DatabaseSync", { sessionId: "other-session" }).candidates).toHaveLength(0);
				expect(memory.search("derived-recall-only-never-index-this").candidates).toHaveLength(0);
				const masked = memory.search("API_KEY").candidates[0];
				expect(masked?.redacted).toBe(true);
				expect(masked?.excerpt).toContain("[REDACTED]");
				expect(masked?.excerpt).not.toContain("known_test_secret_value_9381");

				const persisted = new DatabaseSync(databasePath, { readOnly: true });
				try {
					const row = persisted.prepare("SELECT content FROM memory_sources WHERE entry_id = ?").get("entry-a") as
						| { readonly content: string }
						| undefined;
					expect(row?.content).not.toContain("known_test_secret_value_9381");
				} finally {
					persisted.close();
				}
			} finally {
				memory.close();
			}
		});
	});

	test("paginates capped search results and can re-read an exact indexed range", async () => {
		await withDatabase(async (databasePath) => {
			const memory = new PersonalMemoryStore({ databasePath });
			const records = Array.from({ length: 4 }, (_unused, index) =>
				makeRecord({
					sessionId: "session-page",
					branchId: "branch-page",
					entryId: `page-${index}`,
					ordinal: index,
					content: `unique page needle ${index}.`,
				}),
			);
			try {
				memory.index(records);
				const firstPage = memory.search("page needle", { sessionId: "session-page" });
				expect(firstPage.totalCandidates).toBe(4);
				expect(firstPage.candidates).toHaveLength(3);
				expect(firstPage.nextOffset).toBe(3);

				const secondPage = memory.search("page needle", {
					sessionId: "session-page",
					offset: firstPage.nextOffset,
				});
				expect(secondPage.candidates).toHaveLength(1);
				expect(secondPage.nextOffset).toBeUndefined();
				const read = memory.readSource(referenceOf(records[0]), { start: 0, end: 20 });
				expect(read.status).toBe("ready");
				expect(read.content).toBe("unique page needle 0");
			} finally {
				memory.close();
			}
		});
	});

	test("uses only cited search excerpts for curation and returns explicit excerpts on curator failure", async () => {
		await withDatabase(async (databasePath) => {
			const source = makeRecord({ content: "The verified setting is cacheMode=stable for this task." });
			let curateCalls = 0;
			const memory = new PersonalMemoryStore({
				databasePath,
				curate: async (query, records, signal) => {
					curateCalls++;
					expect(query).toBe("cacheMode stable");
					expect(records).toHaveLength(1);
					expect(signal.aborted).toBe(false);
					return { text: "Use cacheMode=stable.", citations: [citationOf(records[0])] };
				},
			});
			try {
				memory.index([source]);
				const result = await memory.recall("cacheMode stable");
				expect(result.status).toBe("curated");
				expect(result.citations).toHaveLength(1);
				expect(result.citations[0]?.entryId).toBe(source.entryId);
				const noMatch = await memory.recall("query absent from all indexed records");
				expect(noMatch.status).toBe("empty");
				expect(curateCalls).toBe(1);
			} finally {
				memory.close();
			}

			const fallback = new PersonalMemoryStore({
				databasePath,
				curate: async () => {
					throw new Error("curator transport failed");
				},
			});
			try {
				const result = await fallback.recall("cacheMode stable");
				expect(result.status).toBe("excerpt");
				expect(result.reason).toBe("curation-failed");
				expect(result.content).toContain("cacheMode=stable");
				expect(result.citations[0]?.entryId).toBe(source.entryId);
			} finally {
				fallback.close();
			}
		});
	});

	test("persists corrections and exclusions across restart and source-index rebuild", async () => {
		await withDatabase(async (databasePath) => {
			const corrected = makeRecord({
				entryId: "corrected-entry",
				content: "The obsoleteFlow was previously recommended.",
			});
			const excluded = makeRecord({
				entryId: "excluded-entry",
				ordinal: 2,
				content: "This private note should stay excluded from memory search.",
			});
			const memory = new PersonalMemoryStore({ databasePath });
			memory.index([corrected, excluded]);
			memory.correct(referenceOf(corrected), "Use currentFlow after validation.", "New validation result");
			memory.exclude(referenceOf(excluded), "User excluded this entry");
			memory.close();

			const reopened = new PersonalMemoryStore({ databasePath });
			try {
				const revised = makeRecord({
					entryId: corrected.entryId,
					sourceRevision: "revision-2",
					content: "The obsoleteFlow still appears in the original transcript.",
				});
				reopened.rebuild([revised, excluded]);
				expect(reopened.search("obsoleteFlow").candidates).toHaveLength(0);
				const replacement = reopened.search("currentFlow").candidates[0];
				expect(replacement?.kind).toBe("correction");
				expect(replacement?.sourceRevision).toBe(corrected.sourceRevision);
				expect(reopened.search("private note").candidates).toHaveLength(0);

				expect(() => reopened.correct(referenceOf(corrected), "stale update")).toThrow(/revision changed/u);
				reopened.include(referenceOf(revised));
				expect(reopened.search("obsoleteFlow").candidates[0]?.sourceRevision).toBe("revision-2");
				reopened.include(referenceOf(excluded));
				expect(reopened.search("private note").candidates[0]?.entryId).toBe(excluded.entryId);
			} finally {
				reopened.close();
			}
		});
	});

	test("checks an in-flight curation against a second SQLite connection's exclusion", async () => {
		await withDatabase(async (databasePath) => {
			const source = makeRecord({ content: "A session detail to invalidate while curation is pending." });
			let entered: (records: readonly MemoryExcerpt[]) => void = () => undefined;
			let release: (value: CuratedMemory) => void = () => undefined;
			const started = new Promise<readonly MemoryExcerpt[]>((resolve) => {
				entered = resolve;
			});
			const pending = new Promise<CuratedMemory>((resolve) => {
				release = resolve;
			});
			const memory = new PersonalMemoryStore({
				databasePath,
				curate: async (_query, records) => {
					entered(records);
					return pending;
				},
			});
			const invalidator = new PersonalMemoryStore({ databasePath });
			try {
				memory.index([source]);
				const inFlight = memory.recall("session detail");
				const candidates = await started;
				invalidator.exclude(referenceOf(source), "Invalidated during curation");
				release({ text: "Stale curated detail", citations: [citationOf(candidates[0])] });
				const result = await inFlight;
				expect(result.reason).toBe("sources-changed");
				expect(result.status).toBe("empty");
				expect(result.content).toBe("");
			} finally {
				memory.close();
				invalidator.close();
			}
		});
	});

	test("blocks secret-shaped queries before invoking the curator", async () => {
		await withDatabase(async (databasePath) => {
			let curated = false;
			const memory = new PersonalMemoryStore({
				databasePath,
				curate: async () => {
					curated = true;
					return { text: "unexpected", citations: [] };
				},
			});
			try {
				memory.index([makeRecord()]);
				const result = await memory.recall("api_key=recognizable_test_secret_1001");
				expect(result.status).toBe("blocked");
				expect(result.reason).toBe("sensitive-query");
				expect(result.query).not.toContain("recognizable_test_secret_1001");
				expect(curated).toBe(false);
			} finally {
				memory.close();
			}
		});
	});
	test("keeps exclusion and correction directives when the same entry moves to a new branch", async () => {
		await withDatabase(async (databasePath) => {
			const excluded = makeRecord({
				branchId: "branch-before-fork",
				entryId: "excluded-entry",
				content: "branchPrivateMarker should stay excluded after a branch change.",
			});
			const corrected = makeRecord({
				branchId: "branch-before-fork",
				entryId: "corrected-entry",
				content: "The obsoleteFlow setting was previously recommended.",
			});
			const beforeFork = new PersonalMemoryStore({ databasePath });
			beforeFork.index([excluded, corrected]);
			beforeFork.exclude(referenceOf(excluded), "Keep this entry out of memory");
			beforeFork.correct(
				referenceOf(corrected),
				"Use stableFlow after validation.",
				"The prior guidance was incorrect",
			);
			beforeFork.close();

			const afterFork = new PersonalMemoryStore({ databasePath });
			const rebranched = [
				{ ...excluded, branchId: "branch-after-fork" },
				{ ...corrected, branchId: "branch-after-fork" },
			];
			try {
				afterFork.index(rebranched);
				expect(
					afterFork.search("branchPrivateMarker", { sessionId: "session-a", branchId: "branch-after-fork" })
						.candidates,
				).toHaveLength(0);
				expect(
					afterFork.search("obsoleteFlow", { sessionId: "session-a", branchId: "branch-after-fork" }).candidates,
				).toHaveLength(0);
				expect(
					afterFork.search("stableFlow", { sessionId: "session-a", branchId: "branch-after-fork" }).candidates[0]
						?.kind,
				).toBe("correction");
				expect(afterFork.readSource(referenceOf(rebranched[0]), { start: 0, end: 20 }).status).toBe("excluded");
				expect(afterFork.readSource(referenceOf(rebranched[1]), { start: 0, end: 20 }).status).toBe("excluded");

				afterFork.rebuild(rebranched);
				expect(
					afterFork.search("branchPrivateMarker", { sessionId: "session-a", branchId: "branch-after-fork" })
						.candidates,
				).toHaveLength(0);
				expect(
					afterFork.search("obsoleteFlow", { sessionId: "session-a", branchId: "branch-after-fork" }).candidates,
				).toHaveLength(0);
				expect(
					afterFork.search("stableFlow", { sessionId: "session-a", branchId: "branch-after-fork" }).candidates[0]
						?.kind,
				).toBe("correction");
				expect(afterFork.readSource(referenceOf(rebranched[0]), { start: 0, end: 20 }).status).toBe("excluded");
				expect(afterFork.readSource(referenceOf(rebranched[1]), { start: 0, end: 20 }).status).toBe("excluded");
			} finally {
				afterFork.close();
			}
		});
	});

	test("keeps shared fork ancestors searchable in every branch without duplicating them", async () => {
		await withDatabase(async (databasePath) => {
			const shared = makeRecord({
				branchId: "branch-a",
				entryId: "shared-ancestor",
				ordinal: 10,
				content: "sharedAncestorMarker is part of the common ancestor.",
			});
			const corrected = makeRecord({
				branchId: "branch-a",
				entryId: "corrected-ancestor",
				ordinal: 11,
				content: "The obsoleteFlow guidance belongs to the common ancestor.",
			});
			const excluded = makeRecord({
				branchId: "branch-a",
				entryId: "excluded-ancestor",
				ordinal: 12,
				content: "excludedAncestorMarker must remain hidden in every branch.",
			});
			const branchAOnly = makeRecord({
				branchId: "branch-a",
				entryId: "branch-a-only",
				ordinal: 13,
				content: "branchAOnlyMarker belongs only to branch A.",
			});
			const sharedInB = { ...shared, branchId: "branch-b" };
			const correctedInB = { ...corrected, branchId: "branch-b" };
			const excludedInB = { ...excluded, branchId: "branch-b" };
			const branchBOnly = makeRecord({
				branchId: "branch-b",
				entryId: "branch-b-only",
				ordinal: 14,
				content: "branchBOnlyMarker belongs only to branch B.",
			});
			const expectBranchSearches = (store: PersonalMemoryStore) => {
				for (const [branchId, ownNeedle, otherNeedle, ownEntryId] of [
					["branch-a", "branchAOnlyMarker", "branchBOnlyMarker", "branch-a-only"],
					["branch-b", "branchBOnlyMarker", "branchAOnlyMarker", "branch-b-only"],
				] as const) {
					const scope = { sessionId: "session-a", branchId };
					const sharedSearch = store.search("sharedAncestorMarker", scope);
					expect(sharedSearch.totalCandidates).toBe(1);
					expect(sharedSearch.candidates[0]).toMatchObject({
						branchId: "branch-a",
						entryId: "shared-ancestor",
						kind: "source",
					});
					const correction = store.search("stableFlow", scope);
					expect(correction.totalCandidates).toBe(1);
					expect(correction.candidates[0]).toMatchObject({
						branchId: "branch-a",
						entryId: "corrected-ancestor",
						kind: "correction",
					});
					expect(store.search("obsoleteFlow", scope).totalCandidates).toBe(0);
					expect(store.search("excludedAncestorMarker", scope).totalCandidates).toBe(0);
					const own = store.search(ownNeedle, scope);
					expect(own.totalCandidates).toBe(1);
					expect(own.candidates.map((candidate) => candidate.entryId)).toEqual([ownEntryId]);
					expect(store.search(otherNeedle, scope).totalCandidates).toBe(0);
				}
			};

			const first = new PersonalMemoryStore({ databasePath });
			try {
				expect(first.index([shared, corrected, excluded, branchAOnly])).toMatchObject({
					inserted: 4,
					updated: 0,
					skipped: 0,
				});
				first.correct(referenceOf(corrected), "Use stableFlow after validation.");
				first.exclude(referenceOf(excluded), "User excluded this shared entry.");
				expect(first.index([sharedInB, correctedInB, excludedInB, branchBOnly])).toMatchObject({
					inserted: 1,
					updated: 3,
					skipped: 0,
				});
				expect(first.index([shared, corrected, excluded, branchAOnly])).toMatchObject({
					inserted: 0,
					updated: 0,
					skipped: 4,
				});
				expectBranchSearches(first);
			} finally {
				first.close();
			}

			const resumed = new PersonalMemoryStore({ databasePath });
			try {
				expectBranchSearches(resumed);
				expect(
					resumed.rebuild([
						sharedInB,
						correctedInB,
						excludedInB,
						branchBOnly,
						shared,
						corrected,
						excluded,
						branchAOnly,
					]),
				).toMatchObject({ inserted: 5, updated: 3, skipped: 0 });
				expectBranchSearches(resumed);
			} finally {
				resumed.close();
			}

			const reopened = new PersonalMemoryStore({ databasePath });
			try {
				expectBranchSearches(reopened);
			} finally {
				reopened.close();
			}

			const database = new DatabaseSync(databasePath, { readOnly: true });
			try {
				expect(database.prepare("SELECT count(*) AS total FROM memory_sources").get()).toMatchObject({ total: 5 });
				expect(database.prepare("SELECT count(*) AS total FROM memory_source_memberships").get()).toMatchObject({
					total: 8,
				});
				expect(
					database.prepare("SELECT branch_id FROM memory_sources WHERE entry_id = ?").get("shared-ancestor"),
				).toMatchObject({ branch_id: "branch-a" });
			} finally {
				database.close();
			}
		});
	});

	test("does not copy cookie and basic-auth headers into SQLite", async () => {
		await withDatabase(async (databasePath) => {
			const content =
				'Cookie: session=fixture-session-value; other=fixture-cookie-value\nSet-Cookie: sid=fixture-set-cookie; Secure\n{"authorization":"Basic Zml4dHVyZTpkdW1teQ==","cookie":"fixture-json-cookie"}';
			const safe = redactSensitiveText(`${content}\n{"set-cookie":["sid=fixture-one","token=fixture-two"]}`);
			expect(safe.text).not.toContain("fixture-one");
			expect(safe.text).not.toContain("fixture-two");
			for (const value of [
				"fixture-session-value",
				"fixture-cookie-value",
				"fixture-set-cookie",
				"Zml4dHVyZTpkdW1teQ==",
				"fixture-json-cookie",
			])
				expect(safe.text).not.toContain(value);
			const memory = new PersonalMemoryStore({ databasePath });
			try {
				memory.index([
					makeRecord({
						entryId: "header-secret",
						content: `${content}\n{"set-cookie":["sid=fixture-one","token=fixture-two"]}`,
					}),
				]);
				const db = new DatabaseSync(databasePath, { readOnly: true });
				try {
					expect(
						db.prepare("SELECT content FROM memory_sources WHERE entry_id = ?").get("header-secret"),
					).toMatchObject({ content: safe.text });
				} finally {
					db.close();
				}
			} finally {
				memory.close();
			}
		});
	});

	test("redacts JSON secret keys and multiword bearer values without masking token counts", async () => {
		await withDatabase(async (databasePath) => {
			const content =
				'{"password":"fixture-password with spaces","apiKey":"fixture-api-key"}\nAuthorization: Bearer fixture-bearer-value with spaces\n{"token_count":3}';
			const sanitized = redactSensitiveText(content);
			expect(sanitized.changed).toBe(true);
			expect(sanitized.text).toContain('"password":"[REDACTED]"');
			expect(sanitized.text).toContain('"apiKey":"[REDACTED]"');
			expect(sanitized.text).toContain("Authorization: [REDACTED");
			expect(sanitized.text).toContain('{"token_count":3}');
			expect(sanitized.text).not.toContain("fixture-password with spaces");
			expect(sanitized.text).not.toContain("fixture-api-key");
			expect(sanitized.text).not.toContain("fixture-bearer-value with spaces");

			const memory = new PersonalMemoryStore({ databasePath });
			try {
				expect(memory.index([makeRecord({ entryId: "structured-secrets", content })]).redacted).toBe(1);
				const persisted = new DatabaseSync(databasePath, { readOnly: true });
				try {
					const row = persisted
						.prepare("SELECT content FROM memory_sources WHERE entry_id = ?")
						.get("structured-secrets") as { readonly content: string } | undefined;
					expect(row?.content).toBe(sanitized.text);
				} finally {
					persisted.close();
				}
			} finally {
				memory.close();
			}
		});
	});
});
