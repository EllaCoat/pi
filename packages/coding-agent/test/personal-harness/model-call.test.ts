import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
	type OpenAICodexResponsesOptions,
	stream as streamCodex,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../../src/core/model-registry.ts";
import { completeHarnessTask, LUNA_HIGH_FAST, LUNA_MAX } from "../../src/personal-harness/model-call.ts";
import { HarnessUsageLedger } from "../../src/personal-harness/usage.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let tempAgentDir: string | undefined;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (tempAgentDir) rmSync(tempAgentDir, { recursive: true, force: true });
	tempAgentDir = undefined;
});

function fixture(api: Api = "openai-codex-responses") {
	const model = {
		api,
		provider: "openai-codex",
		id: "gpt-6-luna",
		reasoning: true,
		thinkingLevelMap: { max: "max" },
	} as Model<Api>;
	const response = fauxAssistantMessage("fixture response");
	const result = vi.fn(async () => response);
	const stream = vi.fn(() => ({ result }));
	const streamSimple = vi.fn((..._args: Parameters<ModelRegistry["streamSimple"]>) => ({ result }));
	const registry = {
		find: vi.fn(() => model),
		stream,
		streamSimple,
	} as unknown as ModelRegistry;
	return { model, response, stream, streamSimple, registry };
}

const context: Context = { messages: [{ role: "user", content: "fixture input", timestamp: 1 }] };

describe("personal harness model calls", () => {
	it("uses Luna/high and sends Codex Fast Mode through the typed priority stream options", async () => {
		const f = fixture();
		const ledger = new HarnessUsageLedger();
		const response = await completeHarnessTask({
			registry: f.registry,
			selection: LUNA_HIGH_FAST,
			purpose: "memory",
			context,
			ledger,
		});

		expect(response).toBe(f.response);
		expect(f.stream).toHaveBeenCalledWith(
			f.model,
			context,
			expect.objectContaining({ reasoningEffort: "high", serviceTier: "priority", maxTokens: 8192 }),
		);
		expect(f.streamSimple).not.toHaveBeenCalled();
		expect(ledger.snapshot().memory).toMatchObject({ calls: 1, failed: 0 });
	});

	it("keeps Luna/max non-Fast requests on the provider-neutral simple stream", async () => {
		const f = fixture();
		await completeHarnessTask({
			registry: f.registry,
			selection: LUNA_MAX,
			purpose: "todo",
			context,
			ledger: new HarnessUsageLedger(),
		});

		const options = f.streamSimple.mock.calls[0]?.[2];
		expect(options).toMatchObject({ reasoning: "max", maxTokens: 8192 });
		expect(options).not.toHaveProperty("serviceTier");
		expect(f.stream).not.toHaveBeenCalled();
	});

	it("rejects Fast Mode for APIs that cannot receive the Codex service tier", async () => {
		const f = fixture("anthropic-messages");
		const ledger = new HarnessUsageLedger();

		await expect(
			completeHarnessTask({
				registry: f.registry,
				selection: LUNA_HIGH_FAST,
				purpose: "memory",
				context,
				ledger,
			}),
		).rejects.toThrow("does not support Codex Fast Mode");
		expect(f.streamSimple).not.toHaveBeenCalled();
		expect(f.stream).not.toHaveBeenCalled();
		expect(ledger.snapshot().memory).toMatchObject({ calls: 1, failed: 1 });
	});

	it("includes service_tier=priority in the actual Codex request payload", async () => {
		tempAgentDir = mkdtempSync(join(tmpdir(), "pi-harness-codex-fast-"));
		process.env.PI_CODING_AGENT_DIR = tempAgentDir;
		const jwtPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
		).toString("base64");
		const apiKey = `aaa.${jwtPayload}.bbb`;
		const sse = [
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "READY" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "READY" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n");
		const responseBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`${sse}\n\n`));
				controller.close();
			},
		});
		let payloadServiceTier: unknown;
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(responseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-6-luna",
			name: "GPT-6 Luna",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		const registry = {
			find: () => model,
			stream: (
				requestModel: Model<"openai-codex-responses">,
				requestContext: Context,
				options: ModelsApiStreamOptions<"openai-codex-responses">,
			) => {
				const codexOptions = {
					...options,
					apiKey,
					transport: "sse",
					onPayload: (payload: unknown) => {
						if (typeof payload === "object" && payload !== null) {
							payloadServiceTier = Reflect.get(payload, "service_tier");
						}
					},
				} as OpenAICodexResponsesOptions;
				return streamCodex(requestModel, normalizeContext(requestContext), codexOptions);
			},
		} as unknown as ModelRegistry;

		const response = await completeHarnessTask({
			registry,
			selection: LUNA_HIGH_FAST,
			purpose: "memory",
			context,
			ledger: new HarnessUsageLedger(),
		});

		expect(
			response.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		).toContain("READY");
		expect(payloadServiceTier).toBe("priority");
	});
});
