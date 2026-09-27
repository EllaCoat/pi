import { Buffer } from "node:buffer";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { raceWithAbortSignal } from "../utils/abort.ts";
import type { ModelRuntime } from "./model-runtime.ts";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";
const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;

const CodexUsageWindowSchema = Type.Object(
	{
		limit_window_seconds: Type.Optional(Type.Unknown()),
		used_percent: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: true },
);
const CodexRateLimitSchema = Type.Object(
	{
		primary_window: Type.Optional(Type.Union([CodexUsageWindowSchema, Type.Null()])),
		secondary_window: Type.Optional(Type.Union([CodexUsageWindowSchema, Type.Null()])),
	},
	{ additionalProperties: true },
);
const CodexUsagePayloadSchema = Type.Object(
	{
		rate_limit: Type.Optional(Type.Union([CodexRateLimitSchema, Type.Null()])),
	},
	{ additionalProperties: true },
);
const CodexJwtPayloadSchema = Type.Object(
	{
		[CODEX_AUTH_CLAIM]: Type.Optional(
			Type.Object({ chatgpt_account_id: Type.Optional(Type.String()) }, { additionalProperties: true }),
		),
	},
	{ additionalProperties: true },
);

type CodexUsageRuntime = Pick<ModelRuntime, "getProvider" | "isUsingOAuth" | "getAuth">;

export interface OpenAICodexUsageWindow {
	remainingPercent: number;
	windowSeconds: number;
}

export interface OpenAICodexUsageWindows {
	fiveHour?: OpenAICodexUsageWindow;
	weekly?: OpenAICodexUsageWindow;
}

export interface OpenAICodexUsageData extends OpenAICodexUsageWindows {
	fetchedAt: number;
}

export type OpenAICodexUsageParseResult =
	| { status: "ready"; windows: OpenAICodexUsageWindows }
	| { status: "absent" }
	| { status: "invalid" };

export type OpenAICodexUsageSnapshot =
	| { status: "idle" | "unsupported" | "no-auth" }
	| { status: "loading"; lastGood?: OpenAICodexUsageData }
	| { status: "absent"; fetchedAt: number }
	| { status: "ready"; data: OpenAICodexUsageData }
	| {
			status: "error";
			reason: "auth" | "invalid-auth" | "timeout" | "network" | "http" | "response";
			failedAt: number;
			httpStatus?: number;
			lastGood?: OpenAICodexUsageData;
			stale: boolean;
	  };

export interface OpenAICodexUsageContext {
	sessionId: string;
	providerId: string;
	modelId: string;
}

export interface OpenAICodexUsageControllerOptions {
	fetcher?: typeof fetch;
	now?: () => number;
	refreshIntervalMs?: number;
	timeoutMs?: number;
}

/** Reads windows by reported duration; malformed known windows are invalid. */
export function parseOpenAICodexUsage(payload: unknown): OpenAICodexUsageParseResult {
	if (!Check(CodexUsagePayloadSchema, payload)) return { status: "invalid" };
	const rateLimit = (payload as Static<typeof CodexUsagePayloadSchema>).rate_limit;
	if (!rateLimit) return { status: "absent" };

	let fiveHour: OpenAICodexUsageWindow | undefined;
	let weekly: OpenAICodexUsageWindow | undefined;
	for (const candidate of [rateLimit.primary_window, rateLimit.secondary_window]) {
		if (!candidate) continue;
		const duration = candidate.limit_window_seconds;
		if (typeof duration !== "number" || !Number.isFinite(duration)) return { status: "invalid" };
		if (duration !== FIVE_HOUR_WINDOW_SECONDS && duration !== WEEKLY_WINDOW_SECONDS) continue;

		const usedPercent = candidate.used_percent;
		if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return { status: "invalid" };
		const window: OpenAICodexUsageWindow = {
			remainingPercent: 100 - Math.min(100, Math.max(0, usedPercent)),
			windowSeconds: duration,
		};
		if (duration === FIVE_HOUR_WINDOW_SECONDS) fiveHour ??= window;
		else weekly ??= window;
	}

	if (!fiveHour && !weekly) return { status: "absent" };
	return {
		status: "ready",
		windows: { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) },
	};
}

