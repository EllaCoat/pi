import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { CompactionTranscriptReader } from "../../src/personal-harness/compaction-reader.ts";

const secretFixture = "fixture-reader-secret-value";
const opaqueFixture = "fixture-opaque-thinking-payload";
const argumentFixture = "fixture-input.ts";

function messageEntry(
	id: string,
	parentId: string | null,
	role: string,
	content: unknown,
	extra: Record<string, unknown> = {},
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-09-28T00:00:${String(Number(id.split("-").at(-1)) || 0).padStart(2, "0")}.000Z`,
		message: { role, content, ...extra },
	} as unknown as SessionEntry;
}

function sourceEntries(): SessionEntry[] {
	return [
		messageEntry(
			"user-1",
			null,
			"user",
			`Current objective is preserve the recovery path. api_key: ${secretFixture}`,
		),
		messageEntry("assistant-2", "user-1", "assistant", [{ type: "thinking", thinking: opaqueFixture }], {
			thinkingSignature: "opaque-signature-fixture",
		}),
		messageEntry("assistant-3", "assistant-2", "assistant", [
			{ type: "toolCall", id: "call-3", name: "read", arguments: { path: argumentFixture } },
		]),
		messageEntry(
			"tool-4",
			"assistant-3",
			"toolResult",
			[{ type: "text", text: `Verification passed after the patch. API_KEY=${secretFixture}` }],
			{ toolName: "read", isError: false },
		),
		messageEntry("kept-5", "tool-4", "user", "retained request remains after the compact boundary"),
		messageEntry("tail-6", "kept-5", "assistant", "retained assistant response"),
	];
}

function createReader(entries = sourceEntries()) {
	return new CompactionTranscriptReader({
		sessionId: "session-reader-fixture",
		branchId: "branch-reader-fixture",
		sessionFile: "/fixture/session-reader.jsonl",
		branchEntries: entries,
		firstKeptEntryId: "kept-5",
	});
}

describe("compaction transcript reader", () => {
	it("does not expand a one-character excerpt budget into the entire record", () => {
		const entries: SessionEntry[] = [
			messageEntry("long-1", null, "assistant", [{ type: "text", text: "x".repeat(10_000) }]),
		];
		for (let i = 0; i < 8; i++)
			entries.push(
				messageEntry(`recent-${i}`, entries.at(-1)!.id, "assistant", [{ type: "text", text: "a".repeat(450) }]),
			);
		entries.push(
			messageEntry("recent-last", entries.at(-1)!.id, "assistant", [{ type: "text", text: "b".repeat(399) }]),
		);
		entries.push(messageEntry("kept-5", entries.at(-1)!.id, "user", "retained"));
		const reader = createReader(entries);
		const context = reader.initialContext({});
		const snippets = context.recentAssistantAndToolMessages as Array<{ entryId: string; contentExcerpt: string }>;
		const old = snippets.find((entry) => entry.entryId === "long-1");
		expect(old?.contentExcerpt.length).toBeLessThan(200);
		expect(old?.contentExcerpt).not.toContain("x".repeat(100));
		expect(reader.coverage().unreadRanges).toMatchObject([
			{ fromEntryId: "long-1", fromCharacter: 1, toCharacter: 10_000 },
		]);
	});

	it("redacts embedded JSON secrets before serializing Goal and TODO strings", () => {
		const reader = createReader();
		const rendered = JSON.stringify(
			reader.initialContext({
				currentGoal: { objective: 'Inspect {"password":"goal-nested-fixture"}' },
				currentTodo: { items: [{ title: 'Inspect {"password":"todo-nested-fixture"}' }] },
			}),
		);
		expect(rendered).not.toContain("goal-nested-fixture");
		expect(rendered).not.toContain("todo-nested-fixture");
	});

	it("keeps operation arguments and child notices readable without secrets or opaque data", () => {
		const entries = [
			messageEntry("call-1", null, "assistant", [
				{
					type: "toolCall",
					id: "operation-1",
					name: "edit",
					arguments: {
						path: "src/only-in-arguments.ts",
						api_key: secretFixture,
						code: 'const password = "inner-only-fixture-secret"; inspect();',
						encrypted_content: opaqueFixture,
					},
				},
			]),
			{
				type: "custom_message",
				id: "child-2",
				parentId: "call-1",
				timestamp: "2026-09-28T00:00:02.000Z",
				customType: "personal-harness-child-notice",
				content: "validator is still running; result not collected",
				display: true,
			} as SessionEntry,
			messageEntry("kept-5", "child-2", "user", "retained"),
		];
		const reader = createReader(entries);
		const listing = reader.list().entries as Array<{ entryId: string; textCharacters?: number }>;
		const read = reader.read({
			entries: listing
				.filter((e) => e.textCharacters)
				.map((e) => ({ entryId: e.entryId, start: 0, end: e.textCharacters! })),
		});
		const rendered = JSON.stringify(read);
		expect(rendered).toContain("src/only-in-arguments.ts");
		expect(rendered).toContain("operation-1");
		expect(rendered).not.toContain("inner-only-fixture-secret");
		expect(rendered).toContain("validator is still running");
		expect(rendered).not.toContain(secretFixture);
		expect(rendered).not.toContain(opaqueFixture);
	});

	it("tracks leading and trailing excerpts as separate original ranges", () => {
		const entries = [
			messageEntry("long-1", null, "user", "a".repeat(10_000)),
			messageEntry("kept-2", "long-1", "user", "retained"),
		];
		const reader = new CompactionTranscriptReader({
			sessionId: "coverage-fixture",
			branchId: "coverage-branch",
			branchEntries: entries,
			firstKeptEntryId: "kept-2",
		});
		reader.initialContext({});
		expect(reader.coverage().unreadRanges).toMatchObject([
			{ fromEntryId: "long-1", fromCharacter: 2_000, toCharacter: 8_000 },
		]);
		reader.read({ entries: [{ entryId: "long-1", start: 4_000, end: 10_000 }] });
		expect(reader.coverage()).toMatchObject({ fullyReadRecords: 0, unreadCharacters: 2_000 });
		reader.read({ entries: [{ entryId: "long-1", start: 2_000, end: 4_000 }] });
		expect(reader.coverage()).toMatchObject({ fullyReadRecords: 1, unreadCharacters: 0 });
	});

	it("starts with provenance and sanitized current context without exposing opaque fields or credential values", () => {
		const reader = createReader();
		const initial = reader.initialContext({
			previousSummary: "Previous checkpoint says the recovery path remains unverified.",
			currentGoal: { objective: `Preserve api_key: ${secretFixture}`, status: "active" },
			currentTodo: { items: [{ title: "Verify the recovery path", status: "in_progress" }] },
			customInstructions: "Keep the report concise.",
		});
		const rendered = JSON.stringify(initial);

		expect(initial).toMatchObject({
			source: {
				sessionId: "session-reader-fixture",
				branchId: "branch-reader-fixture",
				jsonlPathReference: "/fixture/session-reader.jsonl",
				firstKeptEntryId: "kept-5",
				targetEndEntryId: "tool-4",
				targetEntryCount: 4,
			},
			previousSummary: "Previous checkpoint says the recovery path remains unverified.",
		});
		expect(rendered).toContain("Current objective is preserve the recovery path.");
		expect(rendered).toContain("retained request remains after the compact boundary");
		expect(rendered).toContain("transcript_list");
		expect(rendered).toContain("transcript_search");
		expect(rendered).toContain("transcript_read");
		expect(rendered).not.toContain(secretFixture);
		expect(rendered).not.toContain(opaqueFixture);
		expect(rendered).not.toContain("opaque-signature-fixture");
		expect(rendered).toContain(argumentFixture);
	});

	it("keeps system instructions out of the transcript summary source", () => {
		const entries = sourceEntries();
		entries.splice(2, 0, messageEntry("system-7", "assistant-2", "system", "SYSTEM_INSTRUCTION_SENTINEL"));
		const next = entries[3];
		if (next?.type !== "message") throw new Error("Expected a message after the system entry");
		entries[3] = { ...next, parentId: "system-7" };

		const reader = createReader(entries);
		expect(JSON.stringify(reader.initialContext({}))).not.toContain("SYSTEM_INSTRUCTION_SENTINEL");
		expect(reader.search({ query: "SYSTEM_INSTRUCTION_SENTINEL" })).toMatchObject({
			matchingRecords: 0,
			returnedRecords: 0,
		});
	});

	it("lists metadata, searches sanitized text, and batch-reads only the frozen target", () => {
		const reader = createReader();
		const listing = reader.list({ offset: 0, limit: 20 });
		const entries = listing.entries as Array<{ entryId: string; toolCalls?: string[]; textCharacters?: number }>;
		expect(entries.map((entry) => entry.entryId)).toEqual(["user-1", "assistant-2", "assistant-3", "tool-4"]);
		expect(entries[2]?.toolCalls).toEqual(["read"]);
		expect(JSON.stringify(listing)).not.toContain(opaqueFixture);
		expect(JSON.stringify(listing)).not.toContain(argumentFixture);

		const search = reader.search({ query: "Verification passed" });
		const hits = search.hits as Array<{ entryId: string; excerpt: string; range: { start: number; end: number } }>;
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ entryId: "tool-4" });
		expect(hits[0]?.excerpt).toContain("Verification passed");
		expect(JSON.stringify(search)).not.toContain(secretFixture);

		const userLength = entries.find((entry) => entry.entryId === "user-1")?.textCharacters;
		const toolLength = entries.find((entry) => entry.entryId === "tool-4")?.textCharacters;
		const callLength = entries.find((entry) => entry.entryId === "assistant-3")?.textCharacters;
		if (userLength === undefined || toolLength === undefined || callLength === undefined)
			throw new Error("Synthetic source lengths are missing");
		const read = reader.read({
			entries: [
				{ entryId: "user-1", start: 0, end: userLength },
				{ entryId: "tool-4", start: 0, end: toolLength },
				{ entryId: "assistant-3", start: 0, end: callLength },
				{ entryId: "kept-5", start: 0, end: 24 },
			],
		});
		const readEntries = read.entries as Array<{
			entryId: string;
			status?: string;
			content?: string;
			complete?: boolean;
		}>;
		expect(readEntries[0]?.content).toContain("[REDACTED]");
		expect(readEntries[0]?.complete).toBe(true);
		expect(readEntries[1]?.content).toContain("[REDACTED]");
		expect(readEntries[2]?.content).toContain(argumentFixture);
		expect(readEntries[3]).toMatchObject({ status: "outside-target-or-no-text-record" });
		expect(JSON.stringify(read)).not.toContain(secretFixture);
		expect(reader.coverage()).toMatchObject({
			targetTextRecordCount: 3,
			fullyReadRecords: 3,
			unreadCharacters: 0,
		});
	});

	it("allows appends after the kept boundary but rejects changes to frozen target records", () => {
		const entries = sourceEntries();
		const reader = createReader(entries);
		const appended = messageEntry("new-after-target", "tail-6", "assistant", "new retained content");
		expect(() => reader.assertUnchanged("session-reader-fixture", [...entries, appended])).not.toThrow();

		const changedTail = structuredClone(entries);
		const tail = changedTail[5];
		if (!tail || tail.type !== "message") throw new Error("Synthetic tail missing");
		tail.message = { role: "user", content: "different retained branch context", timestamp: 2 };
		expect(() => reader.assertUnchanged("session-reader-fixture", changedTail)).toThrow();

		const changed = structuredClone(entries);
		const target = changed[0];
		if (!target || target.type !== "message") throw new Error("Synthetic target entry is missing");
		target.message = { role: "user", content: "changed target record", timestamp: 1 };
		expect(() => reader.assertUnchanged("session-reader-fixture", changed)).toThrow("target records changed");
	});
	it("enforces the generous cumulative source-read character budget without claiming a full read", () => {
		const longText = "x".repeat(1_050_000);
		const entries = [
			messageEntry("long-1", null, "user", longText),
			messageEntry("kept-2", "long-1", "user", "retained"),
		];
		const reader = new CompactionTranscriptReader({
			sessionId: "session-long-fixture",
			branchId: "branch-long-fixture",
			branchEntries: entries,
			firstKeptEntryId: "kept-2",
		});
		reader.initialContext({});
		let lastRead: Record<string, unknown> | undefined;
		let attempts = 0;
		while (reader.coverage().remainingCharacterBudget > 0 && attempts < 50) {
			lastRead = reader.read({
				entries: [
					{ entryId: "long-1", start: 0, end: 16_000 },
					{ entryId: "long-1", start: 16_000, end: 32_000 },
				],
			});
			attempts++;
		}

		expect(attempts).toBeGreaterThan(0);
		expect(reader.coverage()).toMatchObject({ characterLimit: 1_000_000, remainingCharacterBudget: 0 });
		expect(reader.coverage().cumulativeCharactersReturned as number).toBeLessThanOrEqual(1_000_000);
		expect((lastRead?.entries as Array<{ complete: boolean }>).some((entry) => !entry.complete)).toBe(true);
		expect(reader.coverage().unreadCharacters as number).toBeGreaterThan(0);
	});
});
