import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../core/model-registry.ts";
import { isRecord } from "./hooks/jev-types.ts";
import { type HarnessModelSelection, harnessResponseText } from "./model-call.ts";
import { type HarnessUsageLedger, reportedModelUsage } from "./usage.ts";

export interface WebSearchInput {
	query: string;
	limit?: number;
	recency?: "day" | "week" | "month" | "year";
}
export interface WebSearchSource {
	title: string;
	url: string;
}
export interface HarnessWebSearchOptions {
	registry: ModelRegistry;
	selection: HarnessModelSelection;
	ledger: HarnessUsageLedger;
	signal?: AbortSignal;
	sessionId: string;
}

export async function searchHarnessWeb(input: WebSearchInput, options: HarnessWebSearchOptions) {
	const query = input.query.trim();
	const limit = input.limit ?? 5;
	if (!query || !Number.isInteger(limit) || limit < 1 || limit > 20)
		throw new Error("A query and a result limit from 1 to 20 are required");
	const model = options.registry.find(options.selection.provider, options.selection.model);
	if (!model || model.api !== "openai-codex-responses")
		throw new Error("Web search requires a configured Codex Responses model");
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
		: AbortSignal.timeout(60_000);
	signal.throwIfAborted();
	const sources = new Map<string, WebSearchSource>();
	let searched = false;
	const collectItem = (item: unknown): void => {
		if (!isRecord(item)) return;
		if (item.type === "web_search_call") {
			searched = true;
			const action = isRecord(item.action) ? item.action : undefined;
			for (const candidate of Array.isArray(action?.sources) ? action.sources : []) {
				if (isRecord(candidate)) addSource(candidate);
			}
		}
		if (item.type === "message" && Array.isArray(item.content)) {
			for (const part of item.content) {
				if (!isRecord(part) || !Array.isArray(part.annotations)) continue;
				for (const annotation of part.annotations) {
					if (isRecord(annotation) && annotation.type === "url_citation") addSource(annotation);
				}
			}
		}
	};
	const addSource = (source: Record<string, unknown>): void => {
		if (typeof source.url !== "string") return;
		let url: URL;
		try {
			url = new URL(source.url);
		} catch {
			return;
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") return;
		if (!sources.has(url.href))
			sources.set(url.href, { title: typeof source.title === "string" ? source.title : url.href, url: url.href });
	};
	const started = performance.now();
	let response: AssistantMessage | undefined;
	let status: "success" | "error" | "aborted" = "error";
	try {
		response = await options.registry
			.streamSimple(
				model,
				{
					messages: [
						{
							role: "system",
							content:
								"Search the web for the supplied query. Answer using retrieved sources and cite their URLs. Do not answer from memory alone.",
							timestamp: 0,
						},
						{
							role: "user",
							content: input.recency ? `${query}\nPrefer sources from the past ${input.recency}.` : query,
							timestamp: Date.now(),
						},
					],
				},
				{
					signal,
					transport: "sse",
					reasoning: options.selection.thinking === "off" ? undefined : options.selection.thinking,
					maxTokens: 4096,
					sessionId: `${options.sessionId}:web-search`,
					onPayload: (payload) => {
						if (!isRecord(payload)) throw new Error("Unsupported web search request payload");
						return {
							...payload,
							tools: [{ type: "web_search", search_context_size: "medium" }],
							tool_choice: { type: "web_search" },
							include: [
								...new Set([
									...(Array.isArray(payload.include) ? payload.include : []),
									"web_search_call.action.sources",
								]),
							],
						};
					},
					onProviderStreamEvent: (event) => {
						if (!isRecord(event)) return;
						if (typeof event.type === "string" && event.type.startsWith("response.web_search_call"))
							searched = true;
						if (event.type === "response.output_item.done") collectItem(event.item);
						if (isRecord(event.response) && Array.isArray(event.response.output))
							event.response.output.forEach(collectItem);
					},
				},
			)
			.result();
		signal.throwIfAborted();
		if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length")
			throw new Error(response.errorMessage ?? "Web search did not complete");
		if (!searched) throw new Error("The model did not invoke web search; its answer is not a verified search result");
		if (!sources.size) throw new Error("Web search did not return source URLs");
		status = "success";
		return {
			query,
			answer: harnessResponseText(response),
			sources: [...sources.values()].slice(0, limit),
			model: `${options.selection.provider}/${options.selection.model}`,
		};
	} finally {
		if (signal.aborted) status = "aborted";
		options.ledger.record({
			purpose: "web-search",
			model: `${options.selection.provider}/${options.selection.model}`,
			durationMs: performance.now() - started,
			status,
			usage: response ? reportedModelUsage(response) : undefined,
			costReported: false,
		});
	}
}
