import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPersonalHarnessProfile, resolvePersonalSkillUri } from "../packages/coding-agent/src/personal-harness/profile.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { resolvePath } from "../packages/coding-agent/src/utils/paths.ts";

const args = process.argv.slice(2);
const skillPaths = [];
for (let index = 0; index < args.length; index++) {
	if (args[index] !== "--skills-path" || !args[index + 1] || args[index + 1].startsWith("--")) {
		console.error("Usage: node scripts/probe-harness-skills.mjs --skills-path <existing-personal-skills-path> [--skills-path <path> ...]");
		process.exit(2);
	}
	skillPaths.push(args[++index]);
}
if (skillPaths.length === 0) {
	console.error("Usage: node scripts/probe-harness-skills.mjs --skills-path <existing-personal-skills-path> [--skills-path <path> ...]");
	process.exit(2);
}

const requiredSkills = ["make-goal", "pr-create", "task-deck", "task-deck-documents", "jev_check"];
const workDir = await mkdtemp(join(tmpdir(), "pi-harness-skills-"));
let loader;
try {
	const privateAgentDir = join(workDir, "private-agent");
	const projectDir = join(workDir, "project");
	await Promise.all([mkdir(privateAgentDir, { recursive: true }), mkdir(projectDir, { recursive: true })]);
	const instructionMarker = "SYNTHETIC_PRIVATE_AGENT_INSTRUCTION_PROBE";
	const appendMarker = "SYNTHETIC_PRIVATE_APPEND_INSTRUCTION_PROBE";
	const agentMarker = "SYNTHETIC_PRIVATE_AGENTS_FILE_PROBE";
	const systemPromptPath = join(workDir, "synthetic-system.md");
	const appendPromptPath = join(workDir, "synthetic-append.md");
	await Promise.all([
		writeFile(systemPromptPath, instructionMarker),
		writeFile(appendPromptPath, appendMarker),
		writeFile(join(privateAgentDir, "AGENTS.md"), agentMarker),
	]);

	const profile = createPersonalHarnessProfile({
		skillPaths,
		dataDir: join(workDir, "private-data"),
		systemPrompt: systemPromptPath,
		appendSystemPrompt: [appendPromptPath],
	});
	loader = new DefaultResourceLoader({
		cwd: projectDir,
		agentDir: privateAgentDir,
		settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }, { projectTrusted: false }),
		...profile.resourceLoaderOptions,
		extensionFactories: [{ name: "personal-harness-profile-probe", factory: profile.extensionFactory }],
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();

	const loadedSkills = loader.getSkills();
	const availableNames = new Set(loadedSkills.skills.map((skill) => skill.name));
	const missingSkills = requiredSkills.filter((name) => !availableNames.has(name));
	if (missingSkills.length > 0) throw Object.assign(new Error("required-skills-missing"), { code: missingSkills.join(",") });

	const skills = requiredSkills.map((name) => {
		const skill = profile.skills.find((candidate) => candidate.name === name);
		if (!skill || !availableNames.has(name)) throw Object.assign(new Error("profile-skill-not-loaded"), { code: name });
		const uri = `skill://${name}`;
		const resolvedPath = resolvePersonalSkillUri(uri, profile.skills);
		if (resolve(resolvedPath) !== resolve(skill.filePath)) throw Object.assign(new Error("skill-uri-resolution-mismatch"), { code: name });
		const body = profile.readSkillUri(uri);
		return {
			name,
			listedByPi: true,
			bodyReadOnDemand: body.length > 0,
			bodyCharacters: body.length,
			bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
		};
	});

	const jevSkill = profile.skills.find((skill) => skill.name === "jev_check");
	const jevWarnings = loadedSkills.diagnostics
		.filter((diagnostic) => diagnostic.path === jevSkill?.filePath)
		.map((diagnostic) => diagnostic.message);
	if (!jevWarnings.some((message) => message.includes("name contains invalid characters"))) {
		throw Object.assign(new Error("expected-jev-underscore-warning-not-observed"), { code: "jev_check" });
	}

	const loadedSystemPrompt = loader.getSystemPrompt() ?? "";
	const loadedAppendPrompt = loader.getAppendSystemPrompt().join("\n");
	const loadedAgentsFiles = loader.getAgentsFiles().agentsFiles.map((file) => file.content).join("\n");
	const instructions = {
		systemPromptFromPiLoader: loadedSystemPrompt.includes(instructionMarker),
		appendPromptFromPiLoader: loadedAppendPrompt.includes(appendMarker),
		agentsFileFromPiLoader: loadedAgentsFiles.includes(agentMarker),
	};
	if (!Object.values(instructions).every(Boolean)) throw Object.assign(new Error("synthetic-instructions-not-loaded"), { code: "pi-resource-loader" });

	const suppliedSkillPaths = new Set(skillPaths.map((path) => resolvePath(path, process.cwd(), { trim: true })));
	const configuredSkillPaths = profile.resourceLoaderOptions.additionalSkillPaths ?? [];
	const skillPathsPassedDirectly = configuredSkillPaths.length === suppliedSkillPaths.size && configuredSkillPaths.every((path) => suppliedSkillPaths.has(resolvePath(path)));
	if (!skillPathsPassedDirectly) throw Object.assign(new Error("additional-skill-path-not-preserved"), { code: "additionalSkillPaths" });
	let privateSkillsCopied = false;
	try {
		await access(join(privateAgentDir, "skills"));
		privateSkillsCopied = true;
	} catch {}
	if (privateSkillsCopied) throw Object.assign(new Error("skills-were-copied-into-private-runtime"), { code: "skill-copy-detected" });
	const profileExtensionLoaded = loader.getExtensions().extensions.some((extension) => extension.path.includes("personal-harness-profile-probe"));
	if (!profileExtensionLoaded) throw Object.assign(new Error("profile-extension-not-loaded"), { code: "extensionFactory" });

	console.log(JSON.stringify({
		status: "passed",
		privateRuntimeUsesAdditionalSkillPaths: true,
		skillPathsCopied: false,
		instructions,
		skills,
		jevCheckWarnings: jevWarnings,
		profileExtensionLoaded,
		outputContainsSkillBodiesOrAbsolutePaths: false,
	}));
} catch (error) {
	console.log(JSON.stringify({ status: "failed", errorType: error instanceof Error ? error.name : "unknown", code: error && typeof error === "object" && "code" in error ? error.code : undefined }));
	process.exitCode = 1;
} finally {
	await rm(workDir, { recursive: true, force: true });
}
