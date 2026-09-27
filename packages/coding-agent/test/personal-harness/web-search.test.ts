import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../../src/core/model-registry.ts";
import { HarnessUsageLedger } from "../../src/personal-harness/usage.ts";
import { searchHarnessWeb } from "../../src/personal-harness/web-search.ts";

function fixture(events: unknown[]) {
	const payloads: unknown[] = [];
	const model = { api: "openai-codex-responses", provider: "openai-codex", id: "fixture" } as Model<Api>;
	const stream = vi.fn((_model: unknown, _context: unknown, options: SimpleStreamOptions) => ({
		result: async () => {
			payloads.push(
				await options.onPayload?.({ model: "fixture", include: ["reasoning.encrypted_content"] }, model),
			);
			for (const event of events) await options.onProviderStreamEvent?.(event, model);
			return fauxAssistantMessage("A sourced answer.");
		},
	}));
	return { payloads, stream, registry: { find: () => model, streamSimple: stream } as unknown as ModelRegistry };
}
const selection = { provider: "openai-codex", model: "fixture", thinking: "low" as const };

describe("personal harness web search", () => {
	it("uses native search through the authenticated registry and returns deduplicated source URLs", async () => {
		const f = fixture([
			{
				type: "response.output_item.done",
				item: {
					type: "web_search_call",
					action: { sources: [{ title: "Official", url: "https://example.com/docs" }] },
				},
			},
			{
				type: "response.completed",
				response: {
					output: [
						{
							type: "message",
							content: [
								{
									type: "output_text",
									annotations: [
										{ type: "url_citation", title: "Duplicate", url: "https://example.com/docs" },
										{ type: "url_citation", title: "Unsafe", url: "javascript:alert(1)" },
									],
								},
							],
						},
					],
				},
			},
		]);
		const ledger = new HarnessUsageLedger();
		const result = await searchHarnessWeb(
			{ query: "public query", limit: 5 },
			{ registry: f.registry, selection, ledger, sessionId: "test" },
		);
		expect(result.sources).toEqual([{ title: "Official", url: "https://example.com/docs" }]);
		expect(result.answer).toBe("A sourced answer.");
		expect(f.payloads[0]).toMatchObject({
			tools: [{ type: "web_search" }],
			tool_choice: { type: "web_search" },
			include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
		});
		expect(ledger.snapshot()["web-search"]).toMatchObject({ calls: 1, failed: 0, unreportedCostCalls: 1 });
	});
	it("does not present an ungrounded model answer as a search result", async () => {
		const f = fixture([]);
		const ledger = new HarnessUsageLedger();
		await expect(
			searchHarnessWeb({ query: "query" }, { registry: f.registry, selection, ledger, sessionId: "test" }),
		).rejects.toThrow("did not invoke web search");
		expect(ledger.snapshot()["web-search"]).toMatchObject({ calls: 1, failed: 1 });
	});
	it("does not start a request that is already canceled", async () => {
		const f = fixture([]);
		const controller = new AbortController();
		controller.abort();
		await expect(
			searchHarnessWeb(
				{ query: "query" },
				{
					registry: f.registry,
					selection,
					ledger: new HarnessUsageLedger(),
					sessionId: "test",
					signal: controller.signal,
				},
			),
		).rejects.toThrow();
		expect(f.stream).not.toHaveBeenCalled();
	});
});
