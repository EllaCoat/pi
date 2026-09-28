import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createPersonalHarnessProfile } from "../../src/personal-harness/profile.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

function createSkill(root: string, name: string, body: string): string {
	const skillDir = join(root, name);
	mkdirSync(skillDir, { recursive: true });
	const filePath = join(skillDir, "SKILL.md");
	writeFileSync(filePath, `---\nname: ${name}\ndescription: Fixture skill for profile tests.\n---\n\n${body}\n`);
	return filePath;
}

describe("personal harness Pi profile", () => {
	let harness: Harness | undefined;
	let workDir: string | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.session.dispose();
			harness.cleanup();
		}
		if (workDir) rmSync(workDir, { recursive: true, force: true });
		harness = undefined;
		workDir = undefined;
	});

	it("keeps caller-supplied resource paths and resolves skill:// only inside the skill directory", () => {
		workDir = mkdtempSync(join(tmpdir(), "pi-profile-paths-"));
		const skillsRoot = join(workDir, "private-skills");
		const skillFile = createSkill(skillsRoot, "fixture-skill", "Fixture body marker.");
		mkdirSync(join(skillsRoot, "fixture-skill", "references"), { recursive: true });
		writeFileSync(join(skillsRoot, "fixture-skill", "references", "guide.txt"), "Reference marker.");
		const promptFile = join(workDir, "private-system.md");
		const appendFile = join(workDir, "private-append.md");
		const profile = createPersonalHarnessProfile({
			skillPaths: [skillsRoot],
			systemPrompt: promptFile,
			appendSystemPrompt: [appendFile],
		});

		expect(profile.resourceLoaderOptions).toEqual({
			additionalSkillPaths: [resolve(skillsRoot)],
			systemPrompt: promptFile,
			appendSystemPrompt: [appendFile],
		});
		expect(profile.skills.map((skill) => skill.name)).toEqual(["fixture-skill"]);
		expect(profile.readSkillUri("skill://fixture-skill")).toContain("Fixture body marker.");
		expect(profile.readSkillUri("skill://fixture-skill/references/guide.txt")).toBe("Reference marker.");
		expect(profile.skills[0]?.filePath).toBe(skillFile);
		expect(() => profile.readSkillUri("skill://fixture-skill/../../private-system.md")).toThrow(
			"invalid path segment",
		);
		expect(() => profile.readSkillUri("skill://unknown-skill")).toThrow("Unknown skill");
	});

	it("loads added skills through Pi's private resource loader and expands bodies only on demand", async () => {
		workDir = mkdtempSync(join(tmpdir(), "pi-profile-lazy-"));
		const skillsRoot = join(workDir, "omp-skills");
		createSkill(skillsRoot, "fixture-skill", "Lazily expanded fixture body.");
		const profile = createPersonalHarnessProfile({ skillPaths: [skillsRoot] });
		const loader = new DefaultResourceLoader({
			cwd: workDir,
			agentDir: join(workDir, "private-agent"),
			settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
			...profile.resourceLoaderOptions,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await loader.reload();
		const skill = loader.getSkills().skills.find((candidate) => candidate.name === "fixture-skill");
		expect(skill).toBeDefined();
		expect(skill).not.toHaveProperty("content");

		harness = await createHarness({ resourceLoader: loader });
		const session = harness.session as unknown as { _expandSkillCommand(text: string): string };
		expect(session._expandSkillCommand("ordinary request")).toBe("ordinary request");
		expect(session._expandSkillCommand("/skill:fixture-skill")).toContain("Lazily expanded fixture body.");
	});

	it("describes active tool usage contracts in the profile extension without exposing endpoint details", async () => {
		workDir = mkdtempSync(join(tmpdir(), "pi-profile-tools-"));
		const skillsRoot = join(workDir, "omp-skills");
		createSkill(skillsRoot, "fixture-skill", "Fixture body.");
		const profile = createPersonalHarnessProfile({
			skillPaths: [skillsRoot],
			dataDir: join(workDir, "private-data"),
			mcpServers: { jev: { transport: { type: "stdio", command: "not-started-by-this-test" } } },
		});
		let systemPrompt = "";
		let leadingSections: Record<string, string> = {};
		let forceSystemPrompt: string | undefined;
		harness = await createHarness({
			extensionFactories: [
				profile.extensionFactory,
				(pi) => {
					pi.on("before_agent_start", (event) => {
						systemPrompt = event.systemPrompt;
						leadingSections = { ...event.systemPromptOptions.leadingSections };
						forceSystemPrompt = event.systemPromptOptions.forceSystemPrompt;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("Check the profile tool mapping.");
		const context = harness.session.extensionRunner.createContext();
		const caller = harness.session.messages.findLast((message) => message.role === "assistant");
		if (!caller || caller.role !== "assistant") throw new Error("Missing fixture assistant");
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("skill_read");
		const skillReadResult = await context.executeTool(
			"skill_read",
			{ uri: "skill://fixture-skill" },
			{ assistantMessage: caller },
		);
		expect(skillReadResult.isError, JSON.stringify(skillReadResult.content)).toBe(false);
		expect(
			(await context.executeTool("skill_read", { uri: "skill://unknown-skill" }, { assistantMessage: caller }))
				.isError,
		).toBe(true);
		expect(
			skillReadResult.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		).toContain("Fixture body.");
		expect(systemPrompt).toContain("await tool.NAME(args)");
		expect(Object.keys(leadingSections)).toEqual(["code_mode_tools", "personal_harness"]);
		expect(leadingSections.personal_harness).toContain("## Axia-Pi tool usage");
		expect(systemPrompt.indexOf("<code_mode_tools>")).toBeLessThan(systemPrompt.indexOf("<personal_harness>"));
		expect(forceSystemPrompt).toBeUndefined();
		expect(systemPrompt).toContain('MCP uses tool.mcp with action "discover" or "call"');
		expect(systemPrompt).toContain('Configured MCP aliases: ["jev"].');
		expect(systemPrompt).toContain("tool.skill_read({uri})");
		expect(systemPrompt).toContain("not an OS sandbox");
		expect(leadingSections.code_mode_tools).toContain("- JavaScript uses a Node-compatible REPL.");
		expect(leadingSections.code_mode_tools).toContain(
			"- Tool selection is not user approval, and existing approval still applies.",
		);
		expect(leadingSections.code_mode_tools).toContain("- Do not call tool.eval recursively.");
		expect(leadingSections.code_mode_tools).not.toContain("OMP");
		expect(leadingSections.personal_harness).toContain("Use the active tool catalog.");
		expect(leadingSections.personal_harness).toContain(
			"Neither is the handwritten notes store; use returned source references rather than inventing IDs.",
		);
		expect(leadingSections.personal_harness).toContain(
			"Do not add a Goal-start approval to ordinary requested work.",
		);
		expect(leadingSections.personal_harness).toContain("A web search is not browser interaction");
		expect(leadingSections.personal_harness).not.toContain("OMP");
	});
});
