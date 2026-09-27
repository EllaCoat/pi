import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ReadResourceRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const live = process.argv.includes("--live");
const server = new Server(
	{ name: "personal-harness-stdio-fixture", version: "1.0.0" },
	{ capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
	resources: [{ uri: "fixture://stdio", name: "stdio fixture" }],
}));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
	prompts: [{ name: "stdio-prompt", arguments: [{ name: "text", required: true }] }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
	content: [
		{ type: "text", text: `echo:${String(request.params.arguments?.text ?? "")}` },
		...(live ? [] : [{ type: "image", data: "AQID", mimeType: "image/png" }]),
	],
	structuredContent: { received: request.params.arguments ?? {} },
	isError: !live,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
	contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "resource body" }],
}));
server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
	messages: [{ role: "user", content: { type: "text", text: `prompt:${request.params.arguments?.text ?? ""}` } }],
}));

await server.connect(new StdioServerTransport());
