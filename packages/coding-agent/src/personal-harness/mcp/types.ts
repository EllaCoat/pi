import type { IOType } from "node:child_process";
import type { Stream } from "node:stream";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
	CallToolResult,
	GetPromptResult,
	Implementation,
	Prompt,
	ReadResourceResult,
	Resource,
	ServerCapabilities,
	Tool,
} from "@modelcontextprotocol/sdk/types.js";

export interface HarnessMcpStdioTransport {
	readonly type: "stdio";
	readonly command: string;
	readonly args?: string[];
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly stderr?: IOType | Stream | number;
}

export interface HarnessMcpStreamableHttpTransport {
	readonly type: "streamable-http";
	readonly url: string | URL;
	readonly requestInit?: RequestInit;
	readonly authProvider?: OAuthClientProvider;
	readonly fetch?: FetchLike;
}

export type HarnessMcpTransport = HarnessMcpStdioTransport | HarnessMcpStreamableHttpTransport;
export type HarnessMcpTransportType = HarnessMcpTransport["type"];

export interface HarnessMcpClientOptions {
	readonly transport: HarnessMcpTransport;
	readonly clientInfo?: Implementation;
}

export interface HarnessMcpRequestOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly maxTotalTimeoutMs?: number;
}

export interface HarnessMcpServerInfo {
	readonly transportType: HarnessMcpTransportType;
	readonly serverVersion?: Implementation;
	readonly serverCapabilities?: ServerCapabilities;
	readonly instructions?: string;
}

export type HarnessMcpTool = Tool;
export type HarnessMcpResource = Resource;
export type HarnessMcpPrompt = Prompt;
export type HarnessMcpCallResult = CallToolResult;
export type HarnessMcpReadResourceResult = ReadResourceResult;
export type HarnessMcpGetPromptResult = GetPromptResult;

export interface HarnessMcpToolIndex {
	readonly tools: readonly HarnessMcpTool[];
	readonly fingerprint: string;
}

export type HarnessMcpErrorKind =
	| "oauth-required"
	| "http-unauthorized"
	| "http-error"
	| "timeout"
	| "aborted"
	| "not-connected"
	| "invalid-state"
	| "invalid-options"
	| "transport"
	| "protocol";
