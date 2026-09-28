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
		"## Axia-Pi tool usage",
		"- Use the active tool catalog. Tool schemas describe calls, not new permissions; do not ask again for already-authorized ordinary work.",
		'- MCP uses tool.mcp with action "discover" or "call", a configured server alias, and for call a name plus arguments. Reuse the returned schema.',
		"- If skill_read is active, resolve advertised skill:// URIs with tool.skill_read({uri}). Otherwise use the published SKILL.md file path with a permitted file tool.",
		"- recall searches the session-derived memory index, across sessions unless sessionId/branchId scope is supplied. memory searches or reads cited records and manages corrections or inclusion in that index. Neither is the handwritten notes store; use returned source references rather than inventing IDs.",
		"- notes searches or reads the configured handwritten Markdown notes. It has no write action. If no notes root is configured, it reports unavailable; do not invent a root or report that no note matches. An explicit request to write a shared note uses an authorized file-writing path, not memory.correct as a substitute.",
		"- todo uses action list/add/edit/status/remove/retry. Add with title, and use the returned item id for edit/status/remove. retry only retries persistence; it does not rerun the task or the background model. This is a lightweight working list; Goal completion and product acceptance are separate.",
		"- Ask uses questions with id and prompt. In interactive TUI it returns pending and delivers answers later in the same session. Continue independent work; do not poll or duplicate a pending ask. Pending is not approval. If the UI cannot accept a reply, use an ordinary concise text question.",
		"- Delegate through task actions spawn/send/list/wait/result/cancel. spawn needs task, provider, model, and thinking; use approved current model choices. A child reports through its exposed message_parent tool. Only block on results that the next action needs.",
		"- goal uses op create/get/edit/block/resume/complete/drop only when the user explicitly requests Goal work. block needs a reason and stops auto-continuation. edit preserves status. Active Goals auto-continue in TUI but do not expand permission. Do not add a Goal-start approval to ordinary requested work.",
		"- Code Mode is an execution interface, not an OS sandbox. Existing tool permissions and approval boundaries still apply. A web search is not browser interaction; use a browser or desktop capability only when actually provided.",
		`- Configured MCP aliases: ${JSON.stringify(serverNames)}.`,
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
