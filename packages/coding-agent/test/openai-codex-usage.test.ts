import { Buffer } from "node:buffer";
import type { AuthResult } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import {
	type OpenAICodexUsageContext,
	OpenAICodexUsageController,
	parseOpenAICodexUsage,
} from "../src/core/openai-codex-usage.ts";

const FIVE_HOURS = 5 * 60 * 60;
const ONE_WEEK = 7 * 24 * 60 * 60;
const TOKEN_CLAIM = "https://api.openai.com/auth";
type UsageRuntime = ConstructorParameters<typeof OpenAICodexUsageController>[0];

function tokenForAccount(accountId: string): string {
	const payload = Buffer.from(JSON.stringify({ [TOKEN_CLAIM]: { chatgpt_account_id: accountId } })).toString(
		"base64url",
	);
	return `fixture.${payload}.signature`;
}

function quotaPayload(): Record<string, unknown> {
	return {
		rate_limit: {
			primary_window: { used_percent: 64, limit_window_seconds: ONE_WEEK },
			secondary_window: { used_percent: 37.5, limit_window_seconds: FIVE_HOURS },
		},
	};
}

function runtimeFor(readToken: () => string | undefined, isOAuth = true, hasCodexProvider = true): UsageRuntime {
	return {
		getProvider: vi.fn(() => (hasCodexProvider ? { id: "openai-codex" } : undefined)),
		isUsingOAuth: vi.fn(() => isOAuth),
		getAuth: vi.fn(async () => {
			const accessToken = readToken();
			return accessToken ? ({ auth: { apiKey: accessToken }, source: "OAuth" } satisfies AuthResult) : undefined;
		}),
	} as unknown as UsageRuntime;
}

function context(overrides: Partial<OpenAICodexUsageContext> = {}): OpenAICodexUsageContext {
	return {
		sessionId: "session-a",
		providerId: "openai-codex",
		modelId: "gpt-5-codex",
		...overrides,
	};
}

