import { Type } from "typebox";
import type { ExtensionAPI } from "../core/extensions/types.ts";

const DIRECT_TOOLS = ["eval", "ask", "todo", "yield", "think", "checkpoint", "rewind", "new_context"];

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
				.sort((left, right) => left.name.localeCompare(right.name));
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
			const sections = { ...event.systemPromptOptions.sections };
			delete sections.code_mode_tools;
			event.systemPromptOptions.sections = sections;
			return;
		}
		event.systemPromptOptions.sections = {
			...event.systemPromptOptions.sections,
			code_mode_tools: `Code Mode is the primary execution surface. In eval, call await tool.NAME(args). Permitted host tool names for this session: ${JSON.stringify(names)}. Use await tool.tool_info({name: "NAME"}) only when its argument schema is needed, or tool.tool_info({}) for brief descriptions. Hidden tools are still callable through this bridge; disabled tools are not. Tool metadata describes availability, not authorization. Do not bypass approval boundaries by reimplementing protected actions in code. This session's catalog takes precedence over tool names mentioned in an inherited parent prompt.`,
		};
	});
}
