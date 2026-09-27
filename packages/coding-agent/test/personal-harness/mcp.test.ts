import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	CallToolRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { HarnessMcpClient } from "../../src/personal-harness/mcp/index.ts";
import { allowNetwork } from "../test-network-env.ts";

interface HttpFixtureOptions {
	sessionless?: boolean;
	rejectToolCalls?: boolean;
}

interface HttpFixture {
	url: string;
	toolCallCount: () => number;
	waitForToolCall: () => Promise<void>;
	sessionClosed: () => boolean;
	close: () => Promise<void>;
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function createHttpFixture(options: HttpFixtureOptions = {}): Promise<HttpFixture> {
	const toolCallWaiters: Array<() => void> = [];
	let toolCalls = 0;
	const mcpServer = new McpServer(
		{ name: "personal-harness-http-fixture", version: "1.0.0" },
		{ capabilities: { tools: {}, resources: {}, prompts: {} } },
	);
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: options.sessionless ? undefined : randomUUID,
	});

	mcpServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
		if (request.params?.cursor === "second-tools") {
			return {
				tools: [
					{
						name: "alpha",
						inputSchema: { type: "object", properties: { value: { type: "string" } } },
						outputSchema: { type: "object", properties: { alpha: { type: "string" } }, required: ["alpha"] },
					},
				],
			};
		}
		return {
			tools: [
				{
					name: "zeta",
					inputSchema: { type: "object", properties: { value: { type: "string" } } },
					outputSchema: { type: "object", properties: { zeta: { type: "string" } }, required: ["zeta"] },
				},
			],
			nextCursor: "second-tools",
		};
	});
	mcpServer.setRequestHandler(ListResourcesRequestSchema, async (request) => {
		if (request.params?.cursor === "second-resources")
			return { resources: [{ uri: "fixture://b", name: "resource b" }] };
		return { resources: [{ uri: "fixture://a", name: "resource a" }], nextCursor: "second-resources" };
	});
	mcpServer.setRequestHandler(ListPromptsRequestSchema, async (request) => {
		if (request.params?.cursor === "second-prompts") return { prompts: [{ name: "prompt-b" }] };
		return { prompts: [{ name: "prompt-a" }], nextCursor: "second-prompts" };
	});
	mcpServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		if (request.params.name === "slow") {
			await new Promise<void>((resolve) => {
				if (extra.signal.aborted) {
					resolve();
					return;
				}
				extra.signal.addEventListener("abort", () => resolve(), { once: true });
			});
		}
		const args = request.params.arguments ?? {};
		const structuredContent =
			args.invalid === true
				? {}
				: request.params.name === "zeta"
					? { zeta: "fixture" }
					: request.params.name === "alpha"
						? { alpha: "fixture" }
						: { received: args };
		return {
			content: [
				{ type: "text", text: `received:${String(request.params.arguments?.value ?? "")}` },
				{ type: "image", data: "AQID", mimeType: "image/png" },
			],
			structuredContent,
			isError: args.invalid === true || (request.params.name !== "zeta" && request.params.name !== "alpha"),
		};
	});
	await mcpServer.connect(transport);
	let sessionClosed = false;
	const onTransportClose = transport.onclose;
	transport.onclose = () => {
		sessionClosed = true;
		onTransportClose?.();
	};

	const httpServer = createServer((request, response) => {
		void (async () => {
			if (request.method === "POST") {
				const body = await readRequestBody(request);
				if (
					typeof body === "object" &&
					body !== null &&
					!Array.isArray(body) &&
					"method" in body &&
					body.method === "tools/call"
				) {
					toolCalls++;
					toolCallWaiters.shift()?.();
					if (options.rejectToolCalls) {
						response.writeHead(401, { "www-authenticate": 'Bearer realm="fixture"' });
						response.end("authentication required");
						return;
					}
				}
				await transport.handleRequest(request, response, body);
				return;
			}
			await transport.handleRequest(request, response);
		})().catch(() => {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(0, "127.0.0.1", resolve);
	});
	const address = httpServer.address();
	if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind to a TCP address");

	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		toolCallCount: () => toolCalls,
		sessionClosed: () => sessionClosed,
		waitForToolCall: () => new Promise<void>((resolve) => toolCallWaiters.push(resolve)),
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				httpServer.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
			await mcpServer.close();
		},
	};
}

function createFixtureOAuthProvider(): { provider: OAuthClientProvider; redirectCount: () => number } {
	let redirects = 0;
	const provider = {
		redirectUrl: undefined,
		clientMetadata: { client_name: "personal-harness-test", redirect_uris: ["http://127.0.0.1/callback"] },
		clientInformation: async () => undefined,
		tokens: async () => ({ access_token: "fixture-token", token_type: "Bearer", expires_in: 3_600 }),
		saveTokens: async () => undefined,
		redirectToAuthorization: async () => {
			redirects++;
		},
		saveCodeVerifier: async () => undefined,
		codeVerifier: async () => "fixture-verifier",
	} satisfies OAuthClientProvider;
	return { provider, redirectCount: () => redirects };
}

