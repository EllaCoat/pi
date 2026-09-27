import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		{ label: "no usage", usage: undefined, costKnown: undefined },
		{
			label: "reported usage with explicitly zero rates",
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			costKnown: true,
		},
	] as const)("preserves cost provenance for $label", async ({ usage, costKnown }) => {
		const model = {
			...getModel("openai", "gpt-5.4"),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const response = {
			status: "completed",
			...(usage === undefined ? {} : { usage }),
		};
		const sse = `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			normalizeContext({
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			}),
			{ apiKey: "test-key" },
		);
		const result = await stream.result();

		expect(result.usage.cost.total).toBe(0);
		expect(result.usage.cost.known).toBe(costKnown);
		expect(result.usage.totalTokens).toBe(usage?.total_tokens ?? 0);
	});
});
