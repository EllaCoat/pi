import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { getAgentDir } from "../packages/coding-agent/dist/config.js";
import { AuthStorage } from "../packages/coding-agent/dist/core/auth-storage.js";
import { ModelRuntime } from "../packages/coding-agent/dist/core/model-runtime.js";

const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-6-luna";
const SESSION_ID = "pi-harness-cache-probe-20260926";
const PREFIX_SEGMENTS = 192;
const FIXED_TIMESTAMP = 1_790_000_000_000;
const FIXED_USER_PROMPT = "Return exactly CACHE_OK.";
const ARTIFICIAL_PREFIX = Array.from(
	{ length: PREFIX_SEGMENTS },
	(_, index) => `Artificial cache probe segment ${String(index + 1).padStart(4, "0")}: fixed synthetic text for cache-prefix measurement only.`,
).join("\n");
const REQUESTS = [
	{ name: "positive-warmup", marker: "CACHE_PREFIX_ALPHA" },
	{ name: "positive-repeat", marker: "CACHE_PREFIX_ALPHA" },
	{ name: "negative-changed-prefix", marker: "CACHE_PREFIX_BRAVO" },
];

function readArgs(args) {
	const options = { run: false, output: undefined };
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--run") {
			options.run = true;
		} else if (args[index] === "--output") {
			options.output = args[++index];
			if (!options.output) throw new Error("missing-value-for-output");
		} else {
			throw new Error("unknown-argument");
		}
	}
	if (!options.run || !options.output) throw new Error("usage: node scripts/probe-harness-cache.mjs --run --output <new-report.json>");
	return options;
}

function promptFor(marker) {
	return `${marker}\n${ARTIFICIAL_PREFIX}\nReturn exactly CACHE_OK.`;
}

function hashText(text) {
	return createHash("sha256").update(text).digest("hex");
}

function finiteOrNull(value) {
	return Number.isFinite(value) ? value : null;
}

function statusCode(errorText) {
	return typeof errorText === "string" ? errorText.match(/\b(?:400|401|403|404|408|429|500|502|503|504)\b/u)?.[0] : undefined;
}

function errorRecord(error) {
	const message = error instanceof Error ? error.message : "";
	return {
		errorType: error instanceof Error ? error.name : "unknown",
		...(statusCode(message) ? { statusCode: statusCode(message) } : {}),
	};
}

function collectProviderUsage(event) {
	if (!event || typeof event !== "object" || (event.type !== "response.completed" && event.type !== "response.incomplete")) return undefined;
	const usage = event.response?.usage;
	if (!usage || typeof usage !== "object") return undefined;
	return usage;
}

