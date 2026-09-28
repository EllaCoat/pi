import { Type } from "typebox";
import type { ExtensionAPI } from "../core/extensions/types.ts";

const DIRECT_TOOLS = ["ask", "checkpoint", "eval", "new_context", "rewind", "think", "todo", "yield"];

/** Visibility is not permission: all host execution still goes through executeTool. */
export function installCodeModeToolSurface(api: ExtensionAPI): void {
	api.setModelVisibleTools((activeNames) => (activeNames.includes("eval") ? DIRECT_TOOLS : undefined));
	api.registerTool({
		name: "tool_info",
		label: "tool metadata",
		description:
			"List permitted host tool names, or return the schema of one permitted tool. This does not execute or enable tools.",
		parameters: Type.Object({ name: Type.Optional(Type.String({ minLength: 1 })) }),
		executionMode: "parallel",
		execute: async (_id, input) => {
			const permitted = new Set(api.getActiveTools());
			const tools = api
				.getAllTools()
				.filter((tool) => permitted.has(tool.name))
				.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
			if (input.name) {
				const tool = tools.find((candidate) => candidate.name === input.name);
				if (!tool) throw new Error(`Tool ${input.name} is unavailable or not permitted`);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								name: tool.name,
								description: tool.description,
								parameters: tool.parameters,
							}),
						},
					],
					details: {},
				};
			}
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							tools.map((tool) => ({ name: tool.name, description: tool.description.split("\n")[0] })),
						),
					},
				],
				details: {},
			};
		},
	});
	api.on("before_agent_start", (event) => {
		const names = [...api.getActiveTools()].sort();
		if (!names.includes("eval")) {
			const leadingSections = { ...event.systemPromptOptions.leadingSections };
			delete leadingSections.code_mode_tools;
			event.systemPromptOptions.leadingSections = leadingSections;
			return;
		}
		event.systemPromptOptions.leadingSections = {
			...event.systemPromptOptions.leadingSections,
			code_mode_tools: `- Code Mode is the primary execution surface. eval accepts language "javascript" or "python" and keeps a separate persistent kernel for each language.
- JavaScript uses a Node-compatible REPL.
- Call active host tools with await tool.NAME(args).
- Active names: ${JSON.stringify(names)}.
- Inspect tool.tool_info({name: "NAME"}) only when you need its schema; tool.tool_info({}) lists names and brief descriptions.
- Reuse a known current schema.
- Hidden active tools remain callable; disabled tools do not.
- Tool selection is not user approval, and existing approval still applies.
- Do not reimplement a denied operation to bypass its boundary.
- Use the current catalog's names and argument schemas.
- Do not call tool.eval recursively.`,
		};
	});
}
