import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import type { ResourceDiagnostic } from "../core/diagnostics.ts";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import type { DefaultResourceLoaderOptions } from "../core/resource-loader.ts";
import { loadSkills, type Skill } from "../core/skills.ts";
import { resolvePath } from "../utils/paths.ts";
import { createPersonalHarnessExtension, type PersonalHarnessExtensionOptions } from "./extension.ts";

const SkillReadParameters = Type.Object({ uri: Type.String({ minLength: 1 }) });

type PersonalHarnessResourceOptions = Pick<
	DefaultResourceLoaderOptions,
	"additionalSkillPaths" | "systemPrompt" | "appendSystemPrompt"
>;

export interface PersonalHarnessProfileOptions extends Omit<PersonalHarnessExtensionOptions, "inheritedSkillPaths"> {
	/** Personal skill roots passed by the caller; paths and skill text are never embedded in this module. */
	readonly skillPaths: readonly string[];
	/** Passed unchanged to Pi's existing resource loader options. A path is read by that loader when it exists. */
	readonly systemPrompt?: string;
	/** Passed unchanged to Pi's existing resource loader options. */
	readonly appendSystemPrompt?: readonly string[];
}

export interface PersonalHarnessProfile {
	readonly extensionFactory: ExtensionFactory;
	readonly resourceLoaderOptions: PersonalHarnessResourceOptions;
	readonly skills: readonly Skill[];
	readonly diagnostics: readonly ResourceDiagnostic[];
	readSkillUri(uri: string): string;
}

function isInsidePath(path: string, root: string): boolean {
	const relativePath = relative(root, path);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

/** Resolve OMP's skill://name[/relative/path] notation within loaded extra skill roots. */
export function resolvePersonalSkillUri(uri: string, skills: readonly Skill[]): string {
	const match = /^skill:\/\/([^/?#]+)(?:\/([^?#]+))?$/u.exec(uri);
	if (!match) throw new Error("Expected a skill://<name>[/relative/path] URI");

	let name: string;
	let suffix: string[];
	try {
		name = decodeURIComponent(match[1]!);
		suffix = match[2] === undefined ? [] : match[2].split("/").map((part) => decodeURIComponent(part));
	} catch {
		throw new Error("Skill URI contains invalid percent encoding");
	}
	if (
		!name ||
		/[\\/]/u.test(name) ||
		suffix.some((part) => !part || part === "." || part === ".." || /[\\/]/u.test(part))
	) {
		throw new Error("Skill URI contains an invalid path segment");
	}

	const skill = skills.find((candidate) => candidate.name === name);
	if (!skill) throw new Error(`Unknown skill: ${name}`);
	const candidate = suffix.length > 0 ? resolve(skill.baseDir, ...suffix) : resolve(skill.filePath);
	const base = realpathSync(skill.baseDir);
	const target = realpathSync(candidate);
	if (!isInsidePath(target, base) || !statSync(target).isFile()) {
		throw new Error("Skill URI must resolve to a file within the skill directory");
	}
	return target;
}

function profileInstructions(serverNames: readonly string[]): string {
	return [
		"Personal OMP profile tool mapping:",
		"- Run host operations in eval with `await tool.NAME(args)` (Python uses `await tool.NAME({...})`). Use only tools available to this session; this mapping does not grant permission.",
		'- OMP MCP tool names are not separate Pi tools. Discover a configured server with `await tool.mcp({action: "discover", server: "alias"})`, then call it with `await tool.mcp({action: "call", server: "alias", name: "tool_name", arguments: {...}})`. Configured aliases: ' +
			JSON.stringify(serverNames) +
			".",
		'- Resolve OMP `skill://name[/relative/path]` references on demand with `await tool.skill_read({uri: "skill://name[/relative/path]"})`; the URI is limited to the supplied extra skill roots. Pi\'s normal skill list and `/skill:name` expansion remain available.',
		"- The Goal tool accepts `create`, `get`, `complete`, `resume`, and `drop`. `/goal` is a user command for pause/budget operations; do not send pause or budget as Goal tool operations.",
		"- Code Mode is an execution interface, not an OS sandbox. Preserve inherited instructions and approval hooks; do not treat prompt guidance as a replacement for host tool permissions.",
	].join("\n");
}

function registerSkillReadTool(pi: ExtensionAPI, skills: readonly Skill[]): void {
	pi.registerTool({
		name: "skill_read",
		label: "read personal skill reference",
		description: "Lazily read a skill:// URI from the personal skill paths supplied at startup.",
		promptSnippet: "Resolve and read one skill:// URI from the configured personal skill paths.",
		parameters: SkillReadParameters,
		execute: async (_id, input) => {
			const { uri } = input as Static<typeof SkillReadParameters>;
			try {
				return {
					content: [{ type: "text", text: readFileSync(resolvePersonalSkillUri(uri, skills), "utf8") }],
					details: { uri },
				};
			} catch {
				throw new Error("Unable to read the requested skill URI");
			}
		},
	});
}

/**
 * Build a startup profile that feeds caller-supplied instructions and skill paths through Pi's
 * resource-loader contract, then exposes a bounded lazy adapter for OMP skill:// references.
 */
export function createPersonalHarnessProfile(options: PersonalHarnessProfileOptions): PersonalHarnessProfile {
	const { skillPaths: inputSkillPaths, systemPrompt, appendSystemPrompt, ...extensionOptions } = options;
	if (inputSkillPaths.length === 0 || inputSkillPaths.some((path) => !path.trim())) {
		throw new Error("At least one non-empty personal skill path is required");
	}
	const skillPaths = [...new Set(inputSkillPaths.map((path) => resolvePath(path, process.cwd(), { trim: true })))];
	const loaded = loadSkills({ cwd: process.cwd(), agentDir: process.cwd(), skillPaths, includeDefaults: false });
	const serverNames = Object.keys(options.mcpServers ?? {}).sort();
	const harnessExtension = createPersonalHarnessExtension({
		...extensionOptions,
		...(systemPrompt === undefined ? {} : { childSystemPrompt: systemPrompt }),
		inheritedSkillPaths: skillPaths,
	});
	const extensionFactory: ExtensionFactory = (pi) => {
		harnessExtension(pi);
		registerSkillReadTool(pi, loaded.skills);
		pi.on("before_agent_start", (event) => {
			event.systemPromptOptions.leadingSections = {
				...event.systemPromptOptions.leadingSections,
				personal_harness: profileInstructions(serverNames),
			};
		});
	};
	const resourceLoaderOptions: PersonalHarnessResourceOptions = {
		additionalSkillPaths: skillPaths,
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [...appendSystemPrompt] }),
	};

	return {
		extensionFactory,
		resourceLoaderOptions,
		skills: loaded.skills,
		diagnostics: loaded.diagnostics,
		readSkillUri: (uri) => readFileSync(resolvePersonalSkillUri(uri, loaded.skills), "utf8"),
	};
}
