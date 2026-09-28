import { resolve, sep } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	helperUsage?: AssistantUsage;
	childCost?: { estimatedUsd: number; unknownCalls: number };
	usingSubscription?: boolean;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}
	if (options.helperUsage !== undefined) {
		entries.push({
			type: "usage",
			kind: "memory",
			provider: "test",
			model: "helper",
			usage: options.helperUsage,
		});
	}

	if (options.childCost !== undefined) {
		entries.push({
			type: "custom",
			customType: "personal-harness-child-result",
			data: { apiEquivalentCost: options.childCost },
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		const home = resolve("/home/user");
		const sibling = resolve("/home/user2");
		expect(formatCwdForFooter(sibling, home)).toBe(sibling);
	});

	it("abbreviates the home directory and descendants", () => {
		const home = resolve("/home/user");
		expect(formatCwdForFooter(home, home)).toBe("~");
		expect(formatCwdForFooter(resolve(home, "project"), home)).toBe(`~${sep}project`);
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("counts main and saved child costs while excluding summaries, compaction, tools, and helpers", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
			helperUsage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.75 },
			},
			childCost: { estimatedUsd: 0.25, unknownCalls: 0 },
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[0])).toContain("API換算 ≈$0.75");
	});

	it("shows an unknown marker instead of treating unknown child cost as free", () => {
		const session = createSession({
			sessionName: "",
			childCost: { estimatedUsd: 0, unknownCalls: 1 },
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[0])).toContain("API換算 ≈$0.00+?");
	});

	it("keeps the model, effort value, cost, context percent, and bar visible at 40, 80, and 120 columns", () => {
		const session = createSession({
			sessionName: "",
			modelId: "gpt-test",
			thinkingLevel: "high",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		for (const width of [40, 80, 120]) {
			const lines = footer.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const text = stripAnsi(lines.join(" "));
			expect(text).toContain("gpt-test");
			expect(text).toContain("gpt-test / high / API換算 ≈$0.13");
			expect(text).not.toContain("Effort");
			expect(text).toContain("API換算 ≈$0.13");
			expect(text).toContain("12.3%");
			expect(text).toContain("█");
		}
	});

	it.each([
		[0.1234, "0.12"],
		[0.125, "0.13"],
		[0.126, "0.13"],
		[0.145, "0.15"],
		[1.005, "1.01"],
		[1.015, "1.02"],
		[2.675, "2.68"],
	])("rounds API-equivalent cost %s to $%s without changing its source", (total, expected) => {
		const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total } };
		const session = createSession({ sessionName: "", usage });
		const text = stripAnsi(new FooterComponent(session, createFooterData(1)).render(120)[0]);
		expect(text).toContain(`API換算 ≈$${expected}`);
		expect(usage.cost.total).toBe(total);
	});

	it("uses slash separators for footer fields, session name, and the experimental marker", () => {
		const previousExperimental = process.env.PI_EXPERIMENTAL;
		process.env.PI_EXPERIMENTAL = "1";
		try {
			const session = createSession({
				sessionName: "named-session",
				usage: {
					input: 10,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { total: 0.5 },
				},
			});
			const footer = new FooterComponent(session, createFooterData(1));
			const lines = footer.render(120).map(stripAnsi);
			const statsLine = lines[1] ?? "";

			expect(lines[0]).toContain("test-model / off / API換算 ≈$0.50");
			expect(lines[0]).not.toContain("Effort");
			expect(statsLine).toBe("↑10 / ↓2 / xp");
			expect(statsLine).not.toContain("•");
			expect(lines.at(-1)).toMatch(/\(main\) \/ named-session$/u);
		} finally {
			if (previousExperimental === undefined) delete process.env.PI_EXPERIMENTAL;
			else process.env.PI_EXPERIMENTAL = previousExperimental;
		}
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("CH25.0%");
	});

	it("shows API-equivalent costs without calling them subscription charges", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.render(120)[0]);

		expect(stats).toContain("API換算 ≈$1.23");
		expect(stats).not.toContain("(sub)");
	});

	it("shows zero when no cost-bearing model messages exist", () => {
		const session = createSession({ sessionName: "", provider: "anthropic", usingSubscription: true });
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.render(120)[0]);

		expect(stats).toContain("API換算 ≈$0.00");
		expect(stats).not.toContain("(sub)");
	});

	it("does not label generic OAuth costs as subscription charges", () => {
		const session = createSession({
			sessionName: "",
			provider: "openrouter",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.render(120)[0]);

		expect(stats).toContain("API換算 ≈$1.23");
		expect(stats).not.toContain("(sub)");
	});
});
