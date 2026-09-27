import { createHash } from "node:crypto";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions as McpRequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type {
	HarnessMcpCallResult,
	HarnessMcpClientOptions,
	HarnessMcpErrorKind,
	HarnessMcpGetPromptResult,
	HarnessMcpPrompt,
	HarnessMcpReadResourceResult,
	HarnessMcpRequestOptions,
	HarnessMcpResource,
	HarnessMcpServerInfo,
	HarnessMcpTool,
	HarnessMcpToolIndex,
} from "./types.ts";

type HarnessMcpTransportInstance = StdioClientTransport | StreamableHTTPClientTransport;

export class HarnessMcpError extends Error {
	readonly kind: HarnessMcpErrorKind;
	readonly statusCode?: number;

	constructor(kind: HarnessMcpErrorKind, statusCode?: number) {
		super(errorMessage(kind, statusCode));
		this.name = "HarnessMcpError";
		this.kind = kind;
		this.statusCode = statusCode;
	}
}

function errorMessage(kind: HarnessMcpErrorKind, statusCode?: number): string {
	switch (kind) {
		case "oauth-required":
			return "MCP OAuth authentication is required";
		case "http-unauthorized":
			return "MCP server rejected the request with HTTP 401";
		case "http-error":
			return statusCode === undefined
				? "MCP HTTP request failed"
				: `MCP HTTP request failed with status ${statusCode}`;
		case "timeout":
			return "MCP request timed out";
		case "aborted":
			return "MCP request was cancelled";
		case "not-connected":
			return "MCP client is not connected";
		case "invalid-state":
			return "MCP client is in an invalid connection state";
		case "invalid-options":
			return "MCP transport options are invalid";
		case "protocol":
			return "MCP server returned an invalid or inconsistent protocol response";
		case "transport":
			return "MCP transport operation failed";
	}
}

function normalizeFailure(error: unknown, signal: AbortSignal | undefined, usesOAuth: boolean): HarnessMcpError {
	if (error instanceof HarnessMcpError) return error;
	if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
		return new HarnessMcpError("aborted");
	}
	if (error instanceof UnauthorizedError) return new HarnessMcpError("oauth-required", 401);
	if (error instanceof StreamableHTTPError) {
		if (error.code === 401) {
			return new HarnessMcpError(usesOAuth ? "oauth-required" : "http-unauthorized", 401);
		}
		if (error.code !== undefined && error.code >= 100 && error.code <= 599) {
			return new HarnessMcpError("http-error", error.code);
		}
		return new HarnessMcpError("transport");
	}
	if (error instanceof McpError) {
		if (error.code === ErrorCode.RequestTimeout) return new HarnessMcpError("timeout");
		return new HarnessMcpError("protocol");
	}
	return new HarnessMcpError("transport");
}

function toMcpRequestOptions(options?: HarnessMcpRequestOptions): McpRequestOptions {
	const requestOptions: McpRequestOptions = {};
	if (options?.signal !== undefined) requestOptions.signal = options.signal;
	if (options?.timeoutMs !== undefined) requestOptions.timeout = options.timeoutMs;
	if (options?.maxTotalTimeoutMs !== undefined) requestOptions.maxTotalTimeout = options.maxTotalTimeoutMs;
	return requestOptions;
}

function containsToolCall(body: RequestInit["body"]): boolean {
	if (typeof body !== "string") return false;
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return false;
	}
	const messages = Array.isArray(payload) ? payload : [payload];
	return messages.some(
		(message) =>
			typeof message === "object" &&
			message !== null &&
			!Array.isArray(message) &&
			"method" in message &&
			message.method === "tools/call",
	);
}

