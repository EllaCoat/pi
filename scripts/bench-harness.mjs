import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { REQUEST_NORMALIZATION } from "./bench-harness-fixture.mjs";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const READY_MARKER = "BENCH_HARNESS_READY ";
const RESULT_MARKER = "BENCH_HARNESS_RESULT ";
const ERROR_MARKER = "BENCH_HARNESS_ERROR ";
const DEFAULT_RUNS = 5;
const PROCESS_TIMEOUT_MS = 180_000;

function usage() {
	console.log("Usage: node scripts/bench-harness.mjs [--runtime pi|omp|both] [--runs 1..20] [--bun <executable>] [--omp-root <source-root>] [--output <new-report.json>]");
	console.log("Runs only an offline synthetic-provider benchmark; it never calls a real model API.");
}

function parseArgs(args) {
	const options = { runtime: "both", runs: DEFAULT_RUNS, bun: "bun", ompRoot: undefined, output: undefined };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--runtime" || arg === "--runs" || arg === "--bun" || arg === "--omp-root" || arg === "--output") {
			const value = args[++index];
			if (!value) throw new Error(`missing value for ${arg}`);
			if (arg === "--runtime") options.runtime = value;
			if (arg === "--runs") options.runs = Number(value);
			if (arg === "--bun") options.bun = value;
			if (arg === "--omp-root") options.ompRoot = resolve(value);
			if (arg === "--output") options.output = resolve(value);
			continue;
		}
		throw new Error(`unknown option: ${arg}`);
	}
	if (!["pi", "omp", "both"].includes(options.runtime)) throw new Error("--runtime must be pi, omp, or both");
	if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) throw new Error("--runs must be an integer from 1 through 20");
	if (options.runtime !== "pi" && !options.ompRoot) throw new Error("--omp-root is required for an OMP comparison");
	return options;
}

function isolatedEnvironment(tempRoot) {
	const env = {};
	const inheritedNames = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"];
	for (const name of inheritedNames) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	env.USERPROFILE = tempRoot;
	env.HOME = tempRoot;
	env.PI_CODING_AGENT_DIR = join(tempRoot, "pi-agent");
	env.OMP_PROFILE = join(tempRoot, "omp-profile");
	env.PI_PROFILE = join(tempRoot, "pi-profile");
	env.PI_CONFIG_FILES = "";
	env.PI_OFFLINE = "1";
	return env;
}

function parseMarker(line, marker) {
	if (!line.startsWith(marker)) return undefined;
	try {
		return JSON.parse(line.slice(marker.length));
	} catch {
		return undefined;
	}
}

function runWorker({ command, args, cwd, env, label }) {
	return new Promise((resolveResult) => {
		const startedAt = performance.now();
		let startupMs;
		let ready;
		let result;
		let workerError;
		let spawnError;
		let timedOut = false;
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, PROCESS_TIMEOUT_MS);
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			const readyValue = parseMarker(line, READY_MARKER);
			if (readyValue) {
				ready = readyValue;
				startupMs ??= performance.now() - startedAt;
				return;
			}
			const resultValue = parseMarker(line, RESULT_MARKER);
			if (resultValue) {
				result = resultValue;
				return;
			}
			const errorValue = parseMarker(line, ERROR_MARKER);
			if (errorValue) workerError = errorValue;
		});
		child.stderr.resume();
		child.on("error", (error) => {
			spawnError = error;
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			lines.close();
			const valid = code === 0 && ready !== undefined && result !== undefined && workerError === undefined;
			resolveResult({
				label,
				ok: valid,
				startupMs,
				ready,
				result,
				failure: valid
					? undefined
					: {
						errorType: workerError?.errorType ?? (spawnError instanceof Error ? spawnError.code ?? spawnError.name : timedOut ? "timeout" : ready ? "missing-result" : "missing-ready"),
						...(workerError?.errorMessage ? { errorMessage: workerError.errorMessage } : {}),
						exitCode: code,
						signal,
						timedOut,
					},
			});
		});
	});
}

function stats(values) {
	const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
	if (sorted.length === 0) return null;
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	return { median, p95: sorted[Math.ceil(sorted.length * 0.95) - 1], min: sorted[0], max: sorted[sorted.length - 1], samples: sorted.length };
}

