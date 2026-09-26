import { performance } from "node:perf_hooks";
import { HarnessUsageLedger } from "../packages/coding-agent/src/personal-harness/usage.ts";
import { completeHarnessTask, harnessResponseText, LUNA_MAX } from "../packages/coding-agent/src/personal-harness/model-call.ts";
import { PersonalMemoryStore } from "../packages/coding-agent/src/personal-harness/memory/index.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.ts";
import { MEMORY_BENCH_CORPUS, MEMORY_BENCH_QUESTIONS, MEMORY_BENCH_REVISION } from "./bench-memory-fixture.mjs";

const RESULT_MARKER = "BENCH_MEMORY_LIVE_RESULT ";

function safeErrorCode(error) {
	if (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)) return error.code;
	return error?.name === "AbortError" ? "ABORTED" : "BENCHMARK_ERROR";
}

function parseArgs(args) {
	const options = { agentDir: undefined };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--agent-dir") {
			const value = args[++index];
			if (!value) throw new Error("missing value for --agent-dir");
			options.agentDir = value;
		} else throw new Error(`unknown live-worker option: ${arg}`);
	}
	return options;
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

function parseJsonObject(text) {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
	const parsed = JSON.parse(trimmed);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("Expected a JSON object");
	return parsed;
}

function citationsFromCurator(text) {
	let value;
	try {
		value = parseJsonObject(text);
	} catch {
		return { text: "", citations: [] };
	}
	if (typeof value.text !== "string" || !Array.isArray(value.citations)) return { text: "", citations: [] };
	return { text: value.text, citations: value.citations };
}

function contextFromRecords(records) {
	return records.map((record) => {
		const status = `outcome=${record.outcome}`;
		return `[source=${record.entryId}; ${status}; revision=${record.sourceRevision}; range=${record.range.start}-${record.range.end}] ${record.excerpt}`;
	}).join("\n\n");
}

function contextFromMnemopi(records) {
	return records.map((record) => {
		const source = record.sourceId ?? "unknown-source";
		const status = record.outcome ? `; outcome=${record.outcome}` : "";
		return `[source=${source}${status}] ${record.content}`;
	}).join("\n\n");
}

function sourceIdsForMnemopi(records) {
	return [...new Set(records.map((record) => record.sourceId).filter((value) => typeof value === "string"))];
}

function sourceIdsForPi(result) {
	return [...new Set(result.citations.map((citation) => citation.entryId))];
}

function sourceIdsFromAnswer(value) {
	return Array.isArray(value.sourceIds) ? [...new Set(value.sourceIds.filter((id) => typeof id === "string"))] : [];
}

function classifyAnswer(value) {
	if (typeof value.answer !== "string") throw new TypeError("Answer JSON is missing a string answer");
	return {
		answer: value.answer,
		status: value.status === "insufficient" ? "insufficient" : "supported",
		sourceIds: sourceIdsFromAnswer(value),
	};
}

function scoreAnswer(question, answer, retrievedSourceIds) {
	const expected = question.expected;
	const answerMatches = expected.answerIncludes.every((needle) => answer.answer.includes(needle));
	const sourcesPresent = expected.sourceIds.every((id) => retrievedSourceIds.includes(id));
	const citedSourcesPresent = expected.sourceIds.every((id) => answer.sourceIds.includes(id));
	const staleContextIds = question.staleSourceIds.filter((id) => retrievedSourceIds.includes(id));
	const staleAnswerIds = question.staleSourceIds.filter((id) => answer.sourceIds.includes(id));
	const statusPreserved = expected.outcome === undefined ||
		(expected.outcome === "failed" ? /失敗|failed/iu.test(answer.answer) : /未確認|unverified/iu.test(answer.answer));
	const insufficientPreserved = expected.insufficient !== true || answer.status === "insufficient";
	return {
		answerMatches,
		sourcesPresent,
		citedSourcesPresent,
		staleContextIds,
		staleAnswerIds,
		statusPreserved,
		insufficientPreserved,
		passed: answerMatches && sourcesPresent && citedSourcesPresent && staleContextIds.length === 0 && staleAnswerIds.length === 0 && statusPreserved && insufficientPreserved,
	};
}

function normalizeUsage(snapshot, purpose = "main") {
	const totals = snapshot[purpose] ?? { calls: 0, failed: 0, unknownUsage: 0, unreportedCacheCalls: 0, unreportedCostCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimatedUsd: 0, durationMs: 0 };
	const usageUnknown = totals.unknownUsage > 0;
	const costUnknown = usageUnknown || totals.unreportedCostCalls > 0 || (totals.calls > 0 && totals.estimatedUsd === 0 && totals.input + totals.output > 0);
	return {
		calls: totals.calls,
		failed: totals.failed,
		unknownUsage: totals.unknownUsage,
		unreportedCacheCalls: totals.unreportedCacheCalls,
		unreportedCostCalls: totals.unreportedCostCalls,
		input: usageUnknown ? null : totals.input,
		cacheRead: usageUnknown ? null : totals.cacheRead,
		cacheWrite: usageUnknown ? null : totals.cacheWrite,
		output: usageUnknown ? null : totals.output,
		costUsd: costUnknown || totals.calls === 0 ? null : totals.estimatedUsd,
		durationMs: totals.durationMs,
	};
}