function protectToolCallRetries(fetch: FetchLike, usesOAuth: boolean): FetchLike {
	return async (url, init) => {
		const response = await fetch(url, init);
		if (!containsToolCall(init?.body)) return response;

		const oauthRetry =
			usesOAuth &&
			(response.status === 401 ||
				(response.status === 403 &&
					/\berror\s*=\s*"?insufficient_scope"?/i.test(response.headers.get("www-authenticate") ?? "")));
		if (response.status !== 401 && !oauthRetry) return response;

		await response.body?.cancel().catch(() => undefined);
		throw new HarnessMcpError(oauthRetry ? "oauth-required" : "http-unauthorized", response.status);
	};
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function sortTools(tools: HarnessMcpTool[]): HarnessMcpTool[] {
	return tools.sort((left, right) => {
		const byName = left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
		if (byName !== 0) return byName;
		const leftMetadata = stableJson(left);
		const rightMetadata = stableJson(right);
		return leftMetadata < rightMetadata ? -1 : leftMetadata > rightMetadata ? 1 : 0;
	});
}

export class HarnessMcpClient {
	readonly #options: HarnessMcpClientOptions;
	readonly #jsonSchemaValidator = new AjvJsonSchemaValidator();
	#toolOutputValidators = new Map<string, JsonSchemaValidator<unknown>>();
	#client: Client | undefined;
	#transport: HarnessMcpTransportInstance | undefined;
	#state: "disconnected" | "connecting" | "connected" | "closing" = "disconnected";
	#connectAbort: AbortController | undefined;
	#connectPromise: Promise<HarnessMcpServerInfo> | undefined;
	#closePromise: Promise<void> | undefined;

	constructor(options: HarnessMcpClientOptions) {
		this.#options = options;
	}

	get isConnected(): boolean {
		return this.#state === "connected";
	}

	getInfo(): HarnessMcpServerInfo | null {
		if (this.#state !== "connected" || !this.#client) return null;
		return this.#buildInfo(this.#client);
	}

	async connect(options?: HarnessMcpRequestOptions): Promise<HarnessMcpServerInfo> {
		if (this.#state === "connected") {
			const info = this.getInfo();
			if (info) return info;
		}
		if (this.#state !== "disconnected" || this.#client || this.#connectPromise)
			throw new HarnessMcpError("invalid-state");

		const clientInfo = this.#options.clientInfo ?? { name: "pi-personal-harness", version: "1.0.0" };
		const client = new Client(clientInfo, { jsonSchemaValidator: this.#jsonSchemaValidator });
		let transport: HarnessMcpTransportInstance;
		try {
			transport = this.#createTransport();
		} catch (error) {
			throw error instanceof HarnessMcpError ? error : new HarnessMcpError("invalid-options");
		}

		this.#state = "connecting";
		this.#client = client;
		this.#transport = transport;
		const connectAbort = new AbortController();
		this.#connectAbort = connectAbort;
		const signal = options?.signal ? AbortSignal.any([options.signal, connectAbort.signal]) : connectAbort.signal;
		const requestOptions = toMcpRequestOptions({ ...options, signal });
		client.onclose = () => {
			if (this.#client !== client || this.#state === "closing") return;
			this.#client = undefined;
			this.#transport = undefined;
			this.#toolOutputValidators.clear();
			this.#state = "disconnected";
		};

		const attempt = this.#connect(client, transport, requestOptions, signal);
		this.#connectPromise = attempt;
		try {
			return await attempt;
		} finally {
			if (this.#connectPromise === attempt) this.#connectPromise = undefined;
			if (this.#connectAbort === connectAbort) this.#connectAbort = undefined;
		}
	}

	async reconnect(options?: HarnessMcpRequestOptions): Promise<HarnessMcpServerInfo> {
		await this.close();
		return this.connect(options);
	}

	async close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		const attempt = this.#close();
		this.#closePromise = attempt;
		try {
			await attempt;
		} finally {
			if (this.#closePromise === attempt) this.#closePromise = undefined;
		}
	}

	async listTools(options?: HarnessMcpRequestOptions): Promise<HarnessMcpToolIndex> {
		const tools = await this.#collectPages(options, (client, cursor, requestOptions) =>
			client.listTools(cursor === undefined ? undefined : { cursor }, requestOptions).then((page) => ({
				items: page.tools,
				nextCursor: page.nextCursor,
			})),
		);
		const sortedTools = sortTools(tools);
		const outputValidators = new Map<string, JsonSchemaValidator<unknown>>();
		try {
			for (const tool of sortedTools) {
				if (tool.outputSchema !== undefined) {
					outputValidators.set(tool.name, this.#jsonSchemaValidator.getValidator(tool.outputSchema));
				}
			}
		} catch {
			throw new HarnessMcpError("protocol");
		}
		this.#toolOutputValidators = outputValidators;
		const fingerprint = `sha256:${createHash("sha256").update(stableJson(sortedTools)).digest("hex")}`;
		return { tools: sortedTools, fingerprint };
	}
	async call(
		name: string,
		args?: Record<string, unknown>,
		options?: HarnessMcpRequestOptions,
	): Promise<HarnessMcpCallResult> {
		const outputValidator = this.#toolOutputValidators.get(name);
		return this.#request(async (client, requestOptions) => {
			const result = (await client.callTool(
				args === undefined ? { name } : { name, arguments: args },
				CallToolResultSchema,
				requestOptions,
			)) as HarnessMcpCallResult;
			if (outputValidator !== undefined) {
				if (!result.structuredContent && !result.isError) {
					throw new McpError(
						ErrorCode.InvalidRequest,
						`Tool ${name} has an output schema but did not return structured content`,
					);
				}
				if (result.structuredContent) {
					const validation = outputValidator(result.structuredContent);
					if (!validation.valid) {
						throw new McpError(
							ErrorCode.InvalidParams,
							`Structured content does not match the tool's output schema: ${validation.errorMessage}`,
						);
					}
				}
			}
			return result;
		}, options);
	}

	async listResources(options?: HarnessMcpRequestOptions): Promise<HarnessMcpResource[]> {
		return this.#collectPages(options, (client, cursor, requestOptions) =>
			client.listResources(cursor === undefined ? undefined : { cursor }, requestOptions).then((page) => ({
				items: page.resources,
				nextCursor: page.nextCursor,
			})),
		);
	}

	async listPrompts(options?: HarnessMcpRequestOptions): Promise<HarnessMcpPrompt[]> {
		return this.#collectPages(options, (client, cursor, requestOptions) =>
			client.listPrompts(cursor === undefined ? undefined : { cursor }, requestOptions).then((page) => ({
				items: page.prompts,
				nextCursor: page.nextCursor,
			})),
		);
	}

	async readResource(uri: string, options?: HarnessMcpRequestOptions): Promise<HarnessMcpReadResourceResult> {
		return this.#request((client, requestOptions) => client.readResource({ uri }, requestOptions), options);
	}

	async getPrompt(
		name: string,
		args?: Record<string, string>,
		options?: HarnessMcpRequestOptions,
	): Promise<HarnessMcpGetPromptResult> {
		return this.#request(
			(client, requestOptions) => client.getPrompt({ name, ...(args ? { arguments: args } : {}) }, requestOptions),
			options,
		);
	}

	async #connect(
		client: Client,
		transport: HarnessMcpTransportInstance,
		requestOptions: McpRequestOptions,
		signal: AbortSignal,
	): Promise<HarnessMcpServerInfo> {
		try {
			await client.connect(transport, requestOptions);
			if (this.#state !== "connecting") {
				await client.close();
				throw new HarnessMcpError("aborted");
			}
			this.#state = "connected";
			return this.#buildInfo(client);
		} catch (error) {
			await client.close().catch(() => undefined);
			if (this.#client === client) {
				this.#client = undefined;
				this.#transport = undefined;
				this.#toolOutputValidators.clear();
				if (this.#state !== "closing") this.#state = "disconnected";
			}
			throw normalizeFailure(error, signal, this.#usesOAuth());
		}
	}

	async #close(): Promise<void> {
		const pendingConnect = this.#connectPromise;
		this.#state = "closing";
		this.#connectAbort?.abort();
		if (pendingConnect) await pendingConnect.catch(() => undefined);

		const client = this.#client;
		const transport = this.#transport;
		this.#client = undefined;
		this.#transport = undefined;
		this.#toolOutputValidators.clear();
		try {
			if (transport instanceof StreamableHTTPClientTransport) await transport.terminateSession();
			await client?.close();
		} catch (error) {
			if (client) await client.close().catch(() => undefined);
			throw normalizeFailure(error, undefined, this.#usesOAuth());
		} finally {
			this.#state = "disconnected";
		}
	}

	#buildInfo(client: Client): HarnessMcpServerInfo {
		const serverVersion = client.getServerVersion();
		const serverCapabilities = client.getServerCapabilities();
		const instructions = client.getInstructions();
		return {
			transportType: this.#options.transport.type,
			...(serverVersion === undefined ? {} : { serverVersion }),
			...(serverCapabilities === undefined ? {} : { serverCapabilities }),
			...(instructions === undefined ? {} : { instructions }),
		};
	}

	#createTransport(): StdioClientTransport | StreamableHTTPClientTransport {
		const transport = this.#options.transport;
		if (transport.type === "stdio") {
			return new StdioClientTransport({
				command: transport.command,
				args: transport.args,
				cwd: transport.cwd,
				env: transport.env,
				stderr: transport.stderr ?? "ignore",
			});
		}

		let url: URL;
		try {
			url = transport.url instanceof URL ? new URL(transport.url.href) : new URL(transport.url);
		} catch {
			throw new HarnessMcpError("invalid-options");
		}
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
			throw new HarnessMcpError("invalid-options");
		}

		const usesOAuth = transport.authProvider !== undefined;
		const fetch = protectToolCallRetries(transport.fetch ?? globalThis.fetch.bind(globalThis), usesOAuth);
		return new StreamableHTTPClientTransport(url, {
			authProvider: transport.authProvider,
			requestInit: transport.requestInit,
			fetch,
		});
	}

	#usesOAuth(): boolean {
		return this.#options.transport.type === "streamable-http" && this.#options.transport.authProvider !== undefined;
	}

	async #request<T>(
		operation: (client: Client, options: McpRequestOptions) => Promise<T>,
		options?: HarnessMcpRequestOptions,
	): Promise<T> {
		if (this.#state !== "connected" || !this.#client) throw new HarnessMcpError("not-connected");
		const client = this.#client;
		try {
			return await operation(client, toMcpRequestOptions(options));
		} catch (error) {
			throw normalizeFailure(error, options?.signal, this.#usesOAuth());
		}
	}

	async #collectPages<T>(
		options: HarnessMcpRequestOptions | undefined,
		list: (
			client: Client,
			cursor: string | undefined,
			requestOptions: McpRequestOptions,
		) => Promise<{ items: T[]; nextCursor?: string }>,
	): Promise<T[]> {
		const items: T[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		while (true) {
			const page = await this.#request((client, requestOptions) => list(client, cursor, requestOptions), options);
			items.push(...page.items);
			if (page.nextCursor === undefined) return items;
			if (cursors.has(page.nextCursor)) throw new HarnessMcpError("protocol");
			cursors.add(page.nextCursor);
			cursor = page.nextCursor;
		}
	}
}