function response(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("parseOpenAICodexUsage", () => {
	test("maps five-hour and weekly windows by their actual durations", () => {
		expect(parseOpenAICodexUsage(quotaPayload())).toEqual({
			status: "ready",
			windows: {
				fiveHour: { remainingPercent: 62.5, windowSeconds: FIVE_HOURS },
				weekly: { remainingPercent: 36, windowSeconds: ONE_WEEK },
			},
		});
	});

	test("keeps absent five-hour windows hidden and distinguishes unsupported from malformed windows", () => {
		expect(
			parseOpenAICodexUsage({
				rate_limit: {
					primary_window: null,
					secondary_window: { used_percent: 10, limit_window_seconds: ONE_WEEK },
				},
			}),
		).toEqual({
			status: "ready",
			windows: { weekly: { remainingPercent: 90, windowSeconds: ONE_WEEK } },
		});
		expect(
			parseOpenAICodexUsage({
				rate_limit: { primary_window: { used_percent: null, limit_window_seconds: FIVE_HOURS } },
			}),
		).toEqual({ status: "invalid" });
		expect(
			parseOpenAICodexUsage({
				rate_limit: { primary_window: { used_percent: null, limit_window_seconds: 86_400 } },
			}),
		).toEqual({ status: "absent" });
		expect(parseOpenAICodexUsage({ rate_limit: [] })).toEqual({ status: "invalid" });
	});

	test("clamps reported usage to a valid remaining percentage", () => {
		expect(
			parseOpenAICodexUsage({
				rate_limit: { primary_window: { used_percent: 120, limit_window_seconds: FIVE_HOURS } },
			}),
		).toEqual({
			status: "ready",
			windows: { fiveHour: { remainingPercent: 0, windowSeconds: FIVE_HOURS } },
		});
	});
});

describe("OpenAICodexUsageController", () => {
	test("returns unsupported without auth work or network access when Codex is not registered", async () => {
		const runtime = runtimeFor(() => tokenForAccount("account-a"), true, false);
		const fetcher = vi.fn<typeof fetch>();
		const controller = new OpenAICodexUsageController(runtime, { fetcher });
		controller.setContext(context({ providerId: "anthropic" }));

		await controller.refresh();

		expect(controller.getSnapshot()).toEqual({ status: "unsupported" });
		expect(runtime.isUsingOAuth).not.toHaveBeenCalled();
		expect(runtime.getAuth).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	});

	test("distinguishes missing OAuth from a supported provider", async () => {
		const runtime = runtimeFor(() => tokenForAccount("account-a"), false);
		const fetcher = vi.fn<typeof fetch>();
		const controller = new OpenAICodexUsageController(runtime, { fetcher });
		controller.setContext(context());

		await controller.refresh();

		expect(controller.getSnapshot()).toEqual({ status: "no-auth" });
		expect(runtime.getAuth).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	});

	test("uses the fixed ChatGPT usage origin and keeps credentials out of snapshots", async () => {
		const accessToken = tokenForAccount("account-a");
		const runtime = runtimeFor(() => accessToken);
		let fetchCount = 0;
		let observedUrl = "";
		let observedInit: RequestInit | undefined;
		const fetcher: typeof fetch = async (input, init) => {
			fetchCount++;
			observedUrl = String(input);
			observedInit = init;
			return response(quotaPayload());
		};
		const controller = new OpenAICodexUsageController(runtime, { fetcher, now: () => 1234 });
		controller.setContext(context({ providerId: "anthropic", modelId: "claude-sonnet" }));

		const firstRefresh = controller.refresh();
		const repeatedRefresh = controller.refresh();
		expect(repeatedRefresh).toBe(firstRefresh);
		await firstRefresh;
		await controller.refresh();
		expect(fetchCount).toBe(1);

		expect(observedUrl).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(new Headers(observedInit?.headers).get("Authorization")).toBe(`Bearer ${accessToken}`);
		expect(new Headers(observedInit?.headers).get("ChatGPT-Account-Id")).toBe("account-a");
		expect(observedInit).toMatchObject({ credentials: "omit", redirect: "error", method: "GET" });
		expect(controller.getSnapshot()).toEqual({
			status: "ready",
			data: {
				fetchedAt: 1234,
				fiveHour: { remainingPercent: 62.5, windowSeconds: FIVE_HOURS },
				weekly: { remainingPercent: 36, windowSeconds: ONE_WEEK },
			},
		});
		expect(JSON.stringify(controller.getSnapshot())).not.toContain(accessToken);
	});

	test("treats a successful payload without either quota window as absent", async () => {
		const runtime = runtimeFor(() => tokenForAccount("account-a"));
		const controller = new OpenAICodexUsageController(runtime, {
			fetcher: async () => response({ rate_limit: null }),
			now: () => 5000,
		});
		controller.setContext(context());

		await controller.refresh();

		expect(controller.getSnapshot()).toEqual({ status: "absent", fetchedAt: 5000 });
	});

	test("treats a known window without usage percentage as a malformed response and preserves stale data", async () => {
		const runtime = runtimeFor(() => tokenForAccount("account-a"));
		let malformed = false;
		const fetcher: typeof fetch = async () =>
			response(
				malformed ? { rate_limit: { primary_window: { limit_window_seconds: FIVE_HOURS } } } : quotaPayload(),
			);
		const controller = new OpenAICodexUsageController(runtime, { fetcher });
		controller.setContext(context());
		await controller.refresh();
		const ready = controller.getSnapshot();
		expect(ready.status).toBe("ready");

		malformed = true;
		await controller.refresh({ force: true });

		expect(controller.getSnapshot()).toMatchObject({
			status: "error",
			reason: "response",
			stale: true,
			lastGood: ready.status === "ready" ? ready.data : undefined,
		});
	});

	test("retains same-account last good data as stale after a network failure", async () => {
		const accessToken = tokenForAccount("account-a");
		const runtime = runtimeFor(() => accessToken);
		let fail = false;
		let clock = 1000;
		const fetcher: typeof fetch = async () => {
			if (fail) throw new Error("fixture network failure");
			return response(quotaPayload());
		};
		const controller = new OpenAICodexUsageController(runtime, { fetcher, now: () => clock });
		controller.setContext(context());
		await controller.refresh();
		const ready = controller.getSnapshot();
		expect(ready.status).toBe("ready");

		clock = 2000;
		fail = true;
		await controller.refresh({ force: true });

		expect(controller.getSnapshot()).toMatchObject({
			status: "error",
			reason: "network",
			failedAt: 2000,
			stale: true,
			lastGood: ready.status === "ready" ? ready.data : undefined,
		});
		expect(JSON.stringify(controller.getSnapshot())).not.toContain(accessToken);
	});

	test("drops old account data before showing the new account's failed refresh", async () => {
		let accessToken = tokenForAccount("account-a");
		const runtime = runtimeFor(() => accessToken);
		const accountHeaders: string[] = [];
		const fetcher: typeof fetch = async (_input, init) => {
			accountHeaders.push(new Headers(init?.headers).get("ChatGPT-Account-Id") ?? "");
			if (accountHeaders.length > 1) throw new Error("fixture network failure");
			return response(quotaPayload());
		};
		const controller = new OpenAICodexUsageController(runtime, { fetcher });
		controller.setContext(context());
		await controller.refresh();
		accessToken = tokenForAccount("account-b");

		await controller.refresh({ force: true });

		expect(accountHeaders).toEqual(["account-a", "account-b"]);
		const snapshot = controller.getSnapshot();
		expect(snapshot).toMatchObject({ status: "error", reason: "network", stale: false });
		if (snapshot.status === "error") {
			expect(snapshot.lastGood).toBeUndefined();
		}
	});

	test("cancels a pending request and clears data on model/session changes", async () => {
		const runtime = runtimeFor(() => tokenForAccount("account-a"));
		let signal: AbortSignal | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const fetcher: typeof fetch = async (_input, init) => {
			signal = init?.signal ?? undefined;
			markStarted?.();
			return new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
			});
		};
		const controller = new OpenAICodexUsageController(runtime, { fetcher });
		controller.setContext(context());
		const pending = controller.refresh();
		await started;

		controller.setContext(context({ sessionId: "session-b", modelId: "another-model" }));
		await pending;

		expect(signal?.aborted).toBe(true);
		expect(controller.getSnapshot()).toEqual({ status: "idle" });
	});

	test("bounds a fetch that does not settle and reports a timeout", async () => {
		const runtime = runtimeFor(() => tokenForAccount("account-a"));
		const fetcher: typeof fetch = async () => new Promise<Response>(() => {});
		const controller = new OpenAICodexUsageController(runtime, { fetcher, timeoutMs: 10 });
		controller.setContext(context());

		await controller.refresh();

		expect(controller.getSnapshot()).toMatchObject({ status: "error", reason: "timeout", stale: false });
	});
});
