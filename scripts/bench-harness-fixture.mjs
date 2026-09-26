import { createHash } from "node:crypto";
import { getCurrentSystemMessage, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "pi-harness-offline-benchmark";
export const API_ID = "pi-harness-offline-benchmark-api";
export const MODEL_ID = "offline-fixture-model";
export const TOOL_NAME = "benchmark_action";
export const TOOL_INPUT = "continue";
export const TOOL_RESULT = "fixture action completed";
export const FINAL_ANSWER = "Bench complete.";
export const SESSION_ID = "offline-benchmark-session";
export const MODEL_DELAY_MS = 20;
export const WARM_TURN_COUNT = 5;
export const FIXED_TIMESTAMP = 1_794_000_000_000;

const longSystemBlock = "A fixed synthetic policy block for measuring local request preparation.\n".repeat(64);
const longHistoryBlock = "A fixed synthetic history fragment used only by the offline harness benchmark. ".repeat(32);

export const SYSTEM_PROMPT = `You are processing a deterministic offline benchmark. Call ${TOOL_NAME} once with value ${TOOL_INPUT}, then return exactly ${FINAL_ANSWER}\n${longSystemBlock}`;

export const HISTORY = [
	{ role: "user", content: `Earlier synthetic request: ${longHistoryBlock}`, timestamp: FIXED_TIMESTAMP },
	{
		role: "assistant",
		content: [{ type: "text", text: `Earlier synthetic response: ${longHistoryBlock}` }],
		api: API_ID,
		provider: PROVIDER_ID,
		model: MODEL_ID,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: FIXED_TIMESTAMP + 1,
	},
	{ role: "user", content: `A second synthetic request: ${longHistoryBlock}`, timestamp: FIXED_TIMESTAMP + 2 },
	{
		role: "assistant",
		content: [{ type: "text", text: `A second synthetic response: ${longHistoryBlock}` }],
		api: API_ID,
		provider: PROVIDER_ID,
		model: MODEL_ID,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: FIXED_TIMESTAMP + 3,
	},
];

export const USER_PROMPT = `Perform the deterministic local action with value ${TOOL_INPUT} and then answer exactly ${FINAL_ANSWER}`;
export const TOOL_DESCRIPTION = "Record one deterministic local benchmark action.";

function normalizeContent(content) {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return null;
	return content.map((part) => {
		if (!part || typeof part !== "object") return part;
		if (part.type === "text") return { type: part.type, text: part.text ?? "" };
		if (part.type === "toolCall") {
			return { type: part.type, id: part.id ?? "", name: part.name ?? "", arguments: part.arguments ?? {} };
		}
		if (part.type === "thinking") return { type: part.type, thinking: part.thinking ?? "" };
		return { type: part.type ?? "unknown" };
	});
}

function normalizeMessage(message) {
	if (!message || typeof message !== "object") return message;
	return {
		role: message.role ?? "unknown",
		content: normalizeContent(message.content),
		...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
		...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
		...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
	};
}
const NON_REQUEST_MESSAGE_FIELDS = [
	"api",
	"deferred",
	"diagnostics",
	"endTurn",
	"errorMessage",
	"model",
	"provider",
	"providerThinkingLevel",
	"rawStopReason",
	"responseId",
	"responseModel",
	"stopReason",
	"timestamp",
	"usage",
];

export const REQUEST_NORMALIZATION = {
	ignoredMessageFields: NON_REQUEST_MESSAGE_FIELDS,
	canonicalizedToolCallFields: ["content[].id", "message.toolCallId"],
	sections: ["systemPrompt", "messages", "tools"],
};

function canonicalToolCallId(id, toolCallIds) {
	if (typeof id !== "string") return id;
	let canonical = toolCallIds.get(id);
	if (!canonical) {
		canonical = `tool-call-${toolCallIds.size + 1}`;
		toolCallIds.set(id, canonical);
	}
	return canonical;
}

function normalizeRequestMessage(message, toolCallIds) {
	if (!message || typeof message !== "object") return message;
	const normalized = normalizeMessage(message);
	for (const field of NON_REQUEST_MESSAGE_FIELDS) delete normalized[field];
	if (typeof message.toolCallId === "string") normalized.toolCallId = canonicalToolCallId(message.toolCallId, toolCallIds);
	if (Array.isArray(normalized.content)) {
		normalized.content = normalized.content.map((part) => {
			if (!part || typeof part !== "object" || part.type !== "toolCall" || typeof part.id !== "string") return part;
			return { ...part, id: canonicalToolCallId(part.id, toolCallIds) };
		});
	}
	return normalized;
}

export function normalizeRequest(context, options) {
	const systemMessage = getCurrentSystemMessage(context.messages ?? []);
	const systemPrompt = context.systemPrompt ?? (systemMessage ? getSystemMessageText(systemMessage) : undefined);
	const toolCallIds = new Map();
	return {
		systemPrompt: Array.isArray(systemPrompt) ? systemPrompt : (systemPrompt == null ? [] : [String(systemPrompt)]),
		messages: Array.isArray(context?.messages) ? context.messages.filter((message) => message.role !== "system").map((message) => normalizeRequestMessage(message, toolCallIds)) : [],
		tools: (options?.tools ?? context.tools ?? getCurrentTools(context.messages ?? [])).map(normalizeTool),
	};
}


function normalizeTool(tool) {
	if (!tool || typeof tool !== "object") return tool;
	const normalized = {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters ?? tool.inputSchema ?? tool.schema ?? null,
	};
	delete normalized.inputSchema;
	delete normalized.schema;
	return normalized;
}

export function fingerprintRequest(context, options) {
	return createHash("sha256").update(JSON.stringify(normalizeRequest(context, options))).digest("hex");
}

export function fixtureFingerprint() {
	const payload = {
		systemPrompt: SYSTEM_PROMPT,
		history: HISTORY.map(normalizeMessage),
		userPrompt: USER_PROMPT,
		tool: { name: TOOL_NAME, description: TOOL_DESCRIPTION, input: { value: TOOL_INPUT }, result: TOOL_RESULT },
	};
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
