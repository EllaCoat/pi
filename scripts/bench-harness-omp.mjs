import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
const sourceRoot = process.env.HARNESS_OMP_ROOT;
if (!sourceRoot) throw new Error("HARNESS_OMP_ROOT is required");
const load = (relative) => import(pathToFileURL(join(sourceRoot, relative)).href);
const { AuthStorage, createAssistantMessageEventStream, SqliteAuthCredentialStore } = await load("packages/ai/src/index.ts");
const { type: ompType } = await load("packages/omptype/src/index.ts");
const { createAgentSession } = await load("packages/coding-agent/src/sdk.ts");
const { ModelRegistry } = await load("packages/coding-agent/src/config/model-registry.ts");
const { Settings } = await load("packages/coding-agent/src/config/settings.ts");
const { SessionManager } = await load("packages/coding-agent/src/session/session-manager.ts");
import {
	API_ID,
	FINAL_ANSWER,
	FIXED_TIMESTAMP,
	HISTORY,
	MODEL_DELAY_MS,
	MODEL_ID,
	PROVIDER_ID,
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
const SOURCE_ID = "bench-harness-offline-fixture";

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

function assistantMessage(content, stopReason, timestamp) {
	return {
		role: "assistant",
		content,
		api: API_ID,
		provider: PROVIDER_ID,
		model: MODEL_ID,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

function streamFixtureResponse(modelCalls, context, options) {
	const stream = createAssistantMessageEventStream();
	const callNumber = ++modelCalls.count;
	modelCalls.requestDetails.push(normalizeRequest(context, options));
	modelCalls.requestHashes.push(fingerprintRequest(context, options));
	queueMicrotask(async () => {
		try {
			await delay(MODEL_DELAY_MS);
			if (callNumber % 2 === 1) {
				const toolCall = {
					type: "toolCall",
					id: `benchmark-call-${Math.ceil(callNumber / 2)}`,
					name: TOOL_NAME,
					arguments: { value: TOOL_INPUT, i: "Record fixture action" },
				};
				const message = assistantMessage([toolCall], "toolUse", FIXED_TIMESTAMP + callNumber);
				const partial = { ...message, content: [] };
				stream.push({ type: "start", partial });
				partial.content = [{ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: {} }];
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...partial } });
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: { ...partial } });
				partial.content = [toolCall];
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: { ...partial } });
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
				return;
			}
			const message = assistantMessage([{ type: "text", text: FINAL_ANSWER }], "stop", FIXED_TIMESTAMP + callNumber);
			const partial = { ...message, content: [{ type: "text", text: "" }] };
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
			partial.content[0].text = FINAL_ANSWER;
			stream.push({ type: "text_delta", contentIndex: 0, delta: FINAL_ANSWER, partial: { ...partial } });
			stream.push({ type: "text_end", contentIndex: 0, content: FINAL_ANSWER, partial: { ...partial } });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		} catch {
			stream.end(assistantMessage([], "error", FIXED_TIMESTAMP + callNumber));
		}
	});
	return stream;
}