const options = readArgs(process.argv.slice(2));
const report = {
	benchmark: "gpt-6-luna-prompt-cache-probe",
	startedAt: new Date().toISOString(),
	conditions: {
		provider: PROVIDER,
		model: MODEL_ID,
		auth: "Pi AuthStorage at the configured agent auth path; credential values are not read or emitted by this script",
		sessionId: SESSION_ID,
		transport: "sse",
		cacheRetention: "short",
		maxRetries: 0,
		maxTokens: 32,
		reasoning: "minimal",
		sequence: REQUESTS.map(({ name }) => name),
		prefixSegments: PREFIX_SEGMENTS,
		prefixCharacters: ARTIFICIAL_PREFIX.length,
		promptHashes: REQUESTS.map(({ name, marker }) => ({ name, sha256: hashText(promptFor(marker)), characters: promptFor(marker).length })),
	},
	requests: [],
	status: "not-started",
};
let runtime;
try {
	const authPath = join(getAgentDir(), "auth.json");
	const authStorage = AuthStorage.create(authPath);
	runtime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const model = runtime.getModel(PROVIDER, MODEL_ID);
	if (!model) throw Object.assign(new Error("model-unavailable"), { name: "ProbeSetupError" });
	report.startedAt = new Date().toISOString();
	report.status = "running";
	for (const request of REQUESTS) {
		const prompt = promptFor(request.marker);
		const started = performance.now();
		let providerUsage;
		let response;
		try {
			response = await runtime.completeSimple(
				model,
				{
					systemPrompt: prompt,
					messages: [{ role: "user", content: FIXED_USER_PROMPT, timestamp: FIXED_TIMESTAMP }],
				},
				{
					maxTokens: 32,
					reasoning: "minimal",
					maxRetries: 0,
					sessionId: SESSION_ID,
					transport: "sse",
					cacheRetention: "short",
					signal: AbortSignal.timeout(60_000),
					onProviderStreamEvent(event) {
						providerUsage = collectProviderUsage(event);
					},
				},
			);
		} catch (error) {
			report.requests.push({
				name: request.name,
				promptSha256: hashText(prompt),
				status: "communication-failed",
				durationMs: performance.now() - started,
				...errorRecord(error),
				usage: {
					inputTokens: null,
					inputTokensUnknown: true,
					outputTokens: null,
					outputTokensUnknown: true,
					cacheReadTokens: null,
					cacheReadTokensUnknown: true,
					cacheWriteTokens: null,
					cacheWriteTokensUnknown: true,
					feeUsd: null,
					feeUnknown: true,
				},
			});
			report.status = "communication-failed";
			break;
		}
		const usage = response.usage;
		const rawUsage = providerUsage;
		const inputDetails = rawUsage?.input_tokens_details;
		const cost = usage?.cost?.total;
		const failed = response.stopReason === "error" || response.stopReason === "aborted";
		report.requests.push({
			name: request.name,
			promptSha256: hashText(prompt),
			status: failed ? "communication-failed" : "completed",
			durationMs: performance.now() - started,
			stopReason: response.stopReason,
			outputMatches: response.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim() === "CACHE_OK",
			providerUsagePresent: rawUsage !== undefined,
			usage: {
				inputTokens: rawUsage && Number.isFinite(rawUsage.input_tokens) ? finiteOrNull(usage?.input) : null,
				inputTokensUnknown: !rawUsage || !Number.isFinite(rawUsage.input_tokens),
				outputTokens: rawUsage && Number.isFinite(rawUsage.output_tokens) ? finiteOrNull(usage?.output) : null,
				outputTokensUnknown: !rawUsage || !Number.isFinite(rawUsage.output_tokens),
				cacheReadTokens: Number.isFinite(inputDetails?.cached_tokens) ? finiteOrNull(usage?.cacheRead) : null,
				cacheReadTokensUnknown: !Number.isFinite(inputDetails?.cached_tokens),
				cacheWriteTokens: Number.isFinite(inputDetails?.cache_write_tokens) ? finiteOrNull(usage?.cacheWrite) : null,
				cacheWriteTokensUnknown: !Number.isFinite(inputDetails?.cache_write_tokens),
				feeUsd: finiteOrNull(cost),
				feeUnknown: !Number.isFinite(cost),
				feeBasis: "ModelRuntime usage.cost.total catalog-rate estimate; provider invoice was not queried",
			},
			...(failed ? errorRecord(new Error(response.errorMessage ?? "provider-response-failed")) : {}),
		});
		if (failed) {
			report.status = "communication-failed";
			break;
		}
	}
	if (report.status === "running") report.status = "completed";
} catch (error) {
	report.status = "setup-failed";
	report.failure = errorRecord(error);
} finally {
	report.finishedAt = new Date().toISOString();
	report.summary = {
		requestsAttempted: report.requests.length,
		positiveRepeatCacheReadTokens: report.requests[1]?.usage.cacheReadTokens ?? null,
		positiveRepeatCacheReadUnknown: report.requests[1]?.usage.cacheReadTokensUnknown ?? true,
		changedPrefixCacheReadTokens: report.requests[2]?.usage.cacheReadTokens ?? null,
		changedPrefixCacheReadUnknown: report.requests[2]?.usage.cacheReadTokensUnknown ?? true,
	};
	await mkdir(dirname(options.output), { recursive: true });
	await writeFile(options.output, JSON.stringify(report, null, 2), { flag: "wx" });
	console.log(JSON.stringify({ report: options.output, ...report }));
}
if (report.status !== "completed") process.exitCode = 1;