function combineEventCounts(samples) {
	const result = {};
	for (const sample of samples) {
		for (const [type, count] of Object.entries(sample.result.eventCounts ?? {})) {
			result[type] = (result[type] ?? 0) + count;
		}
	}
	return result;
}

function summarizeRuntime(samples) {
	const turns = samples.flatMap((sample) => sample.result.turns.map((turn) => ({ ...turn, processStartupMs: sample.startupMs })));
	const cold = turns.filter((turn) => turn.kind === "cold");
	const warm = turns.filter((turn) => turn.kind === "warm");
	const allResults = samples.map((sample) => sample.result);
	return {
		samples: samples.length,
		condition: allResults[0]?.runtime === "pi" ? `Node ${allResults[0].runtimeVersion}` : `Bun ${samples[0]?.ready?.bunVersion ?? "unknown"} / OMP ${allResults[0]?.runtimeVersion}`,
		startupMs: stats(samples.map((sample) => sample.startupMs)),
		setupMs: stats(allResults.map((result) => result.setupMs)),
		coldTurn: {
			elapsedMs: stats(cold.map((turn) => turn.elapsedMs)),
			localOverheadMs: stats(cold.map((turn) => turn.localOverheadMs)),
			modelDelayMs: stats(cold.map((turn) => turn.modelDelayMs)),
		},
		warmTurns: {
			count: warm.length,
			elapsedMs: stats(warm.map((turn) => turn.elapsedMs)),
			localOverheadMs: stats(warm.map((turn) => turn.localOverheadMs)),
			modelDelayMs: stats(warm.map((turn) => turn.modelDelayMs)),
		},
		modelCallsPerProcess: stats(allResults.map((result) => result.modelCalls)),
		toolExecutionsPerProcess: stats(allResults.map((result) => result.toolExecutions)),
		rssReadyBytes: stats(allResults.map((result) => result.rssReadyBytes)),
		rssAfterTurnsBytes: stats(allResults.map((result) => result.rssAfterTurnsBytes)),
		rssDeltaBytes: stats(allResults.map((result) => result.rssDeltaBytes)),
		eventCountsAcrossSamples: combineEventCounts(samples),
		fixtureHashes: [...new Set(allResults.map((result) => result.fixtureHash))],
		requestHashesBySample: allResults.map((result) => result.requestHashes),
	};
}

