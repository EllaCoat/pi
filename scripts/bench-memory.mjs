import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { PersonalMemoryStore } from "../packages/coding-agent/src/personal-harness/memory/index.ts";
import { MEMORY_BENCH_CORPUS, MEMORY_BENCH_QUESTIONS, MEMORY_BENCH_REVISION } from "./bench-memory-fixture.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const MNEMOPI_MARKER = "BENCH_MEMORY_MNEMOPI_RESULT ";
const LIVE_MARKER = "BENCH_MEMORY_LIVE_RESULT ";
const DEFAULT_BUN = "bun";
const WORKER_TIMEOUT_MS = 240_000;

function usage() {
	console.log("Usage: node --experimental-strip-types scripts/bench-memory.mjs --omp-root <current-omp-source-root> [--bun <bun-executable>] [--live] [--agent-dir <pi-agent-dir>]");
	console.log("Offline mode uses only synthetic fixtures, in-memory SQLite, Mnemopi's public API with embeddings/LLM disabled, and Pi excerpt search.");
	console.log("--live explicitly sends fixture-only memory and questions to openai-codex/gpt-6-luna with thinking=max via completeHarnessTask; it may incur provider charges.");
}

function parseArgs(args) {
	const options = { ompRoot: undefined, bun: DEFAULT_BUN, live: false, agentDir: undefined, prepared: undefined, help: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--omp-root" || arg === "--bun" || arg === "--agent-dir" || arg === "--prepared") {
			const value = args[++index];
			if (!value) throw new Error(`missing value for ${arg}`);
			if (arg === "--omp-root") options.ompRoot = resolve(value);
			else if (arg === "--bun") options.bun = value;
			else if (arg === "--prepared") options.prepared = resolve(value);
			else options.agentDir = resolve(value);
		} else if (arg === "--live") options.live = true;
		else throw new Error(`unknown option: ${arg}`);
	}
	if (!options.help && !options.ompRoot) throw new Error("--omp-root is required to reuse the current Mnemopi public API");
	if (options.agentDir && !options.live) throw new Error("--agent-dir is only accepted with --live");
	return options;
}

function validateFixture() {
	const ids = MEMORY_BENCH_CORPUS.map((record) => record.id);
	if (new Set(ids).size !== ids.length) throw new Error("fixture record IDs must be unique");
	if (MEMORY_BENCH_QUESTIONS.length !== 12) throw new Error("R12 fixture must keep its predeclared 12-question set");
	const known = new Set(ids);
	for (const question of MEMORY_BENCH_QUESTIONS) {
		for (const id of [...question.expected.sourceIds, ...question.staleSourceIds]) {
			if (!known.has(id)) throw new Error(`fixture question ${question.id} refers to unknown source ${id}`);
		}
	}
	if (!MEMORY_BENCH_CORPUS.some((record) => record.id === "region-old") || !MEMORY_BENCH_CORPUS.some((record) => record.id === "region-correction")) {
		throw new Error("fixture must retain both sides of its correction case");
	}
	if (!MEMORY_BENCH_CORPUS.some((record) => record.outcome === "failed") || !MEMORY_BENCH_CORPUS.some((record) => record.outcome === "unverified")) {
		throw new Error("fixture must distinguish failed and unverified sources");
	}
}

function sourceRecords() {
	return MEMORY_BENCH_CORPUS.map((record, ordinal) => ({
		sessionId: "r12-synthetic-session",
		branchId: "main",
		entryId: record.id,
		sourceRevision: MEMORY_BENCH_REVISION,
		ordinal,
		role: record.role,
		origin: record.role === "tool" ? "tool" : "session",
		content: record.content,
		timestamp: record.timestamp,
		outcome: record.outcome,
	}));
}