async function run() {
	if (process.argv[2] !== "--worker") {
		console.error("Usage: bun scripts/bench-harness-omp.mjs --worker");
		process.exitCode = 2;
		return;
	}

	emit("BENCH_HARNESS_READY ", { runtime: "omp", runtimeVersion: "18.2.10-modified", bunVersion: Bun.version, rssBytes: process.memoryUsage().rss });
	const startedAt = performance.now();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-harness-bench-"));
	const fixtureCwd = process.env.HARNESS_BENCH_CWD ?? tempDir;
	const database = new Database(":memory:");
	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(database));
	const settings = Settings.isolated({
		"advisor.enabled": false,
		"async.enabled": false,
		"compaction.enabled": false,
		"mcp.enabled": false,
		"todo.enabled": false,
		"providers.openaiWebsockets": "off",
	});
	const modelRegistry = new ModelRegistry(authStorage, join(tempDir, "models.yml"), {
		settings,
		cacheDbPath: join(tempDir, "models.db"),
	});
	const modelCalls = { count: 0, requestHashes: [], requestDetails: [] };
	let toolExecutions = 0;
	let session;
	let providerRegistered = false;
	const eventCounts = {};

	try {
		modelRegistry.registerProvider(
			PROVIDER_ID,
			{
				name: PROVIDER_ID,
				baseUrl: "https://offline-fixture.invalid/v1",
				api: API_ID,
				apiKey: "offline-fixture-only",
				streamSimple: (model, context, options) => streamFixtureResponse(modelCalls, context, options),
				models: [{
					id: MODEL_ID,
					name: MODEL_ID,
					api: API_ID,
					baseUrl: "https://offline-fixture.invalid/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 1024,
				}],
			},
			SOURCE_ID,
		);
		providerRegistered = true;
		const model = modelRegistry.find(PROVIDER_ID, MODEL_ID);
		if (!model) throw new Error("fixture model registration failed");

		const tool = {
			name: TOOL_NAME,
			label: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			parameters: ompType({ value: "string" }),
			approval: "read",
			async execute(_toolCallId, input) {
				if (!input || input.value !== TOOL_INPUT) throw new Error("fixture tool input mismatch");
				toolExecutions++;
				return { content: [{ type: "text", text: TOOL_RESULT }] };
			},
		};
		const sessionManager = SessionManager.inMemory(fixtureCwd);
		for (const message of HISTORY) sessionManager.appendMessage(message);
		const result = await createAgentSession({
			cwd: fixtureCwd,
			agentDir: tempDir,
			model,
			modelRegistry,
			sessionManager,
			settings,
			customTools: [tool],
			toolNames: [TOOL_NAME],
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			systemPrompt: SYSTEM_PROMPT,
		});
		session = result.session;
		const unsubscribe = session.subscribe((event) => addEventCount(eventCounts, event));
		const rssReadyBytes = process.memoryUsage().rss;
		const setupMs = performance.now() - startedAt;
		const turns = [];

		for (let index = 0; index <= WARM_TURN_COUNT; index++) {
			const beforeCalls = modelCalls.count;
			const beforeTools = toolExecutions;
			const beforeEvents = Object.values(eventCounts).reduce((total, count) => total + count, 0);
			const turnStarted = performance.now();
			await session.prompt(USER_PROMPT);
			const elapsedMs = performance.now() - turnStarted;
			const turnCalls = modelCalls.count - beforeCalls;
			const turnTools = toolExecutions - beforeTools;
			if (turnCalls !== 2 || turnTools !== 1 || lastAssistantText(session) !== FINAL_ANSWER) {
				const last = session.agent.state.messages.at(-1);
				const toolErrors = session.agent.state.messages.filter((message) => message.role === "toolResult" && message.isError).map((message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ").slice(0, 200));
				throw new Error(JSON.stringify({ code: "fixture-mismatch", turnCalls, turnTools, answerMatches: lastAssistantText(session) === FINAL_ANSWER, stopReason: last?.stopReason, errorMessage: last?.errorMessage?.slice(0, 250), toolErrors }));
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
		if (modelCalls.count !== (WARM_TURN_COUNT + 1) * 2 || toolExecutions !== WARM_TURN_COUNT + 1) {
			throw new Error("offline fixture aggregate counts did not match");
		}

		emit("BENCH_HARNESS_RESULT ", {
			runtime: "omp",
			runtimeVersion: "18.2.10-modified",
			fixtureHash: fixtureFingerprint(),
			setupMs,
			rssReadyBytes,
			rssAfterTurnsBytes,
			rssDeltaBytes: rssAfterTurnsBytes - rssReadyBytes,
			modelCalls: modelCalls.count,
			toolExecutions,
			injectedModelDelayMs: modelCalls.count * MODEL_DELAY_MS,
			eventCounts,
			requestHashes: modelCalls.requestHashes,
			requestDetails: modelCalls.requestDetails,
			turns,
		});
	} finally {
		if (session) await session.dispose();
		if (providerRegistered) modelRegistry.clearSourceRegistrations(SOURCE_ID);
		authStorage.close();
		await rm(tempDir, { recursive: true, force: true });
	}
}

run().catch((error) => {
	emit(ERROR_MARKER, {
		errorType: error instanceof Error ? error.name : "unknown",
		errorMessage: error instanceof Error ? error.message.slice(0, 500) : "unknown",
	});
	process.exitCode = 1;
});
