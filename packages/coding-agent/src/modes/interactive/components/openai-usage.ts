import type { OpenAICodexUsageData, OpenAICodexUsageSnapshot } from "../../../core/openai-codex-usage.ts";

function formatWindows(data: OpenAICodexUsageData): string {
	const windows: string[] = [];
	if (data.fiveHour) windows.push(`5h ${Math.round(data.fiveHour.remainingPercent)}%`);
	if (data.weekly) windows.push(`週間 ${Math.round(data.weekly.remainingPercent)}%`);
	return windows.join(" / ");
}

/** Account allowance is separate from session API-equivalent cost. */
export function formatOpenAIUsage(snapshot: OpenAICodexUsageSnapshot): string | undefined {
	switch (snapshot.status) {
		case "idle":
		case "unsupported":
		case "no-auth":
		case "absent":
			return undefined;
		case "loading":
			return snapshot.lastGood
				? `OpenAI 残り: ${formatWindows(snapshot.lastGood)} (更新中・前回値)`
				: "OpenAI 残り: 取得中";
		case "ready":
			return `OpenAI 残り: ${formatWindows(snapshot.data)}`;
		case "error":
			return snapshot.lastGood
				? `OpenAI 残り: ${formatWindows(snapshot.lastGood)} (更新失敗・前回値)`
				: "OpenAI 残り: 取得不可";
	}
}