function safeEnv() {
	const env = {};
	for (const name of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	return env;
}

function workerEnv(options) {
	const env = safeEnv();
	env.PI_OFFLINE = "1";
	env.MNEMOPI_NO_EMBEDDINGS = "1";
	env.MNEMOPI_LLM_ENABLED = "0";
	if (options.live) {
		delete env.PI_OFFLINE;
		delete env.MNEMOPI_LLM_ENABLED;
		if (options.agentDir) env.PI_CODING_AGENT_DIR = options.agentDir;
	}
	return env;
}

function parseWorkerOutput(result, marker, label) {
	if (result.error) return { workerError: result.error.code ?? result.error.name };
	const line = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/u).findLast((item) => item.startsWith(marker));
	if (!line) return { workerError: `${label}_NO_RESULT`, workerExit: result.status ?? result.signal ?? "none" };
	let data;
	try {
		data = JSON.parse(line.slice(marker.length));
	} catch {
		return { workerError: `${label}_INVALID_RESULT`, workerExit: result.status ?? result.signal ?? "none" };
	}
	if (data.error) return { ...data, workerError: data.error, workerExit: result.status ?? result.signal ?? "none" };
	if (result.status !== 0 && marker === LIVE_MARKER && data.stoppedEarly) return { ...data, workerExit: result.status ?? result.signal };
	if (result.status !== 0) return { ...data, workerError: `${label}_EXIT_${result.status ?? result.signal ?? "unknown"}` };
	return data;
}

function runMnemopi(options) {
	const worker = join(SCRIPTS, "bench-memory-mnemopi.mjs");
	const args = ["--no-env-file", worker, "--omp-root", options.ompRoot, ...(options.live ? ["--live"] : []), ...(options.agentDir ? ["--agent-dir", options.agentDir] : [])];
	const result = spawnSync(options.bun, args, {
		cwd: options.ompRoot,
		env: workerEnv(options),
		encoding: "utf8",
		timeout: WORKER_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
	});
	return parseWorkerOutput(result, MNEMOPI_MARKER, "Mnemopi worker");
}

function percentile(values, fraction) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return Number(sorted[Math.ceil(fraction * sorted.length) - 1].toFixed(3));
}

function summarizeTimes(queries) {
	const first = queries.map((query) => query.firstRecallMs);
	const repeat = queries.map((query) => query.repeatRecallMs);
	return {
		sampleCount: queries.length,
		firstP50Ms: percentile(first, 0.5),
		firstP95Ms: percentile(first, 0.95),
		repeatP50Ms: percentile(repeat, 0.5),
		repeatP95Ms: percentile(repeat, 0.95),
	};
}

function sourceIdsFromCandidates(candidates) {
	return [...new Set(candidates.map((candidate) => candidate.entryId).filter((id) => typeof id === "string"))];
}

function fixtureEvidence(question, candidates) {
	const sourceIds = sourceIdsFromCandidates(candidates);
	const text = candidates.map((candidate) => candidate.excerpt ?? candidate.content ?? "").join("\n");
	const expectedSourcesFound = question.expected.sourceIds.every((id) => sourceIds.includes(id));
	const staleSourceIdsFound = question.staleSourceIds.filter((id) => sourceIds.includes(id));
	const expectedAnswerTextPresent = question.expected.answerIncludes.every((value) => text.includes(value));
	const noMatchCorrect = question.expected.insufficient !== true || candidates.length === 0;
	return {
		sourceIds,
		expectedSourcesFound,
		staleSourceIdsFound,
		expectedAnswerTextPresent,
		noMatchCorrect,
		retrievalSupportsQuestion: expectedSourcesFound && staleSourceIdsFound.length === 0 && expectedAnswerTextPresent && noMatchCorrect,
		candidateCount: candidates.length,
		candidateCharacters: candidates.reduce((total, candidate) => total + (candidate.excerpt?.length ?? candidate.content?.length ?? 0), 0),
	};
}

async function runPiExcerptOffline() {
	const store = new PersonalMemoryStore({ databasePath: ":memory:" });
	store.index(sourceRecords());
	const queries = [];
	for (const question of MEMORY_BENCH_QUESTIONS) {
		const firstStart = performance.now();
		const first = await store.recall(question.query);
		const firstRecallMs = performance.now() - firstStart;
		const fullSourceReads = first.records.map((record) => {
			const readStarted = performance.now();
			const read = store.readSource(record, { start: 0, end: record.totalCharacters });
			const sourceReadMs = performance.now() - readStarted;
			return {
				sourceId: record.entryId,
				status: read.status,
				sourceReadMs,
				characters: read.totalCharacters ?? 0,
				expectedAnswerTextPresent: read.status === "ready" && question.expected.answerIncludes.every((value) => (read.content ?? "").includes(value)),
			};
		});
		const repeatStart = performance.now();
		const repeated = await store.recall(question.query);
		const repeatRecallMs = performance.now() - repeatStart;
		const directReadRecovery = question.expected.insufficient === true
			? first.records.length === 0
			: question.expected.sourceIds.every((id) => fullSourceReads.some((read) => read.sourceId === id && read.status === "ready" && read.expectedAnswerTextPresent));
		queries.push({
			questionId: question.id,
			firstRecallMs,
			repeatRecallMs,
			first: fixtureEvidence(question, first.records),
			repeated: fixtureEvidence(question, repeated.records),
			fullSourceReads,
			fullSourceReadRecovery: directReadRecovery,
			reason: first.reason,
		});
	}
	store.close();
	const readSamples = queries.flatMap((query) => query.fullSourceReads.map((read) => read.sourceReadMs));
	return {
		mode: "pi-search-excerpts",
		database: ":memory:",
		noCurator: true,
		latency: summarizeTimes(queries),
		fullSourceReadLatency: { sampleCount: readSamples.length, p50Ms: percentile(readSamples, 0.5), p95Ms: percentile(readSamples, 0.95) },
		queries,
	};
}

