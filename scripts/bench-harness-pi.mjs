import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { AuthStorage } from "../packages/coding-agent/src/core/auth-storage.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import {
	API_ID,
	FINAL_ANSWER,
	FIXED_TIMESTAMP,
	HISTORY,
	MODEL_DELAY_MS,
	MODEL_ID,
	PROVIDER_ID,
	SESSION_ID,
	SYSTEM_PROMPT,
	TOOL_DESCRIPTION,
	TOOL_INPUT,
	TOOL_NAME,
	TOOL_RESULT,
	USER_PROMPT,
	WARM_TURN_COUNT,
	fingerprintRequest,
	fixtureFingerprint,
	normalizeRequest,
} from "./bench-harness-fixture.mjs";
const READY_MARKER = "BENCH_HARNESS_READY ";
const RESULT_MARKER = "BENCH_HARNESS_RESULT ";
const ERROR_MARKER = "BENCH_HARNESS_ERROR ";

function emit(marker, value) {
	process.stdout.write(`${marker}${JSON.stringify(value)}\n`);
}

function addEventCount(counts, event) {
	const type = event && typeof event === "object" && "type" in event ? event.type : undefined;
	if (typeof type === "string") counts[type] = (counts[type] ?? 0) + 1;
}

function lastAssistantText(session) {
	const messages = session.agent.state.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const content = Array.isArray(message.content) ? message.content : [];
		return content.filter((part) => part.type === "text").map((part) => part.text).join("");
	}
	return "";
}

