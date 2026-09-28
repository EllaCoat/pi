import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { OpenAICodexUsageSnapshot } from "../../../core/openai-codex-usage.ts";
import { addUsageToTotals, createUsageTotals } from "../../../core/usage-totals.ts";
import { sessionApiEquivalentCost } from "../../../personal-harness/api-equivalent-cost.ts";
import { theme } from "../theme/theme.ts";
import { formatOpenAIUsage } from "./openai-usage.ts";

const apiCostFormatter = new Intl.NumberFormat("en-US", {
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
	useGrouping: false,
});

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private openAIUsage: OpenAICodexUsageSnapshot = { status: "idle" };

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}
	setOpenAIUsage(snapshot: OpenAICodexUsageSnapshot): void {
		this.openAIUsage = snapshot;
	}

	render(width: number): string[] {
		const displayWidth = Math.max(1, width);
		const state = this.session.state;
		const entries = this.session.sessionManager.getEntries();
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of entries) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent;
		const contextPercent =
			contextPercentValue === null || contextPercentValue === undefined ? "?" : `${contextPercentValue.toFixed(1)}%`;
		const filledBlocks =
			typeof contextPercentValue === "number" && Number.isFinite(contextPercentValue)
				? Math.round(Math.max(0, Math.min(100, contextPercentValue)) / 10)
				: 0;
		const bar = `${"█".repeat(filledBlocks)}${"░".repeat(10 - filledBlocks)}`;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextText = `Context ${contextPercent} ${bar} / ${formatTokens(contextWindow)}${autoIndicator}`;
		const contextRow =
			contextPercentValue !== null && contextPercentValue !== undefined && contextPercentValue > 90
				? theme.fg("error", contextText)
				: contextPercentValue !== null && contextPercentValue !== undefined && contextPercentValue > 70
					? theme.fg("warning", contextText)
					: contextText;

		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) pwd = `${pwd} / ${sessionName}`;

		const modelName = sanitizeStatusText(state.model?.id || "no-model");
		const modelDisplay =
			state.model && this.footerData.getAvailableProviderCount() > 1
				? `${sanitizeStatusText(state.model.provider)}/${modelName}`
				: modelName;
		const effort = sanitizeStatusText(state.thinkingLevel || "off");
		const cost = sessionApiEquivalentCost(entries);
		const unknownCost = cost.unknownCalls > 0 ? "+?" : "";
		const primaryLeft = `${modelDisplay} / ${effort} / API換算 ≈$${apiCostFormatter.format(cost.estimatedUsd)}${unknownCost}`;
		const primaryRows =
			visibleWidth(primaryLeft) + 2 + visibleWidth(contextRow) <= displayWidth
				? [
						primaryLeft +
							" ".repeat(displayWidth - visibleWidth(primaryLeft) - visibleWidth(contextRow)) +
							contextRow,
					]
				: [...wrapTextWithAnsi(primaryLeft, displayWidth), ...wrapTextWithAnsi(contextRow, displayWidth)];
		const lines = [...primaryRows];
		const openAIUsageText = formatOpenAIUsage(this.openAIUsage);
		if (openAIUsageText) lines.push(...wrapTextWithAnsi(openAIUsageText, displayWidth));

		const statsParts = [];
		if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
		if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
		if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
		if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}
		if (areExperimentalFeaturesEnabled()) statsParts.push(theme.bold(theme.fg("warning", "xp")));
		if (statsParts.length > 0) {
			lines.push(...wrapTextWithAnsi(statsParts.join(" / "), displayWidth).map((line) => theme.fg("dim", line)));
		}

		lines.push(truncateToWidth(theme.fg("dim", pwd), displayWidth, theme.fg("dim", "...")));

		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			lines.push(truncateToWidth(sortedStatuses.join(" "), displayWidth, theme.fg("dim", "...")));
		}

		return lines;
	}
}