function usageUnknownForOffline() {
	return { input: null, cacheRead: null, cacheWrite: null, output: null, costUsd: null, externalModelCalls: 0, status: "not_measured_offline" };
}


function offlineMnemopiSummary(result) {
	const byQuestion = new Map(result.queries.map((query) => [query.questionId, query]));
	const queries = MEMORY_BENCH_QUESTIONS.map((question) => {
		const measured = byQuestion.get(question.id);
		const retrieved = measured?.first ?? [];
		const sourceIds = [...new Set(retrieved.map((record) => record.sourceId).filter((id) => typeof id === "string"))];
		const text = retrieved.map((record) => record.content).join("\n");
		const staleSourceIdsFound = question.staleSourceIds.filter((id) => sourceIds.includes(id));
		const expectedSourcesFound = question.expected.sourceIds.every((id) => sourceIds.includes(id));
		const expectedAnswerTextPresent = question.expected.answerIncludes.every((value) => text.includes(value));
		const noMatchCorrect = question.expected.insufficient !== true || retrieved.length === 0;
		const fullSourceReadRecovery = question.expected.insufficient === true
			? retrieved.length === 0
			: question.expected.sourceIds.every((id) => retrieved.some((record) =>
				record.sourceId === id && record.fullSourceRead?.available && record.fullSourceRead.expectedAnswerTextPresent,
			));
		return {
			questionId: question.id,
			firstRecallMs: measured?.firstRecallMs ?? null,
			repeatRecallMs: measured?.repeatRecallMs ?? null,
			retrieval: {
				sourceIds,
				expectedSourcesFound,
				staleSourceIdsFound,
				expectedAnswerTextPresent,
				noMatchCorrect,
				retrievalSupportsQuestion: expectedSourcesFound && staleSourceIdsFound.length === 0 && expectedAnswerTextPresent && noMatchCorrect,
				candidateCount: retrieved.length,
				candidateCharacters: retrieved.reduce((total, item) => total + item.content.length, 0),
			},
			fullSourceReads: retrieved.map((record) => ({ sourceId: record.sourceId, ...record.fullSourceRead })),
			fullSourceReadRecovery,
		};
	});
	const fullReadSamples = queries.flatMap((query) => query.fullSourceReads.map((read) => read.sourceReadMs).filter(Number.isFinite));
	return {
		mode: "official-mnemopi-public-api",
		database: result.database,
		embeddings: result.embeddings,
		retentionExtraction: result.retentionExtraction,
		prepareMs: result.prepareMs,
		latency: summarizeTimes(queries),
		fullSourceReadLatency: { sampleCount: fullReadSamples.length, p50Ms: percentile(fullReadSamples, 0.5), p95Ms: percentile(fullReadSamples, 0.95) },
		usage: result.live ? result.usage : usageUnknownForOffline(),
		queries,
	};
}