/** Owns refresh timing and scope so rendering can remain a synchronous read. */
export class OpenAICodexUsageController {
	private readonly runtime: CodexUsageRuntime;
	private readonly fetcher: typeof fetch;
	private readonly now: () => number;
	private readonly refreshIntervalMs: number;
	private readonly timeoutMs: number;
	private context: OpenAICodexUsageContext | undefined;
	private contextKey: string | undefined;
	private accountId: string | undefined;
	private lastGood: OpenAICodexUsageData | undefined;
	private lastAttemptAt: number | undefined;
	private snapshot: OpenAICodexUsageSnapshot = { status: "idle" };
	private attempt: { generation: number; controller: AbortController; promise: Promise<void> } | undefined;
	private generation = 0;
	private disposed = false;

	constructor(runtime: CodexUsageRuntime, options: OpenAICodexUsageControllerOptions = {}) {
		this.runtime = runtime;
		this.fetcher = options.fetcher ?? fetch;
		this.now = options.now ?? Date.now;
		this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Switching session/provider/model clears cached data and cancels an older request. */
	setContext(context: OpenAICodexUsageContext): void {
		if (this.disposed) return;
		const contextKey = JSON.stringify([context.sessionId, context.providerId, context.modelId]);
		if (contextKey === this.contextKey) return;

		this.cancelAttempt();
		this.generation++;
		this.context = context;
		this.contextKey = contextKey;
		this.accountId = undefined;
		this.lastGood = undefined;
		this.lastAttemptAt = undefined;
		this.snapshot = this.runtime.getProvider(OPENAI_CODEX_PROVIDER) ? { status: "idle" } : { status: "unsupported" };
	}

	/** Clear usage after an auth change without changing the active session/model. */
	invalidate(): void {
		if (this.disposed) return;
		this.cancelAttempt();
		this.generation++;
		this.accountId = undefined;
		this.lastGood = undefined;
		this.lastAttemptAt = undefined;
		this.snapshot =
			this.context && this.runtime.getProvider(OPENAI_CODEX_PROVIDER)
				? { status: "idle" }
				: { status: "unsupported" };
	}

	getSnapshot(): OpenAICodexUsageSnapshot {
		return this.snapshot;
	}

	/** Refresh on lifecycle/timer events, not from the footer's render path. */
	refresh(options: { force?: boolean } = {}): Promise<void> {
		const context = this.context;
		if (this.disposed || !context) return Promise.resolve();
		if (!this.runtime.getProvider(OPENAI_CODEX_PROVIDER)) {
			this.invalidate();
			return Promise.resolve();
		}
		if (this.attempt) return this.attempt.promise;

		const startedAt = this.now();
		if (
			!options.force &&
			this.lastAttemptAt !== undefined &&
			startedAt - this.lastAttemptAt < this.refreshIntervalMs
		) {
			return Promise.resolve();
		}

		this.lastAttemptAt = startedAt;
		const generation = this.generation;
		const controller = new AbortController();
		const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
		const signal = AbortSignal.any([controller.signal, timeoutSignal]);
		this.snapshot = { status: "loading", ...(this.lastGood ? { lastGood: this.lastGood } : {}) };

		const promise = Promise.resolve()
			.then(() => this.runRefresh(generation, controller, signal, timeoutSignal))
			.finally(() => {
				if (this.attempt?.generation === generation) this.attempt = undefined;
			});
		this.attempt = { generation, controller, promise };
		return promise;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelAttempt();
		this.generation++;
		this.context = undefined;
		this.contextKey = undefined;
		this.accountId = undefined;
		this.lastGood = undefined;
		this.lastAttemptAt = undefined;
		this.snapshot = { status: "idle" };
	}

	private async runRefresh(
		generation: number,
		controller: AbortController,
		signal: AbortSignal,
		timeoutSignal: AbortSignal,
	): Promise<void> {
		if (!this.isCurrent(generation, controller)) return;
		let stage: "auth" | "fetch" | "response" = "auth";
		try {
			if (!this.runtime.getProvider(OPENAI_CODEX_PROVIDER)) {
				this.clearAccountData();
				this.commit(generation, controller, { status: "unsupported" });
				return;
			}
			if (!this.runtime.isUsingOAuth(OPENAI_CODEX_PROVIDER)) {
				this.clearAccountData();
				this.commit(generation, controller, { status: "no-auth" });
				return;
			}

			const auth = await raceWithAbortSignal(this.runtime.getAuth(OPENAI_CODEX_PROVIDER, { signal }), signal);
			if (!this.isCurrent(generation, controller)) return;
			const accessToken = auth?.auth.apiKey;
			if (!accessToken) {
				this.clearAccountData();
				this.commit(generation, controller, { status: "no-auth" });
				return;
			}

			const accountId = extractAccountId(accessToken);
			if (!accountId) {
				this.clearAccountData();
				this.commitError(generation, controller, "invalid-auth");
				return;
			}
			if (this.accountId !== undefined && this.accountId !== accountId) this.lastGood = undefined;
			this.accountId = accountId;
			if (!this.lastGood) this.snapshot = { status: "loading" };

			stage = "fetch";
			const response = await raceWithAbortSignal(
				this.fetcher(CODEX_USAGE_URL, {
					method: "GET",
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${accessToken}`,
						"ChatGPT-Account-Id": accountId,
					},
					credentials: "omit",
					redirect: "error",
					signal,
				}),
				signal,
			);
			if (!this.isCurrent(generation, controller)) return;
			if (!response.ok) {
				this.commitError(generation, controller, "http", response.status);
				return;
			}

			stage = "response";
			const payload: unknown = await raceWithAbortSignal(response.json(), signal);
			if (!this.isCurrent(generation, controller)) return;
			const parsed = parseOpenAICodexUsage(payload);
			if (parsed.status === "invalid") {
				this.commitError(generation, controller, "response");
				return;
			}
			if (parsed.status === "absent") {
				this.lastGood = undefined;
				this.commit(generation, controller, { status: "absent", fetchedAt: this.now() });
				return;
			}

			const data: OpenAICodexUsageData = { ...parsed.windows, fetchedAt: this.now() };
			this.lastGood = data;
			this.commit(generation, controller, { status: "ready", data });
		} catch {
			if (!this.isCurrent(generation, controller) || controller.signal.aborted) return;
			if (timeoutSignal.aborted) {
				this.commitError(generation, controller, "timeout");
			} else if (stage === "auth") {
				this.commitError(generation, controller, "auth");
			} else if (stage === "fetch") {
				this.commitError(generation, controller, "network");
			} else {
				this.commitError(generation, controller, "response");
			}
		}
	}

	private clearAccountData(): void {
		this.accountId = undefined;
		this.lastGood = undefined;
	}

	private isCurrent(generation: number, controller: AbortController): boolean {
		return !this.disposed && this.generation === generation && this.attempt?.controller === controller;
	}

	private commit(generation: number, controller: AbortController, snapshot: OpenAICodexUsageSnapshot): void {
		if (this.isCurrent(generation, controller)) this.snapshot = snapshot;
	}

	private commitError(
		generation: number,
		controller: AbortController,
		reason: Extract<OpenAICodexUsageSnapshot, { status: "error" }>["reason"],
		httpStatus?: number,
	): void {
		if (!this.isCurrent(generation, controller)) return;
		this.snapshot = {
			status: "error",
			reason,
			failedAt: this.now(),
			...(httpStatus === undefined ? {} : { httpStatus }),
			...(this.lastGood ? { lastGood: this.lastGood } : {}),
			stale: this.lastGood !== undefined,
		};
	}

	private cancelAttempt(): void {
		this.attempt?.controller.abort();
		this.attempt = undefined;
	}
}

function extractAccountId(accessToken: string): string | undefined {
	const payloadPart = accessToken.split(".")[1];
	if (!payloadPart) return undefined;
	try {
		const payload: unknown = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
		if (!Check(CodexJwtPayloadSchema, payload)) return undefined;
		const accountId = (payload as Static<typeof CodexJwtPayloadSchema>)[CODEX_AUTH_CLAIM]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
	} catch {
		return undefined;
	}
}
