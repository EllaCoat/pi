import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createPersonalHarnessExtension } from "../../src/personal-harness/extension.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

describe("SDK tool visibility and persisted execution access", () => {
	let host: Harness | undefined;
	let work: string | undefined;
	const sessions: AgentSession[] = [];
	const observedPrompts: string[] = [];
	let enableInsideHook = false;
	let selectOnce: string[] | undefined;

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		if (host) {
			await host.session.dispose();
			host.cleanup();
		}
		if (work) rmSync(work, { recursive: true, force: true });
		host = undefined;
		work = undefined;
		observedPrompts.length = 0;
		enableInsideHook = false;
		selectOnce = undefined;
	});

	async function create(manager: SessionManager, explicitTools?: string[]) {
		if (!work || !host) throw new Error("Fixture not initialized");
		const settings = SettingsManager.inMemory(
			{ cacheWarming: "off", compaction: { enabled: false } },
			{ projectTrusted: false },
		);
		const loader = new DefaultResourceLoader({
			cwd: work,
			agentDir: join(work, "agent"),
			settingsManager: settings,
			noExtensions: true,
			noContextFiles: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			extensionFactories: [
				{
					name: "legacy-before-harness",
					factory: (pi) => {
						pi.registerTool({
							name: "hidden_fixture",
							label: "hidden fixture",
							description: "Artificial host operation",
							promptSnippet: "PRIVATE_TOOL_SNIPPET",
							promptGuidelines: ["PRIVATE_TOOL_GUIDELINE"],
							parameters: Type.Object({ text: Type.String() }),
							execute: async (_id, args) => ({ content: [{ type: "text", text: args.text }], details: {} }),
						});
						pi.on("before_agent_start", (event) => {
							if (enableInsideHook) pi.setActiveTools([...pi.getActiveTools(), "eval"]);
							if (selectOnce) {
								event.systemPromptOptions.selectedTools = selectOnce;
								selectOnce = undefined;
							}
						});
						pi.on("before_agent_start", (event, context) => {
							observedPrompts.push(event.systemPrompt, context.getSystemPrompt());
							return { systemPrompt: `${event.systemPrompt}\nLegacy fixture addition.` };
						});
					},
				},
				{
					name: "harness-after-legacy",
					factory: createPersonalHarnessExtension({ dataDir: join(work, "data"), todoDebounceMs: 60_000 }),
				},
			],
		});
		await loader.reload();
		const result = await createAgentSession({
			cwd: work,
			agentDir: join(work, "agent"),
			sessionManager: manager,
			settingsManager: settings,
			resourceLoader: loader,
			modelRuntime: host.session.extensionRunner.createContext().modelRegistry.runtime,
			model: host.session.model,
			...(explicitTools === undefined ? {} : { tools: explicitTools }),
		});
		sessions.push(result.session);
		return result.session;
	}

	it("filters the first legacy prompt even before the harness handler, including mode reactivation", async () => {
		work = mkdtempSync(join(tmpdir(), "pi-sdk-visibility-"));
		host = await createHarness();
		const session = await create(SessionManager.inMemory(work));
		const requests: TranscriptContext[] = [];
		const response = (context: TranscriptContext) => {
			requests.push(context);
			return fauxAssistantMessage("ready");
		};
		host.setResponses([response]);
		await session.prompt("First request");
		expect(
			getCurrentTools(requests[0].messages)
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["eval", "todo"]);
		for (const prompt of observedPrompts) {
			expect(prompt).not.toContain("PRIVATE_TOOL_SNIPPET");
			expect(prompt).not.toContain("PRIVATE_TOOL_GUIDELINE");
		}
		const active = session.getActiveToolNames();
		session.setActiveToolsByName(active.filter((name) => name !== "eval"));
		host.setResponses([response]);
		await session.prompt("Without Code Mode");
		expect(observedPrompts.at(-1)).toContain("PRIVATE_TOOL_SNIPPET");
		enableInsideHook = true;
		host.setResponses([response]);
		await session.prompt("Code Mode restored");
		expect(observedPrompts.at(-1)).not.toContain("PRIVATE_TOOL_SNIPPET");
		expect(JSON.stringify(requests.at(-1)!.messages.filter((message) => message.role === "system"))).not.toContain(
			"PRIVATE_TOOL_SNIPPET",
		);
		enableInsideHook = false;
		selectOnce = ["read"];
		host.setResponses([response, response]);
		await session.prompt("Select a read-only loadout in one handler");
		expect(session.getActiveToolNames()).toEqual(["read"]);
		await session.prompt("Continue without editing the loadout");
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(getCurrentTools(requests.at(-1)!.messages).map((tool) => tool.name)).toEqual(["read"]);
	});

	it("keeps visible tool definitions in deterministic name order for an unsorted loadout", async () => {
		work = mkdtempSync(join(tmpdir(), "pi-sdk-visible-order-"));
		host = await createHarness();
		const session = await create(SessionManager.inMemory(work), ["todo", "eval"]);
		const requests: TranscriptContext[] = [];
		host.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage("ready");
			},
		]);

		await session.prompt("Check the visible tool order.");

		expect(getCurrentTools(requests[0]!.messages).map((tool) => tool.name)).toEqual(["eval", "todo"]);
		expect(session.getActiveToolNames()).toEqual(["todo", "eval"]);
	});

	it("preserves disabled host tools across SDK resume, fork, and reload", async () => {
		work = mkdtempSync(join(tmpdir(), "pi-sdk-loadout-"));
		host = await createHarness();
		const manager = SessionManager.create(work, join(work, "sessions"));
		const session = await create(manager);
		expect(session.getActiveToolNames()).toContain("hidden_fixture");
		session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "hidden_fixture"));
		host.setResponses([fauxAssistantMessage("saved")]);
		await session.prompt("Save the disabled host operation");
		const originalPath = manager.getSessionFile();
		const leaf = manager.getLeafId();
		if (!originalPath || !leaf) throw new Error("Fixture session was not persisted");
		const forkPath = manager.createBranchedSession(leaf);
		if (!forkPath) throw new Error("Fixture branch was not persisted");
		await session.dispose();
		const resumed = await create(SessionManager.open(originalPath));
		expect(resumed.getActiveToolNames()).toContain("tool_info");
		expect(resumed.getActiveToolNames()).not.toContain("hidden_fixture");
		await resumed.reload();
		expect(resumed.getActiveToolNames()).not.toContain("hidden_fixture");
		const forked = await create(SessionManager.open(forkPath));
		expect(forked.getActiveToolNames()).toContain("tool_info");
		expect(forked.getActiveToolNames()).not.toContain("hidden_fixture");
		const restricted = await create(SessionManager.open(originalPath), ["read"]);
		expect(restricted.getActiveToolNames()).toEqual(["read"]);
	});
});