async function run() {
	if (process.argv[2] !== "--worker") {
		console.error("Usage: node scripts/bench-harness-pi.mjs --worker");
		process.exitCode = 2;
		return;
	}

	emit(READY_MARKER, { runtime: "pi", process: process.version, rssBytes: process.memoryUsage().rss });
	const startedAt = performance.now();
	const tempDir = mkdtempSync(join(tmpdir(), "pi-harness-bench-"));
	const fixtureCwd = process.env.HARNESS_BENCH_CWD ?? tempDir;
	const authStorage = AuthStorage.inMemory();
	const faux = registerFauxProvider({
		api: API_ID,
		provider: PROVIDER_ID,
		models: [{ id: MODEL_ID, name: MODEL_ID, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 1024 }],
		tokensPerSecond: 0,
	});
	let runtime;
	let session;
	let toolExecutions = 0;
	let mockProviderCalls = 0;
	const requestHashes = [];
	const requestDetails = [];
	const eventCounts = {};
	const estimatedModelDelayMs = () => mockProviderCalls * MODEL_DELAY_MS;

	try {
		await authStorage.modify(PROVIDER_ID, async () => ({ type: "api_key", key: "offline-fixture-only" }));
		runtime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		runtime.registerProvider(PROVIDER_ID, {
			name: PROVIDER_ID,
			baseUrl: faux.models[0].baseUrl,
			apiKey: "offline-fixture-only",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				inputLimits: model.inputLimits,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});
		const model = runtime.getModel(PROVIDER_ID, MODEL_ID);
		if (!model) throw new Error("fixture model registration failed");

		const promptSteps = Array.from({ length: (WARM_TURN_COUNT + 1) * 2 }, () => async (context, options) => {
			mockProviderCalls++;
			const callNumber = mockProviderCalls;
			requestDetails.push(normalizeRequest(context, options));
			requestHashes.push(fingerprintRequest(context, options));
			await delay(MODEL_DELAY_MS);
			if (callNumber % 2 === 1) {
				return fauxAssistantMessage(
					[fauxToolCall(TOOL_NAME, { value: TOOL_INPUT, i: "Record fixture action" }, { id: `benchmark-call-${Math.ceil(callNumber / 2)}` })],
					{ stopReason: "toolUse", timestamp: FIXED_TIMESTAMP + callNumber },
				);
			}
			return fauxAssistantMessage(FINAL_ANSWER, { timestamp: FIXED_TIMESTAMP + callNumber });
		});
		faux.setResponses(promptSteps);

		const tool = {
			name: TOOL_NAME,
			label: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			parameters: Type.Object({ value: Type.String(), i: Type.String({ description: "concise intent" }) }, { additionalProperties: false }),
			replay: "never",
			async execute(_toolCallId, input) {
				if (!input || input.value !== TOOL_INPUT) throw new Error("fixture tool input mismatch");
				toolExecutions++;
				return { content: [{ type: "text", text: TOOL_RESULT }] };
			},
		};
		const extensions = { extensions: [{ path: "benchmark-fixed-prompt", resolvedPath: "benchmark-fixed-prompt", handlers: new Map([["before_agent_start", [() => ({ systemPrompt: SYSTEM_PROMPT })]]]), tools: new Map(), commands: new Map(), shortcuts: new Map(), flags: new Map() }], errors: [], runtime: createExtensionRuntime() };
		const resourceLoader = {
			getExtensions: () => extensions,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		};
		const sessionManager = SessionManager.inMemory(fixtureCwd, { id: SESSION_ID });
		const today = new Date();
		const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
		const reminder = `<system-reminder>\nToday: ${date}; current working directory: '${fixtureCwd.replace(/\\/g, "/")}'. Do not repeat this information in your reply.\n</system-reminder>`;
		for (const [index, message] of HISTORY.entries()) sessionManager.appendMessage(index === 0 ? { ...message, content: `${reminder}\n\n${message.content}` } : message);
		const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
		const result = await createAgentSession({
			cwd: fixtureCwd,
			agentDir: tempDir,
			model,
			modelRuntime: runtime,
			sessionManager,
			settingsManager,
			resourceLoader,
			tools: [TOOL_NAME],
			customTools: [tool],
			noTools: "all",
		});
		session = result.session;
		const sessionMessages = [...session.agent.state.messages];
		if (sessionMessages[0]?.role === "system") {
			sessionMessages[0] = { ...sessionMessages[0], content: SYSTEM_PROMPT };
		} else {
			sessionMessages.unshift({ role: "system", content: SYSTEM_PROMPT, timestamp: 0 });
		}
		session.agent.state.messages = sessionMessages;
		const unsubscribe = session.subscribe((event) => addEventCount(eventCounts, event));
		const rssReadyBytes = process.memoryUsage().rss;
		const setupMs = performance.now() - startedAt;

		const turns = [];
		for (let index = 0; index <= WARM_TURN_COUNT; index++) {
			const beforeCalls = mockProviderCalls;
			const beforeTools = toolExecutions;
			const beforeEvents = Object.values(eventCounts).reduce((total, count) => total + count, 0);
			const turnStarted = performance.now();
			await session.prompt(USER_PROMPT);
			const elapsedMs = performance.now() - turnStarted;
			const turnCalls = mockProviderCalls - beforeCalls;
			const turnTools = toolExecutions - beforeTools;
			if (turnCalls !== 2 || turnTools !== 1 || lastAssistantText(session) !== FINAL_ANSWER) {
				throw new Error("offline fixture turn did not meet its expected behavior");
			}
			const eventTotal = Object.values(eventCounts).reduce((total, count) => total + count, 0);
			turns.push({
				kind: index === 0 ? "cold" : "warm",
					elapsedMs,
					modelDelayMs: turnCalls * MODEL_DELAY_MS,
					localOverheadMs: Math.max(0, elapsedMs - turnCalls * MODEL_DELAY_MS),
					modelCalls: turnCalls,
					toolExecutions: turnTools,
					sessionEventCount: eventTotal - beforeEvents,
				});
		}
		unsubscribe();
		const rssAfterTurnsBytes = process.memoryUsage().rss;
		if (mockProviderCalls !== (WARM_TURN_COUNT + 1) * 2 || toolExecutions !== WARM_TURN_COUNT + 1) {
			throw new Error("offline fixture aggregate counts did not match");
		}

		emit(RESULT_MARKER, {
			runtime: "pi",
			runtimeVersion: process.version,
			fixtureHash: fixtureFingerprint(),
			setupMs,
			rssReadyBytes,
			rssAfterTurnsBytes,
			rssDeltaBytes: rssAfterTurnsBytes - rssReadyBytes,
			modelCalls: mockProviderCalls,
			toolExecutions,
			injectedModelDelayMs: estimatedModelDelayMs(),
			eventCounts,
			requestHashes,
			requestDetails,
			turns,
		});
	} finally {
		if (session) await session.dispose();
		runtime?.unregisterProvider(PROVIDER_ID);
		faux.unregister();

		rmSync(tempDir, { recursive: true, force: true });
	}
}

run().catch((error) => {
	emit(ERROR_MARKER, {
		errorType: error instanceof Error ? error.name : "unknown",
		errorMessage: error instanceof Error ? error.message.slice(0, 500) : "unknown",
	});
	process.exitCode = 1;
});
