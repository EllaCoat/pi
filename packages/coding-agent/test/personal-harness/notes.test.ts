import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
	JevEvaluationInput,
	JevEvaluationResponse,
	JevEvaluator,
} from "../../src/personal-harness/hooks/jev-types.ts";
import { MarkdownNotesStore } from "../../src/personal-harness/notes/index.ts";

interface NoteFixture {
	readonly root: string;
	readonly workspace: string;
	readonly nestedCwd: string;
	readonly sibling: string;
	readonly outside: string;
}

interface NoteValues {
	readonly scope: string;
	readonly title: string;
	readonly description?: string;
	readonly body: string;
	readonly verifiedAt?: string;
	readonly confidence?: number | string;
}

function writeNote(root: string, id: string, note: NoteValues): void {
	const file = join(root, ...id.split("/"));
	mkdirSync(dirname(file), { recursive: true });
	const frontmatter = [
		"---",
		`scope: ${JSON.stringify(note.scope)}`,
		...(note.description === undefined ? [] : [`description: ${JSON.stringify(note.description)}`]),
		...(note.verifiedAt === undefined ? [] : [`verified_at: ${JSON.stringify(note.verifiedAt)}`]),
		...(note.confidence === undefined ? [] : [`confidence: ${JSON.stringify(note.confidence)}`]),
		"---",
		`# ${note.title}`,
		note.body,
	].join("\n");
	writeFileSync(file, frontmatter, "utf8");
}

