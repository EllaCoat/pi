import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { getAgentDir } from "../packages/coding-agent/dist/config.js";
import { ModelRuntime } from "../packages/coding-agent/dist/core/model-runtime.js";
import { DefaultResourceLoader } from "../packages/coding-agent/dist/core/resource-loader.js";
import { SettingsManager } from "../packages/coding-agent/dist/core/settings-manager.js";
import { SessionManager } from "../packages/coding-agent/dist/core/session-manager.js";
import { createAgentSession } from "../packages/coding-agent/dist/core/sdk.js";
import { createPersonalHarnessExtension } from "../packages/coding-agent/dist/personal-harness/extension.js";

if (process.argv[2] !== "--run") {
	console.error("Usage: node scripts/probe-harness-live.mjs --run (uses configured GPT/Vertex authentication and paid model calls)");
	process.exit(2);
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const jevArgument = process.argv.indexOf("--jev-entry");
const jevEntry = jevArgument < 0 ? undefined : JSON.parse(await readFile(process.argv[jevArgument + 1], "utf8")).mcpServers.jev;
const work = await mkdtemp(join(tmpdir(), "pi-harness-live-"));
const phases = ["javascript-python-and-background-todo", "mcp-discovery-tool-resource-prompt", "independent-live-children", "sqlite-recall-with-live-curation", "luna-max-compaction"];
const fromArgument = process.argv.indexOf("--from");
const from = fromArgument < 0 ? phases[0] : process.argv[fromArgument + 1];
if (!phases.includes(from)) throw new Error("Invalid --from phase");
const report = { startedAt: new Date().toISOString(), work, from, checks: [], models: {}, usage: undefined };
let session;
let api;
let phase = "setup";
const text = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const assert = (condition, code) => { if (!condition) { const error = new Error(code); error.name = "ProbeAssertion"; throw error; } };
const waitFor = async (predicate, timeoutMs = 60_000) => {
	const until = performance.now() + timeoutMs;
	while (!predicate()) {
		if (performance.now() >= until) throw Object.assign(new Error("condition-timeout"), { name: "ProbeTimeout" });
		await delay(50);
	}
};
async function step(name, action) {
	if (phases.indexOf(name) < phases.indexOf(from)) { report.checks.push({ name, status: "not-run" }); return; }
	phase = name;
	const started = performance.now();
	console.log(JSON.stringify({ phase: name, state: "started" }));
	await action();
	const result = { name, status: "passed", durationMs: performance.now() - started };
	report.checks.push(result);
	console.log(JSON.stringify(result));
}
async function prompt(message) {
	const timer = setTimeout(() => { void session.abort(); }, 90_000);
	try { await session.prompt(message, { expandPromptTemplates: false }); }
	finally { clearTimeout(timer); }
	assert(session.messages.findLast((entry) => entry.role === "assistant")?.stopReason === "stop", "main-did-not-finish");
}
async function host(name, input) {
	const assistantMessage = session.messages.findLast((message) => message.role === "assistant");
	const result = await api.executeTool(name, input, { assistantMessage, signal: AbortSignal.timeout(90_000) });
	assert(!result.isError, `host-${name}-failed`);
	return JSON.parse(text(result));
}
try {
	const runtime = await ModelRuntime.create({ authPath: join(getAgentDir(), "auth.json"), modelsPath: null, allowModelNetwork: false });
	const parent = runtime.getModel("openai-codex", "gpt-6-luna");
	assert(parent && runtime.hasConfiguredAuth(parent.provider), "parent-auth-unavailable");
	const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false, keepRecentTokens: 1 } }, { projectTrusted: false });
	const manager = SessionManager.inMemory(work);
	report.backgroundUpdates = [];
	const originalStream = runtime.streamSimple.bind(runtime);
	runtime.streamSimple = (model, context, options) => {
		const stream = originalStream(model, context, options);
		if (context.tools?.some((tool) => tool.name === "return_todo_update")) {
			const result = stream.result.bind(stream);
			stream.result = async () => {
				const response = await result();
				report.backgroundUpdates.push({ input: JSON.parse(String(context.messages[0].content)), output: response.content.filter((part) => part.type === "toolCall" || part.type === "text").map((part) => part.type === "toolCall" ? { type: part.type, name: part.name, arguments: part.arguments } : { type: part.type, text: part.text }), stopReason: response.stopReason });
				return response;
			};
		}
		return stream;
	};
	const loader = new DefaultResourceLoader({
		cwd: work, agentDir: join(work, "agent"), settingsManager: settings,
		noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
		systemPrompt: "You are executing an isolated software integration fixture. Use only the explicitly requested tools and artificial data. Do not inspect any credentials, settings, or other files. Do not start a Goal. Follow the requested provider/model exactly for children. Keep final answers brief. tool.<name>(args) is available inside eval; use display(value) to show results.",
		extensionFactories: [{ name: "live-personal-harness", factory: (pi) => {
			api = pi;
			createPersonalHarnessExtension({
				dataDir: join(work, "data"), todoDebounceMs: 100,
				mcpServers: { fixture: { transport: { type: "stdio", command: process.execPath, args: [join(root, "packages/coding-agent/test/personal-harness/mcp-stdio.fixture.mjs"), "--live"] } }, ...(jevEntry ? { jev: { transport: { type: "stdio", command: jevEntry.command, args: jevEntry.args, cwd: jevEntry.cwd, env: jevEntry.env } } } : {}) },
				...(jevEntry ? { jev: { server: "jev", tool: "jev_evaluate" } } : {}),
			})(pi);
		} }],
	});
	await loader.reload();
	const created = await createAgentSession({
		cwd: work, agentDir: join(work, "agent"), modelRuntime: runtime, model: parent, thinkingLevel: "low",
		settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: "builtin",
		customTools: [{ name: "echo_fixture", label: "Echo fixture", description: "Echo only artificial fixture data; optional delay supports a cancellation probe.",
			parameters: Type.Object({ text: Type.String(), delayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })) }),
			execute: async (_id, input, signal) => { if (input.delayMs) await delay(input.delayMs, undefined, { signal }); return { content: [{ type: "text", text: input.text }], details: {} }; },
		}],
	});
	session = created.session;
	report.models = { parent: "openai-codex/gpt-6-luna:low", background: "openai-codex/gpt-6-luna:max", childVertex: "google-vertex/gemini-2.5-flash:low" };
	await step("javascript-python-and-background-todo", async () => {
		await prompt("First use todo to add exactly one item titled 'Verify the fixture calculation'. Then use eval JavaScript twice: the first cell defines const fixtureValue = 40 and displays await tool.echo_fixture({text:'ECHO_READY'}); the second displays fixtureValue + 2. Then use Python eval twice: first fixture_counter = 9; second display(fixture_counter + 1). These are independent persistent kernels. End with a short verification report; do not manually change TODO status.");
		const results = session.messages.filter((entry) => entry.role === "toolResult" && entry.toolName === "eval");
		assert(results.length >= 4, "missing-persistent-cells");
		assert(results.some((entry) => text(entry).includes("ECHO_READY")), "host-bridge-not-used");
		assert(results.some((entry) => !entry.isError && /^(?:\[display\] )?42$/mu.test(text(entry))), "javascript-state-not-retained");
		assert(results.some((entry) => !entry.isError && /^(?:\[display\] )?10$/mu.test(text(entry))), "python-state-not-retained");
		const todoResult = session.messages.find((entry) => entry.role === "toolResult" && entry.toolName === "todo");
		const todoId = JSON.parse(text(todoResult)).items[0].id;
		await waitFor(() => manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "personal-harness-todo" && entry.data.items.some((item) => item.id === todoId && item.status === "done")));
	});
	await step("mcp-discovery-tool-resource-prompt", async () => {
		await prompt("Use eval to call tool.mcp with action discover and server fixture. Then call its echo tool with text MCP_READY, read resource fixture://stdio, and get prompt stdio-prompt with text PROMPT_READY. Display the tool, resource and prompt outputs. The server is an isolated local fixture. End briefly.");
		const results = session.messages.filter((entry) => entry.role === "toolResult").map(text).join("\n");
		assert(results.includes("echo:MCP_READY") && results.includes("resource body") && results.includes("prompt:PROMPT_READY"), "mcp-route-incomplete");
	});
	await step("independent-live-children", async () => {
		await prompt("In one JavaScript eval cell spawn exactly two independent tasks using tool.task({action:'spawn',task,provider,model,thinking}). Child 1 is openai-codex/gpt-6-luna with thinking low. Child 2 is google-vertex/gemini-2.5-flash with thinking low. Give each this task: use your eval to call await tool.echo_fixture({text:'CHILD_READY',delayMs:2000}), display it, then answer CHILD_READY. Display the two task IDs. Do not wait for them: finish your parent answer immediately after spawning.");
		await waitFor(() => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "personal-harness-child-result").length >= 2, 90_000);
		const children = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "personal-harness-child-result").map((entry) => entry.data);
		assert(children.length === 2 && children.every((child) => child.status === "completed" && child.text.includes("CHILD_READY")), "child-run-not-completed");
		report.children = children.map(({ provider, model, status, durationMs }) => ({ provider, model, status, durationMs }));
	});
	await step("sqlite-recall-with-live-curation", async () => {
		await prompt("Record this artificial fact for the integration fixture: the COBALT_ZEBRA_428 package belongs in shelf ECHO. Acknowledge it briefly without tools.");
		const recalled = await host("recall", { query: "COBALT_ZEBRA_428 shelf" });
		report.recall = { cited: recalled.citations.length, resultType: recalled.status, reason: recalled.reason };
		assert(recalled.status === "curated" && recalled.content?.includes("ECHO") && recalled.citations?.length > 0, "cited-memory-not-returned");
	});
	await step("luna-max-compaction", async () => {
		const compacted = await session.compact();
		assert(compacted.summary?.length > 0, "empty-compaction");
		const entry = manager.getBranch().findLast((entry) => entry.type === "compaction");
		assert(entry?.details?.model === "openai-codex/gpt-6-luna" && entry?.details?.thinking === "max", "wrong-compaction-model");
	});
	report.usage = await host("usage", {});
	if (jevEntry) assert(report.usage.hook?.input > 0, "jev-hooks-did-not-report-usage");
	report.status = "passed";
} catch (error) {
	report.status = "failed";
	report.failure = { phase, name: error instanceof Error ? error.name : "unknown", code: error?.name === "ProbeAssertion" || error?.name === "ProbeTimeout" ? error.message : undefined };
	process.exitCode = 1;
} finally {
	if (session) {
		try { report.usage = await host("usage", {}); report.todo = await host("todo", { action: "list" }); } catch { /* Missing counters stay unknown. */ }
		report.toolResults = session.messages.filter((message) => message.role === "toolResult").map((message) => ({ toolName: message.toolName, isError: message.isError, text: text(message).slice(0, 2000) }));
		await session.dispose();
	}
	report.finishedAt = new Date().toISOString();
	await writeFile(join(work, "evidence.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify({ ...report, toolResults: undefined, backgroundUpdates: undefined }));
}