async function runLive(options, mnemopi) {
	const worker = join(SCRIPTS, "bench-memory-live.mjs");
	const args = ["--experimental-strip-types", worker, ...(options.agentDir ? ["--agent-dir", options.agentDir] : [])];
	const result = spawnSync(process.execPath, args, {
		cwd: ROOT,
		env: workerEnv(options),
		input: JSON.stringify(mnemopi),
		encoding: "utf8",
		timeout: WORKER_TIMEOUT_MS * 4,
		maxBuffer: 32 * 1024 * 1024,
	});
	return parseWorkerOutput(result, LIVE_MARKER, "Live benchmark worker");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) return usage();
	validateFixture();
	const manifest = JSON.parse(readFileSync(join(options.ompRoot, "packages/mnemopi/package.json"), "utf8"));
	if (manifest.name !== "@oh-my-pi/pi-mnemopi") throw new Error("--omp-root does not contain the expected Mnemopi package");
	if (!existsSync(join(options.ompRoot, "packages/mnemopi/src/index.ts"))) throw new Error("Mnemopi public source entry was not found");
	const work = mkdtempSync(join(tmpdir(), "pi-memory-benchmark-"));
	let mnemopi;
	if (options.prepared) {
		const saved = JSON.parse(readFileSync(options.prepared, "utf8"));
		if (saved.fixtureRevision !== MEMORY_BENCH_REVISION || saved.live !== options.live) throw new Error("Prepared fixture conditions differ");
		mnemopi = saved.result;
	} else mnemopi = runMnemopi(options);
	const preparedPath = join(work, "prepared.json");
	writeFileSync(preparedPath, JSON.stringify({ fixtureRevision: MEMORY_BENCH_REVISION, live: options.live, result: mnemopi }));
	console.error(`Prepared synthetic fixture: ${preparedPath}`);
	const mnemopiError = mnemopi.workerError ?? mnemopi.error;
	const piExcerpt = await runPiExcerptOffline();
	const liveResult = options.live
		? mnemopiError
			? { status: "not_run", reason: "Mnemopi preparation did not complete; Pi model calls were not started.", errorCode: mnemopiError }
			: await runLive(options, mnemopi)
		: { status: "not_run", reason: "Main must explicitly invoke with --live after review of the synthetic fixture and expected answers." };
	const output = {
		benchmark: {
			id: "R12 synthetic memory comparison",
			fixtureRevision: MEMORY_BENCH_REVISION,
			corpusRecords: MEMORY_BENCH_CORPUS.length,
			questions: MEMORY_BENCH_QUESTIONS.length,
			mnemopiPackageVersion: manifest.version,
			liveRequested: options.live,
		},
		conditions: {
			mnemopi: {
				method: "current Mnemopi package public remember/recall API; records are indexed before questions",
				limitation: "Does not instantiate the current OMP AgentSession retention lifecycle or its configured memory model. Offline uses the package's deterministic no-LLM extraction path; --live uses the shared Pi Luna/max model-call helper for extraction.",
			},
			piExcerpt: { method: "Pi MemoryIndex/PersonalMemoryStore search excerpts only; no curator call" },
			piCurated: {
				method: "Pi PersonalMemoryStore with a live MemoryCurator supplied by completeHarnessTask and LUNA_MAX",
				status: !options.live ? "not_run_requires_explicit_--live" : liveResult.status === "not_run" ? "not_run_after_prep_failure" : liveResult.workerError || liveResult.stoppedEarly || liveResult.workerExit ? "partial_or_failed" : "live_result_attached",
			},
		},
		offline: {
			mnemopi: mnemopiError
				? {
						status: "failed_or_incomplete",
						errorCode: mnemopiError,
						usage: {
							calls: mnemopi.usage?.memory?.calls ?? null,
							failed: mnemopi.usage?.memory?.failed ?? null,
							unknownUsage: mnemopi.usage?.memory?.unknownUsage ?? null,
							input: null,
							cacheRead: null,
							cacheWrite: null,
							output: null,
							costUsd: null,
							status: "partial_or_unknown_not_free",
						},
					}
				: offlineMnemopiSummary(mnemopi),
			piExcerpt,
			piCurated: { status: "not_run", reason: "No live curator call is part of the offline pass; live results are reported separately.", usage: usageUnknownForOffline() },
			mainUsage: usageUnknownForOffline(),
		},
		live: liveResult,
	};
	const reportPath = join(work, "report.json");
	writeFileSync(reportPath, JSON.stringify(output, null, 2));
	console.log(JSON.stringify({ reportPath, preparedPath, completedQuestions: liveResult.completedQuestions, error: mnemopiError ?? liveResult.workerError, stoppedEarly: liveResult.stoppedEarly }));
	if (mnemopiError || (options.live && (liveResult.workerError || liveResult.stoppedEarly || liveResult.workerExit || liveResult.status === "not_run"))) process.exitCode = 1;
}

main().catch((error) => {
	console.error(`R12 memory benchmark failed: ${error.message}`);
	process.exitCode = 1;
});