function collectDifferences(left, right, path, differences) {
	if (Object.is(left, right)) return;
	if (Array.isArray(left) && Array.isArray(right)) {
		for (let index = 0; index < Math.max(left.length, right.length); index++) {
			collectDifferences(left[index], right[index], `${path}[${index}]`, differences);
		}
		return;
	}
	const leftIsRecord = typeof left === "object" && left !== null && !Array.isArray(left);
	const rightIsRecord = typeof right === "object" && right !== null && !Array.isArray(right);
	if (leftIsRecord && rightIsRecord) {
		const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
		for (const key of [...keys].sort()) {
			const childPath = /^[A-Za-z_$][\w$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
			collectDifferences(left[key], right[key], childPath, differences);
		}
		return;
	}
	differences.push({
		path,
		pi: left === undefined ? { missing: true } : left,
		omp: right === undefined ? { missing: true } : right,
	});
}

function compareRequestParity(resultsByRuntime) {
	if (!resultsByRuntime.pi || !resultsByRuntime.omp) return { state: "not-compared-single-runtime" };
	const piRuns = resultsByRuntime.pi;
	const ompRuns = resultsByRuntime.omp;
	const runCount = Math.min(piRuns.length, ompRuns.length);
	const mismatches = [];
	const pathCounts = new Map();
	const examples = new Map();
	let requestPairs = 0;
	for (let runIndex = 0; runIndex < runCount; runIndex++) {
		const piResult = piRuns[runIndex].result;
		const ompResult = ompRuns[runIndex].result;
		if (!Array.isArray(piResult.requestDetails) || !Array.isArray(ompResult.requestDetails)) {
			return { state: "request-details-unavailable", comparedRuns: runCount, requestPairs, mismatchCount: null };
		}
		const requestCount = Math.max(piResult.requestDetails.length, ompResult.requestDetails.length);
		for (let requestIndex = 0; requestIndex < requestCount; requestIndex++) {
			requestPairs++;
			const piRequest = piResult.requestDetails[requestIndex];
			const ompRequest = ompResult.requestDetails[requestIndex];
			const differences = [];
			collectDifferences(piRequest, ompRequest, "$", differences);
			if (differences.length === 0) continue;
			mismatches.push({
				run: runIndex + 1,
				request: requestIndex + 1,
				pi: piResult.requestHashes[requestIndex] ?? null,
				omp: ompResult.requestHashes[requestIndex] ?? null,
				paths: differences.map((difference) => difference.path),
			});
			for (const difference of differences) {
				pathCounts.set(difference.path, (pathCounts.get(difference.path) ?? 0) + 1);
				if (!examples.has(difference.path)) {
					examples.set(difference.path, {
						run: runIndex + 1,
						request: requestIndex + 1,
						pi: difference.pi,
						omp: difference.omp,
					});
				}
			}
		}
	}
	return {
		state: mismatches.length === 0 ? "exact-match" : "mismatch",
		normalization: REQUEST_NORMALIZATION,
		comparedRuns: runCount,
		requestPairs,
		mismatchCount: mismatches.length,
		mismatchPaths: [...pathCounts].map(([path, count]) => ({ path, count })).sort((left, right) => right.count - left.count || left.path.localeCompare(right.path)),
		mismatchExamples: [...examples].slice(0, 30).map(([path, values]) => ({ path, ...values })),
		firstMismatches: mismatches.slice(0, 10),
	};
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "invalid arguments");
		usage();
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		usage();
		return;
	}

	const selected = options.runtime === "both" ? ["pi", "omp"] : [options.runtime];
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-harness-bench-parent-"));
	const env = isolatedEnvironment(tempRoot);
	env.HARNESS_BENCH_CWD = tempRoot;
	if (options.ompRoot) env.HARNESS_OMP_ROOT = options.ompRoot;
	const runsByRuntime = Object.fromEntries(selected.map((runtime) => [runtime, []]));
	const failures = [];
	try {
		for (let runIndex = 0; runIndex < options.runs; runIndex++) {
			const order = options.runtime === "both" && runIndex % 2 === 1 ? [...selected].reverse() : selected;
			for (const runtime of order) {
				const isPi = runtime === "pi";
				const command = isPi ? process.execPath : options.bun;
				const args = isPi
					? [join(SCRIPTS_DIR, "bench-harness-pi.mjs"), "--worker"]
					: [join(SCRIPTS_DIR, "bench-harness-omp.mjs"), "--worker"];
				const worker = await runWorker({ command, args, cwd: isPi ? REPO_ROOT : options.ompRoot, env, label: runtime });
				if (!worker.ok) {
					failures.push({ runtime, run: runIndex + 1, ...worker.failure });
					continue;
				}
				runsByRuntime[runtime].push(worker);
			}
		}
		const summaries = Object.fromEntries(Object.entries(runsByRuntime).map(([runtime, samples]) => [runtime, summarizeRuntime(samples)]));
		const hasBothComplete = selected.includes("pi") && selected.includes("omp") && runsByRuntime.pi.length === options.runs && runsByRuntime.omp.length === options.runs;
		const report = {
			benchmark: "offline-core-overhead",
			mode: "synthetic provider only; no real model API or provider credentials",
				runsRequested: options.runs,
				warmTurnsPerProcess: 5,
				fixtureHashes: [...new Set(Object.values(runsByRuntime).flat().map((sample) => sample.result.fixtureHash))],
			runtimes: summaries,
			requestParity: hasBothComplete ? compareRequestParity(runsByRuntime) : { state: selected.length === 1 ? "not-compared-single-runtime" : "incomplete-runtime-samples" },
			cacheEvidence: "none; the 20 ms provider delay is synthetic and provides no cache-hit evidence",
			limitations: ["Node and Bun are measured as their actual runtime conditions.", "Only this isolated session/model/tool path is measured; hooks, MCP, subagents, compaction and background jobs are excluded.", "localOverheadMs is elapsed turn time minus the known synthetic provider delay, so it also contains tool execution and event dispatch."],
			failures,
			complete: selected.every((runtime) => runsByRuntime[runtime].length === options.runs),
		};
		if (options.output) writeFileSync(options.output, JSON.stringify(report, null, 2), { flag: "wx" });
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		if (!report.complete) process.exitCode = 1;
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : "benchmark failed");
	process.exitCode = 1;
});