async function withFixture(run: (fixture: NoteFixture) => Promise<void>): Promise<void> {
	const temporary = mkdtempSync(join(tmpdir(), "pi-markdown-notes-"));
	const fixture = {
		root: join(temporary, "notes"),
		workspace: join(temporary, "work", "project"),
		nestedCwd: join(temporary, "work", "project", "packages", "app"),
		sibling: join(temporary, "work", "project-copy"),
		outside: join(temporary, "outside"),
	};
	for (const directory of [fixture.root, fixture.nestedCwd, fixture.sibling, fixture.outside])
		mkdirSync(directory, { recursive: true });
	try {
		await run(fixture);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function responseFor(input: JevEvaluationInput, preferredQuestion?: string): JevEvaluationResponse {
	const answers: JevEvaluationResponse["answers"] = {};
	for (const [index, id] of Object.keys(input.questions).entries()) {
		answers[id] = {
			type: "score",
			score: id === preferredQuestion ? 4 : 0,
			legend: { 0: "irrelevant", 1: "weak", 2: "partial", 3: "relevant", 4: "strong" },
			confidence: index === 0 ? 0.9 : 0.8,
		};
	}
	return { model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } };
}

describe("personal harness Markdown notes", () => {
	test("filters global and ancestor workspace scope and ranks title, description, headings, then body", async () => {
		await withFixture(async ({ root, workspace, nestedCwd, sibling }) => {
			writeNote(root, "global-title.md", {
				scope: "global",
				title: "Atlas title record",
				body: "This body does not add more context.",
				verifiedAt: "2026-09-27",
				confidence: 0.91,
			});
			writeNote(root, "global-description.md", {
				scope: "global",
				title: "Description record",
				description: "Atlas appears in this description.",
				body: "No matching body text.",
			});
			writeNote(root, "global-heading.md", {
				scope: "global",
				title: "Heading record",
				body: "## Atlas heading\nOther text.",
			});
			writeNote(root, "global-body.md", {
				scope: "global",
				title: "Body record",
				body: "Atlas appears only in the body.",
			});
			writeNote(root, "project-note.md", {
				scope: workspace.replaceAll("\\", "/"),
				title: "Atlas workspace record",
				description: "Current workspace information.",
				body: "Workspace-only material.",
				verifiedAt: "2026-09-26",
				confidence: "high",
			});
			writeNote(root, "sibling-note.md", {
				scope: sibling.replaceAll("\\", "/"),
				title: "Atlas sibling record",
				body: "Must not appear in another workspace.",
			});

			const store = new MarkdownNotesStore({ root });
			const all = await store.search({ query: "Atlas", cwd: nestedCwd });
			expect(all.status).toBe("matches");
			expect(all.ranking).toMatchObject({ method: "lexical", jevStatus: "unavailable" });
			expect(all.results.map((item) => item.id)).toContain("project-note.md");
			expect(all.results.map((item) => item.id)).not.toContain("sibling-note.md");
			expect(all.results.map((item) => item.id).slice(0, 4)).toEqual([
				"global-title.md",
				"project-note.md",
				"global-description.md",
				"global-heading.md",
			]);
			expect(all.results.map((item) => item.id)).toContain("global-body.md");

			const global = await store.search({ query: "Atlas", cwd: nestedCwd, scope: "global" });
			expect(global.results.map((item) => item.id)).not.toContain("project-note.md");
			expect(global.results.map((item) => item.id)).not.toContain("sibling-note.md");
			const workspaceOnly = await store.search({ query: "Atlas", cwd: nestedCwd, scope: "workspace" });
			expect(workspaceOnly.results.map((item) => item.id)).toEqual(["project-note.md"]);
			expect(workspaceOnly.results[0]).toMatchObject({
				scope: workspace.replaceAll("\\", "/"),
				verified_at: "2026-09-26",
				confidence: "high",
			});
		});
	});

	test("re-reads hand-edited Markdown and reads notes without descriptions", async () => {
		await withFixture(async ({ root, nestedCwd }) => {
			writeNote(root, "editable.md", { scope: "global", title: "Before edit", body: "alpha marker" });
			const store = new MarkdownNotesStore({ root });
			expect((await store.search({ query: "alpha", cwd: nestedCwd })).results[0]?.title).toBe("Before edit");

			writeNote(root, "editable.md", { scope: "global", title: "After edit", body: "omega marker" });
			const search = await store.search({ query: "omega", cwd: nestedCwd });
			expect(search.results[0]).toMatchObject({ id: "editable.md", title: "After edit" });
			expect(search.results[0]).not.toHaveProperty("description");
			const read = await store.read({ id: "editable.md", cwd: nestedCwd });
			expect(read).toMatchObject({
				status: "ready",
				note: { title: "After edit" },
				content: expect.stringContaining("omega marker"),
			});
		});
	});

	test("uses bounded candidate-only Jev ranking and preserves lexical matches", async () => {
		await withFixture(async ({ root, nestedCwd }) => {
			for (let index = 0; index < 12; index++) {
				writeNote(root, `notes/note-${String(index).padStart(2, "0")}.md`, {
					scope: "global",
					title: `Record ${index}`,
					description: "Jev target topic.",
					body: `Jev target snippet for record ${index}.\n${"Full body not sent to evaluator. ".repeat(80)}`,
				});
			}
			let observed: JevEvaluationInput | undefined;
			const evaluate: JevEvaluator = async (input) => {
				observed = input;
				const ids = Object.keys(input.questions);
				return responseFor(input, ids.at(-1));
			};
			const store = new MarkdownNotesStore({ root, evaluate });
			const result = await store.search({ query: "Jev target", cwd: nestedCwd });
			expect(result.ranking).toMatchObject({ method: "jev", jevStatus: "ranked", considered: 8, unassessed: 4 });
			expect(result.results[0]?.id).toBe("notes/note-07.md");
			expect(result.totalMatches).toBe(12);
			expect(observed).toBeDefined();
			expect(Object.keys(observed!.questions)).toHaveLength(8);
			const serialized = JSON.stringify(observed);
			const bytes = new TextEncoder().encode(
				JSON.stringify({ state: observed!.state, model: "jev-latest", questions: observed!.questions }),
			).byteLength;
			expect(bytes).toBeLessThanOrEqual(65_536);
			expect(result.ranking.inputBytes).toBe(bytes);
			expect(serialized).not.toContain("Full body not sent to evaluator");
			expect(serialized).not.toContain("notes/note-07.md");
		});
	});

	test("reads ordinary authentication and token documentation filenames", async () => {
		await withFixture(async ({ root, nestedCwd }) => {
			const ids = ["auth.md", "tokens.md", "cookies.md", "credentials.md", "auth/design.md"];
			for (const id of ids)
				writeNote(root, id, {
					scope: "global",
					title: "ArchitectureFixture",
					body: "Ordinary explanatory documentation without credential values.",
				});
			const store = new MarkdownNotesStore({ root });
			const result = await store.search({ query: "ArchitectureFixture", cwd: nestedCwd });
			expect(result.results.map((note) => note.id).sort()).toEqual([...ids].sort());
			for (const id of ids) expect(await store.read({ id, cwd: nestedCwd })).toMatchObject({ status: "ready" });
		});
	});
	test("stops a pending Jev ranking when its caller aborts", async () => {
		await withFixture(async ({ root, nestedCwd }) => {
			writeNote(root, "cancel.md", { scope: "global", title: "Cancel fixture", body: "Cancellation marker" });
			const started = Promise.withResolvers<void>();
			let receivedSignal: AbortSignal | undefined;
			const store = new MarkdownNotesStore({
				root,
				evaluate: async (_input, signal) => {
					receivedSignal = signal;
					started.resolve();
					return new Promise<JevEvaluationResponse>(() => {});
				},
			});
			const controller = new AbortController();
			const pending = store.search({ query: "Cancellation marker", cwd: nestedCwd }, controller.signal);
			const rejected = expect(pending).rejects.toThrow("cancel notes fixture");
			await started.promise;
			controller.abort(new Error("cancel notes fixture"));
			await rejected;
			expect(receivedSignal?.aborted).toBe(true);
		});
	});
	test("returns lexical results with explicit failure status when Jev is unavailable", async () => {
		await withFixture(async ({ root, nestedCwd }) => {
			writeNote(root, "fallback.md", { scope: "global", title: "Lexical fallback", body: "fallback marker" });
			const store = new MarkdownNotesStore({ root, evaluate: async () => Promise.reject(new Error("offline")) });
			const result = await store.search({ query: "fallback marker", cwd: nestedCwd });
			expect(result.status).toBe("matches");
			expect(result.ranking).toMatchObject({ method: "lexical", jevStatus: "failed" });
			expect(result.results[0]?.id).toBe("fallback.md");
		});
	});

	test("redacts credential-shaped content and queries before any Jev call", async () => {
		await withFixture(async ({ root, nestedCwd }) => {
			writeNote(root, "safe.md", {
				scope: "global",
				title: "Safe marker",
				description: 'API_KEY="fixture-description-secret-91"',
				body: 'Safe marker API_KEY=fixture-body-secret-92 password="fixture-password-secret-93" Authorization: Bearer fixture-bearer-secret-94',
			});
			writeNote(root, ".aws/credentials.md", {
				scope: "global",
				title: "Safe marker secret file",
				body: "fixture-protected-file-secret",
			});
			const received: string[] = [];
			const evaluate: JevEvaluator = async (input) => {
				received.push(JSON.stringify(input));
				return responseFor(input);
			};
			const store = new MarkdownNotesStore({ root, evaluate });
			const search = await store.search({ query: "Safe marker", cwd: nestedCwd });
			expect(search.results.map((item) => item.id)).toEqual(["safe.md"]);
			expect(search.results[0]?.description).not.toContain("fixture-description-secret-91");
			for (const secret of [
				"fixture-description-secret-91",
				"fixture-body-secret-92",
				"fixture-password-secret-93",
				"fixture-bearer-secret-94",
				"fixture-protected-file-secret",
			]) {
				expect(JSON.stringify(search)).not.toContain(secret);
				expect(received.join("\n")).not.toContain(secret);
			}
			const read = await store.read({ id: "safe.md", cwd: nestedCwd });
			expect(read.status).toBe("ready");
			if (read.status === "ready") {
				expect(read.redacted).toBe(true);
				expect(read.content).not.toContain("fixture-body-secret-92");
				expect(read.content).not.toContain("fixture-password-secret-93");
			}

			const sensitive = await store.search({ query: "API_KEY=fixture-query-secret-95", cwd: nestedCwd });
			expect(sensitive.status).toBe("sensitive-query");
			expect(sensitive.ranking.jevStatus).toBe("skipped-sensitive-query");
			expect(received).toHaveLength(1);
			expect(JSON.stringify(sensitive)).not.toContain("fixture-query-secret-95");
		});
	});

	test("rejects traversal, excludes sibling workspaces, and does not follow symlinked directories", async () => {
		await withFixture(async ({ root, nestedCwd, sibling, outside }) => {
			writeNote(root, "sibling.md", {
				scope: sibling.replaceAll("\\", "/"),
				title: "Sibling note",
				body: "sibling marker",
			});
			writeNote(outside, "outside.md", { scope: "global", title: "Outside note", body: "outside marker" });
			const link = join(root, "linked");
			symlinkSync(outside, link, "junction");
			const store = new MarkdownNotesStore({ root });
			expect((await store.search({ query: "marker", cwd: nestedCwd })).results).toEqual([]);
			expect(await store.read({ id: "../outside/outside.md", cwd: nestedCwd })).toEqual({ status: "not-found" });
			expect(await store.read({ id: "sibling.md", cwd: nestedCwd })).toEqual({ status: "outside-scope" });
			expect(await store.read({ id: "linked/outside.md", cwd: nestedCwd })).toEqual({ status: "not-found" });
		});
	});
});