function percentile(values, fraction) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return Number(sorted[Math.ceil(fraction * sorted.length) - 1].toFixed(3));
}

function summarizeLatency(samples) {
	return {
		firstP50Ms: percentile(samples.map((sample) => sample.firstMs), 0.5),
		firstP95Ms: percentile(samples.map((sample) => sample.firstMs), 0.95),
		repeatP50Ms: percentile(samples.map((sample) => sample.repeatMs), 0.5),
		repeatP95Ms: percentile(samples.map((sample) => sample.repeatMs), 0.95),
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.agentDir) process.env.PI_CODING_AGENT_DIR = options.agentDir;
	const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	const registry = new ModelRegistry(modelRuntime);
	const mainLedgers = {
		mnemopi: new HarnessUsageLedger(),
		piExcerpt: new HarnessUsageLedger(),
		piCurated: new HarnessUsageLedger(),
	};
	const curatorLedger = new HarnessUsageLedger();
	const fatal = { error: undefined };
	const responseDiagnostics = [];

	async function callModel(purpose, ledger, systemPrompt, userPrompt, maxTokens) {
		if (fatal.error) throw fatal.error;
		try {
			return await completeHarnessTask({
				registry,
				selection: LUNA_MAX,
				purpose,
				context: {
					systemPrompt,
					messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
				},
				ledger,
				maxTokens,
			});
		} catch (error) {
			fatal.error = Object.assign(new Error("Live benchmark stopped after its first model-call failure"), { code: safeErrorCode(error) });
			throw fatal.error;
		}
	}

	const liveStore = new PersonalMemoryStore({
		databasePath: ":memory:",
		curate: async (query, records, signal) => {
			const prompt = JSON.stringify({
				query,
				candidates: records.map((record) => ({
					reference: {
						sessionId: record.sessionId,
						branchId: record.branchId,
						entryId: record.entryId,
						sourceRevision: record.sourceRevision,
						kind: record.kind,
						range: record.range,
					},
					role: record.role,
					outcome: record.outcome,
					excerpt: record.excerpt,
				})),
				instruction: "Return exactly one JSON object with text and citations. text must answer only from cited excerpts. citations must be flat objects with sessionId, branchId, entryId, sourceRevision, kind, and range, copied exactly from a candidate reference. Preserve failed, unverified, and corrected status; if evidence is insufficient, say so briefly.",
			});
			const response = await callModel("memory", curatorLedger, "You are the Pi task-adaptive memory curator. Produce a short, source-grounded recall result. Do not add uncited facts.", prompt, 1_024);
			signal.throwIfAborted();
			return citationsFromCurator(harnessResponseText(response));
		},
	});
	liveStore.index(sourceRecords());
	const excerptStore = new PersonalMemoryStore({ databasePath: ":memory:" });
	excerptStore.index(sourceRecords());

	const mnemopiInput = JSON.parse(await new Promise((resolveInput, rejectInput) => {
		let input = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => { input += chunk; });
		process.stdin.on("end", () => {
			try { resolveInput(input); } catch (error) { rejectInput(error); }
		});
	}));
	const mnemopiByQuestion = new Map(mnemopiInput.queries.map((result) => [result.questionId, result]));
	const resultRows = [];
	const latency = { mnemopi: [], piExcerpt: [], piCurated: [] };

	for (const question of MEMORY_BENCH_QUESTIONS) {
		if (fatal.error) break;
		const mnemopiResult = mnemopiByQuestion.get(question.id);
		const mnemopiCandidates = mnemopiResult?.first ?? [];
		const mnemopiSources = sourceIdsForMnemopi(mnemopiCandidates);
		const mnemopiContext = contextFromMnemopi(mnemopiCandidates);
		const excerptStart = performance.now();
		const excerptFirst = await excerptStore.recall(question.query);
		const excerptFirstMs = performance.now() - excerptStart;
		const excerptRepeatStart = performance.now();
		const excerptRepeat = await excerptStore.recall(question.query);
		const excerptRepeatMs = performance.now() - excerptRepeatStart;
		const curatedStart = performance.now();
		const curatedFirst = await liveStore.recall(question.query);
		const curatedFirstMs = performance.now() - curatedStart;
		if (curatedFirst.reason === "curation-failed" || curatedFirst.reason === "curation-aborted") {
			fatal.error = Object.assign(new Error("Curator call failed; remaining live cases were not sent"), { code: "CURATOR_FAILED" });
			break;
		}
		const curatedRepeatStart = performance.now();
		const curatedRepeat = await liveStore.recall(question.query);
		const curatedRepeatMs = performance.now() - curatedRepeatStart;
		if (curatedRepeat.reason === "curation-failed" || curatedRepeat.reason === "curation-aborted") {
			fatal.error = Object.assign(new Error("Repeated curator call failed; remaining live cases were not sent"), { code: "CURATOR_FAILED" });
			break;
		}

		const excerptContext = contextFromRecords(excerptFirst.records);
		const curatedContext = `${curatedFirst.content}\n\nCited source IDs: ${sourceIdsForPi(curatedFirst).join(", ")}`;
		const answerPrompts = [
			["mnemopi", mnemopiContext, mnemopiSources],
			["piExcerpt", excerptContext, sourceIdsForPi(excerptFirst)],
			["piCurated", curatedContext, sourceIdsForPi(curatedFirst)],
		];
		const answers = {};
		for (const [method, context, retrievedSourceIds] of answerPrompts) {
			if (fatal.error) break;
			const system = "Answer the user's question using only the supplied synthetic memory context. Preserve whether facts are failed or unverified. If no source supports the answer, return status=insufficient. Reply only as JSON: {\"answer\":string,\"status\":\"supported\"|\"insufficient\",\"sourceIds\":string[]}. Cite only source IDs present in the context.";
			const prompt = JSON.stringify({ question: question.query, memoryContext: context });
			try {
				const response = await callModel("main", mainLedgers[method], system, prompt, 1_024);
				responseDiagnostics.push({ questionId: question.id, method, stopReason: response.stopReason, text: harnessResponseText(response) });
				const answer = classifyAnswer(parseJsonObject(harnessResponseText(response)));
				answers[method] = {
					...answer,
					score: scoreAnswer(question, answer, retrievedSourceIds),
				};
			} catch (error) {
				fatal.error = Object.assign(new Error("Main-answer call or output parsing failed"), { code: safeErrorCode(error) });
			}
		}
		latency.mnemopi.push({ firstMs: mnemopiResult?.firstRecallMs ?? null, repeatMs: mnemopiResult?.repeatRecallMs ?? null });
		latency.piExcerpt.push({ firstMs: excerptFirstMs, repeatMs: excerptRepeatMs });
		latency.piCurated.push({ firstMs: curatedFirstMs, repeatMs: curatedRepeatMs });
		resultRows.push({
			questionId: question.id,
			retrieval: {
				mnemopi: { sourceIds: mnemopiSources, staleSourceIds: question.staleSourceIds.filter((id) => mnemopiSources.includes(id)) },
				piExcerpt: { sourceIds: sourceIdsForPi(excerptFirst), staleSourceIds: question.staleSourceIds.filter((id) => sourceIdsForPi(excerptFirst).includes(id)) },
				piCurated: { sourceIds: sourceIdsForPi(curatedFirst), status: curatedFirst.status, reason: curatedFirst.reason, staleSourceIds: question.staleSourceIds.filter((id) => sourceIdsForPi(curatedFirst).includes(id)) },
			},
			answers,
		});
	}

	liveStore.close();
	excerptStore.close();
	const output = {
		live: true,
		model: `${LUNA_MAX.provider}/${LUNA_MAX.model}`,
		thinking: LUNA_MAX.thinking,
		completedQuestions: resultRows.length,
		stoppedEarly: fatal.error !== undefined,
		stopCode: fatal.error ? safeErrorCode(fatal.error) : undefined,
		latency: {
			mnemopi: summarizeLatency(latency.mnemopi.filter((sample) => Number.isFinite(sample.firstMs))),
			piExcerpt: summarizeLatency(latency.piExcerpt),
			piCurated: summarizeLatency(latency.piCurated),
		},
		usage: {
			mnemopi: { memory: normalizeUsage(mnemopiInput.usage ?? {}, "memory"), main: normalizeUsage(mainLedgers.mnemopi.snapshot()) },
			piExcerpt: { memory: normalizeUsage({}), main: normalizeUsage(mainLedgers.piExcerpt.snapshot()) },
			piCurated: { memory: normalizeUsage(curatorLedger.snapshot(), "memory"), main: normalizeUsage(mainLedgers.piCurated.snapshot()) },
		},
		results: resultRows,
		responseDiagnostics,
	};
	console.log(`${RESULT_MARKER}${JSON.stringify(output)}`);
	modelRuntime.dispose?.();
	if (fatal.error) process.exitCode = 1;
}

main().catch((error) => {
	console.error(`${RESULT_MARKER}${JSON.stringify({ error: safeErrorCode(error) })}`);
	process.exitCode = 1;
});
