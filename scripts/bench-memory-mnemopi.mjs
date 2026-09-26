import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HarnessUsageLedger } from "../packages/coding-agent/src/personal-harness/usage.ts";
import { completeHarnessTask, harnessResponseText, LUNA_MAX } from "../packages/coding-agent/src/personal-harness/model-call.ts";
import { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { MEMORY_BENCH_CORPUS, MEMORY_BENCH_QUESTIONS } from "./bench-memory-fixture.mjs";

const RESULT_MARKER = "BENCH_MEMORY_MNEMOPI_RESULT ";
let liveRequested = false;
let activeLedger;

function parseArgs(args) {
	const options = { ompRoot: undefined, live: false, agentDir: undefined };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--omp-root" || arg === "--agent-dir") {
			const value = args[++index];
			if (!value) throw new Error(`missing value for ${arg}`);
			if (arg === "--omp-root") options.ompRoot = resolve(value);
			else options.agentDir = resolve(value);
		} else if (arg === "--live") options.live = true;
		else throw new Error(`unknown worker option: ${arg}`);
	}
	if (!options.ompRoot) throw new Error("--omp-root is required");
	return options;
}

function sourceIdFor(item, idByMemoryId) {
	if (typeof item?.metadata?.fixtureId === "string") return item.metadata.fixtureId;
	if (typeof item?.source_id === "string" && idByMemoryId.has(item.source_id)) return idByMemoryId.get(item.source_id);
	return idByMemoryId.get(item?.id);
}

function renderResults(items, idByMemoryId, memory, question) {
	return items.map((item) => {
		const sourceId = sourceIdFor(item, idByMemoryId);
		const outcome = typeof item?.metadata?.outcome === "string" ? item.metadata.outcome : undefined;
		const readStarted = performance.now();
		const fullRow = typeof item?.id === "string" ? memory.get(item.id) : null;
		const sourceReadMs = performance.now() - readStarted;
		const fullContent = typeof fullRow?.content === "string" ? fullRow.content : "";
		return {
			...(sourceId ? { sourceId } : {}),
			...(outcome ? { outcome } : {}),
			content: typeof item?.content === "string" ? item.content : "",
			fullSourceRead: {
				available: fullContent.length > 0,
				sourceReadMs,
				characters: fullContent.length,
				expectedAnswerTextPresent: question.expected.answerIncludes.every((value) => fullContent.includes(value)),
			},
		};
	});
}

function safeErrorCode(error) {
	if (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)) return error.code;
	return error?.name === "AbortError" ? "ABORTED" : "BENCHMARK_ERROR";
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	liveRequested = options.live;
	const entryPath = resolve(options.ompRoot, "packages/mnemopi/src/index.ts");
	const { Mnemopi } = await import(pathToFileURL(entryPath).href);
	let registry;
	let runtime;
	if (options.live) {
		if (options.agentDir) process.env.PI_CODING_AGENT_DIR = options.agentDir;
		runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		registry = new ModelRegistry(runtime);
	}

	const ledger = new HarnessUsageLedger();
	activeLedger = ledger;
	const completion = options.live
		? async (prompt, taskOptions) => {
				try {
					const response = await completeHarnessTask({
						registry,
						selection: LUNA_MAX,
						purpose: "memory",
						context: { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
						...(taskOptions?.signal instanceof AbortSignal ? { signal: taskOptions.signal } : {}),
						ledger,
						timeoutMs: typeof taskOptions?.timeout === "number" ? taskOptions.timeout : 120_000,
						maxTokens: typeof taskOptions?.maxTokens === "number" ? taskOptions.maxTokens : 2_048,
					});
					return harnessResponseText(response);
				} catch (error) {
					throw Object.assign(new Error("Mnemopi fixture extraction failed"), { code: safeErrorCode(error) });
				}
			}
		: false;
	const memory = new Mnemopi({ dbPath: ":memory:", bank: "synthetic-r12-v1", embeddings: false, llm: completion, reconcile: false });
	const idByMemoryId = new Map();
	const prepareStart = performance.now();
	for (const record of MEMORY_BENCH_CORPUS) {
		const id = memory.remember(record.content, {
			source: "synthetic-fixture",
				importance: record.outcome === "completed" ? 0.8 : 0.65,
				metadata: { fixtureId: record.id, role: record.role, outcome: record.outcome },
				extract: true,
				extractText: record.content,
				veracity: record.outcome === "failed" ? "false" : "unknown",
				memoryType: "episode",
		});
		idByMemoryId.set(id, record.id);
	}
	await memory.flushExtractions();
	const prepareMs = performance.now() - prepareStart;

	const queries = [];
	for (const question of MEMORY_BENCH_QUESTIONS) {
		const firstStart = performance.now();
		const first = await memory.recall(question.query, 3);
		const firstRecallMs = performance.now() - firstStart;
		const repeatStart = performance.now();
		const repeated = await memory.recall(question.query, 3);
		const repeatRecallMs = performance.now() - repeatStart;
		queries.push({
			questionId: question.id,
			firstRecallMs,
			repeatRecallMs,
			first: renderResults(first, idByMemoryId, memory, question),
			repeated: renderResults(repeated, idByMemoryId, memory, question),
		});
	}

	memory.close();
	runtime?.dispose?.();
	console.log(`${RESULT_MARKER}${JSON.stringify({
		mode: "official-mnemopi-public-api",
		database: ":memory:",
		live: options.live,
		embeddings: "disabled",
		retentionExtraction: options.live ? "LUNA/max via completeHarnessTask" : "official deterministic no-LLM path",
		prepareMs,
		usage: ledger.snapshot(),
		queries,
	})}`);
}

main().catch((error) => {
	console.error(`${RESULT_MARKER}${JSON.stringify({ error: safeErrorCode(error), live: liveRequested, usage: activeLedger?.snapshot() ?? null })}`);
	process.exitCode = 1;
});
