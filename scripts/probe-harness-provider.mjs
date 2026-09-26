import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { getAgentDir } from "../packages/coding-agent/dist/config.js";
import { AuthStorage } from "../packages/coding-agent/dist/core/auth-storage.js";
import { ModelRuntime } from "../packages/coding-agent/dist/core/model-runtime.js";

const [run, provider, modelId, authPath] = process.argv.slice(2);
if (run !== "--run" || !provider || !modelId) {
	console.error("Usage: node scripts/probe-harness-provider.mjs --run <provider> <model> [private-auth-path]");
	process.exit(2);
}
const started = performance.now();
let runtime;
try {
	runtime = await ModelRuntime.create({
		...(authPath ? { authPath: authPath === "--stored-auth" ? join(getAgentDir(), "auth.json") : authPath } : { credentials: AuthStorage.inMemory() }),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const model = runtime.getModel(provider, modelId);
	if (!model) {
		console.log(JSON.stringify({ provider, model: modelId, state: "model-unavailable", candidates: runtime.getModels().filter((entry) => entry.provider === provider).map((entry) => entry.id).slice(0, 20) }));
		process.exitCode = 1;
	} else {
		const response = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Return exactly READY. This is a connectivity check with no private data.", timestamp: Date.now() }] }, { maxTokens: 256, reasoning: "minimal", signal: AbortSignal.timeout(30_000), maxRetries: 0 });
		const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
		const ok = response.stopReason === "stop" && text === "READY";
		const statusCode = response.errorMessage?.match(/\b(?:400|401|403|404|408|429|500|502|503)\b/)?.[0];
		console.log(JSON.stringify({ provider, model: modelId, state: ok ? "ready" : "not-ready", stopReason: response.stopReason, statusCode, outputMatches: text === "READY", durationMs: performance.now() - started, usage: response.usage }));
		if (!ok) process.exitCode = 1;
	}
} catch (error) {
	console.log(JSON.stringify({ provider, model: modelId, state: "failed", errorType: error instanceof Error ? error.name : "unknown", durationMs: performance.now() - started }));
	process.exitCode = 1;
}
