import { describe, expect, it } from "vitest";
import type { OpenAICodexUsageData } from "../src/core/openai-codex-usage.ts";
import { formatOpenAIUsage } from "../src/modes/interactive/components/openai-usage.ts";

const data: OpenAICodexUsageData = {
	fetchedAt: 1_000,
	fiveHour: { remainingPercent: 82, windowSeconds: 18_000 },
	weekly: { remainingPercent: 64, windowSeconds: 604_800 },
};

describe("OpenAI account allowance display", () => {
	it("shows remaining percentages with explicit account labels", () => {
		expect(formatOpenAIUsage({ status: "ready", data })).toBe("OpenAI 残り: 5h 82% / 週間 64%");
	});

	it("omits the five-hour label when that window does not exist", () => {
		expect(formatOpenAIUsage({ status: "ready", data: { fetchedAt: 1_000, weekly: data.weekly } })).toBe(
			"OpenAI 残り: 週間 64%",
		);
	});

	it("keeps zero remaining visible instead of treating it as an absent window", () => {
		expect(
			formatOpenAIUsage({
				status: "ready",
				data: { fetchedAt: 1_000, fiveHour: { remainingPercent: 0, windowSeconds: 18_000 } },
			}),
		).toBe("OpenAI 残り: 5h 0%");
	});

	it.each(["idle", "unsupported", "no-auth", "absent"] as const)(
		"hides genuinely unavailable allowance (%s)",
		(status) => {
			expect(formatOpenAIUsage(status === "absent" ? { status, fetchedAt: 1_000 } : { status })).toBeUndefined();
		},
	);

	it("distinguishes fetching and failure from full allowance", () => {
		expect(formatOpenAIUsage({ status: "loading" })).toBe("OpenAI 残り: 取得中");
		expect(formatOpenAIUsage({ status: "error", reason: "network", failedAt: 2_000, stale: false })).toBe(
			"OpenAI 残り: 取得不可",
		);
	});

	it("labels last-good values both while refreshing and after failure", () => {
		expect(formatOpenAIUsage({ status: "loading", lastGood: data })).toBe(
			"OpenAI 残り: 5h 82% / 週間 64% (更新中・前回値)",
		);
		expect(
			formatOpenAIUsage({ status: "error", reason: "timeout", failedAt: 2_000, lastGood: data, stale: true }),
		).toBe("OpenAI 残り: 5h 82% / 週間 64% (更新失敗・前回値)");
	});
});