beforeEach(allowNetwork);

describe("HarnessMcpClient", () => {
	test("connects to stdio and preserves text, image, structured content, and error state", async () => {
		const fixture = fileURLToPath(new URL("./mcp-stdio.fixture.mjs", import.meta.url));
		const client = new HarnessMcpClient({
			transport: { type: "stdio", command: process.execPath, args: [fixture], cwd: process.cwd() },
		});
		try {
			const info = await client.connect();
			expect(info.transportType).toBe("stdio");
			expect(info.serverVersion?.name).toBe("personal-harness-stdio-fixture");
			expect((await client.listResources()).map((resource) => resource.uri)).toEqual(["fixture://stdio"]);
			expect((await client.listPrompts()).map((prompt) => prompt.name)).toEqual(["stdio-prompt"]);
			expect((await client.readResource("fixture://stdio")).contents).toEqual([
				{ uri: "fixture://stdio", mimeType: "text/plain", text: "resource body" },
			]);
			expect((await client.getPrompt("stdio-prompt", { text: "hello" })).messages).toEqual([
				{ role: "user", content: { type: "text", text: "prompt:hello" } },
			]);
			const result = await client.call("echo", { text: "hello" });
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				{ type: "text", text: "echo:hello" },
				{ type: "image", data: "AQID", mimeType: "image/png" },
			]);
			expect(result.structuredContent).toEqual({ received: { text: "hello" } });
			const reconnected = await client.reconnect();
			expect(reconnected.serverVersion?.name).toBe("personal-harness-stdio-fixture");
			expect(client.isConnected).toBe(true);
		} finally {
			await client.close();
		}
	});
	test("reconnects the same client after its stdio server exits", async () => {
		const fixture = fileURLToPath(new URL("./mcp-stdio.fixture.mjs", import.meta.url));
		const transports: StdioClientTransport[] = [];
		const originalStart = StdioClientTransport.prototype.start;
		const startSpy = vi.spyOn(StdioClientTransport.prototype, "start").mockImplementation(async function (
			this: StdioClientTransport,
		) {
			await originalStart.call(this);
			transports.push(this);
		});
		const client = new HarnessMcpClient({
			transport: { type: "stdio", command: process.execPath, args: [fixture], cwd: process.cwd() },
		});
		try {
			await client.connect();
			const serverPid = transports[0]?.pid;
			if (serverPid === null || serverPid === undefined) throw new Error("stdio server process was not started");
			process.kill(serverPid, "SIGTERM");
			await vi.waitFor(() => expect(client.isConnected).toBe(false));

			await client.connect();
			expect(client.isConnected).toBe(true);
			expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
		} finally {
			startSpy.mockRestore();
			await client.close();
		}
	});

	test("paginates discovery, preserves result types, and validates every tool output schema", async () => {
		const fixture = await createHttpFixture();
		const client = new HarnessMcpClient({ transport: { type: "streamable-http", url: fixture.url } });
		try {
			const info = await client.connect();
			expect(info.transportType).toBe("streamable-http");
			const [tools, resources, prompts] = await Promise.all([
				client.listTools(),
				client.listResources(),
				client.listPrompts(),
			]);
			expect(tools.tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
			expect(tools.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect((await client.listTools()).fingerprint).toBe(tools.fingerprint);
			expect(resources.map((resource) => resource.uri)).toEqual(["fixture://a", "fixture://b"]);
			expect(prompts.map((prompt) => prompt.name)).toEqual(["prompt-a", "prompt-b"]);

			const result = await client.call("echo", { value: "http" });
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				{ type: "text", text: "received:http" },
				{ type: "image", data: "AQID", mimeType: "image/png" },
			]);
			expect(result.structuredContent).toEqual({ received: { value: "http" } });
			expect((await client.call("zeta")).structuredContent).toEqual({ zeta: "fixture" });
			expect((await client.call("alpha")).structuredContent).toEqual({ alpha: "fixture" });
			await expect(client.call("zeta", { invalid: true })).rejects.toMatchObject({ kind: "protocol" });
			await expect(client.call("alpha", { invalid: true })).rejects.toMatchObject({ kind: "protocol" });

			await client.close();
			expect(fixture.sessionClosed()).toBe(true);
		} finally {
			await client.close();
			await fixture.close();
		}
	});

	test("reconnects after a Streamable HTTP disconnect and ignores an old close callback", async () => {
		const fixture = await createHttpFixture({ sessionless: true });
		const transports: StreamableHTTPClientTransport[] = [];
		const originalStart = StreamableHTTPClientTransport.prototype.start;
		const startSpy = vi.spyOn(StreamableHTTPClientTransport.prototype, "start").mockImplementation(async function (
			this: StreamableHTTPClientTransport,
		) {
			await originalStart.call(this);
			transports.push(this);
		});
		const client = new HarnessMcpClient({ transport: { type: "streamable-http", url: fixture.url } });
		try {
			await client.connect();
			const disconnectedTransport = transports[0];
			if (!disconnectedTransport) throw new Error("HTTP transport was not started");
			await disconnectedTransport.close();
			expect(client.isConnected).toBe(false);

			await client.connect();
			expect(client.isConnected).toBe(true);
			await disconnectedTransport.close();
			expect(client.isConnected).toBe(true);
			expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
		} finally {
			startSpy.mockRestore();
			await client.close();
			await fixture.close();
		}
	});

	test("distinguishes plain HTTP 401 from OAuth-required and never retries a tool call", async () => {
		const plainFixture = await createHttpFixture({ rejectToolCalls: true });
		const plainClient = new HarnessMcpClient({ transport: { type: "streamable-http", url: plainFixture.url } });
		try {
			await plainClient.connect();
			await expect(plainClient.call("non-idempotent")).rejects.toMatchObject({
				kind: "http-unauthorized",
				statusCode: 401,
			});
			expect(plainFixture.toolCallCount()).toBe(1);
		} finally {
			await plainClient.close();
			await plainFixture.close();
		}

		const oauthFixture = await createHttpFixture({ rejectToolCalls: true });
		const auth = createFixtureOAuthProvider();
		const oauthClient = new HarnessMcpClient({
			transport: { type: "streamable-http", url: oauthFixture.url, authProvider: auth.provider },
		});
		try {
			await oauthClient.connect();
			await expect(oauthClient.call("non-idempotent")).rejects.toMatchObject({
				kind: "oauth-required",
				statusCode: 401,
			});
			expect(oauthFixture.toolCallCount()).toBe(1);
			expect(auth.redirectCount()).toBe(0);
		} finally {
			await oauthClient.close();
			await oauthFixture.close();
		}
	});

	test("propagates request cancellation and timeout as distinct errors", async () => {
		const fixture = await createHttpFixture();
		const client = new HarnessMcpClient({ transport: { type: "streamable-http", url: fixture.url } });
		try {
			await client.connect();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const timeoutStarted = fixture.waitForToolCall();
				const timedCall = client.call("slow", {}, { timeoutMs: 30 });
				const timeoutExpectation = expect(timedCall).rejects.toMatchObject({ kind: "timeout" });
				await timeoutStarted;
				await vi.advanceTimersByTimeAsync(30);
				await timeoutExpectation;
			} finally {
				vi.useRealTimers();
			}

			const controller = new AbortController();
			const abortStarted = fixture.waitForToolCall();
			const abortedCall = client.call("slow", {}, { signal: controller.signal });
			const abortExpectation = expect(abortedCall).rejects.toMatchObject({ kind: "aborted" });
			await abortStarted;
			controller.abort();
			await abortExpectation;
		} finally {
			await client.close();
			await fixture.close();
		}
	});
	test("reconnects while an aborted HTTP initialization is cleaning up", async () => {
		const fixture = await createHttpFixture();
		let announceInitializeStarted: () => void = () => {};
		const initializeStarted = new Promise<void>((resolve) => {
			announceInitializeStarted = resolve;
		});
		let blockFirstInitialize = true;
		const fetch: FetchLike = async (url, init) => {
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
			const isInitialize =
				typeof body === "object" &&
				body !== null &&
				!Array.isArray(body) &&
				"method" in body &&
				body.method === "initialize";
			if (blockFirstInitialize && isInitialize) {
				blockFirstInitialize = false;
				announceInitializeStarted();
				const signal = init?.signal;
				if (!signal) throw new Error("Expected an abort signal for the initialization request");
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
			}
			return globalThis.fetch(url, init);
		};
		const client = new HarnessMcpClient({
			transport: { type: "streamable-http", url: fixture.url, fetch },
		});
		const controller = new AbortController();
		try {
			const pendingConnect = client.connect({ signal: controller.signal });
			const abortedConnect = expect(pendingConnect).rejects.toMatchObject({ kind: "aborted" });
			await initializeStarted;
			controller.abort();
			const reconnecting = client.reconnect();
			await Promise.all([abortedConnect, reconnecting]);

			expect(client.isConnected).toBe(true);
			expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
		} finally {
			await client.close();
			await fixture.close();
		}
	});
});
