import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HarnessModelSelection } from "../model-call.ts";
import type { HarnessUsageLedger } from "../usage.ts";
import { installModelCompactionHook } from "./compaction.ts";
import {
	applyContextProjection,
	applyLegacyContextProjection,
	CONTEXT_PRUNE_ENTRY,
	type ContextCandidate,
	collectContextCandidates,
	contextTargetsFromBranch,
	evaluateContextCandidates,
	legacyProjection,
	type ThinkingReplayCompatibility,
} from "./context-prune.ts";
import {
	type AdviceResult,
	adviceText,
	buildAdviceContext,
	DEFAULT_DEADLINE_MS,
	DEFAULT_HISTORY_TURNS,
	evaluateAdvice,
	INPUT_SOURCE_ENTRY,
} from "./input-advice.ts";
import { isRecord, type JevEvaluator } from "./jev-types.ts";
import {
	collectRead,
	guidanceText,
	MESSAGE_TYPE,
	PRESERVE_KEY,
	READ_ENTRY,
	type ReadObservationEvent,
	type ReadRanking,
	rankCandidates,
} from "./reread.ts";
export type ChildSystemPromptOptions = Pick<
	BuildSystemPromptOptions,
	"appendSystemPrompt" | "promptGuidelines" | "sections"
>;

export interface HarnessHookOptions {
	evaluate: JevEvaluator;
	hold: () => () => void;
	ledger: HarnessUsageLedger;
	childSystemPromptOptions?: ChildSystemPromptOptions;
	dynamicTurnContext?: (now: Date, context: ExtensionContext) => string;
	lifecycleContext?: (
		event: "session_start" | "session_compact",
		context: ExtensionContext,
	) => string | undefined | Promise<string | undefined>;
	timeZone?: string;
	makeGoalSkillPath?: string;
	additionalReadRoots?: readonly string[];
	compactModel?: HarnessModelSelection;
}

const VERIFIED_THINKING_PRUNE_COMPATIBILITY: readonly ThinkingReplayCompatibility[] = [
	{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-luna" },
	{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-sol" },
	{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-astra" },
];

function projectionEntryIds(projection: {
	entries: readonly { sourceEntry: { id: string }; messages: readonly unknown[] }[];
	messages: readonly unknown[];
}): string[] | undefined {
	const entryIds: string[] = [];
	let index = 0;
	for (const entry of projection.entries) {
		for (const message of entry.messages) {
			if (projection.messages[index] !== message) return undefined;
			entryIds.push(entry.sourceEntry.id);
			index++;
		}
	}
	return index === projection.messages.length ? entryIds : undefined;
}

function thinkingDestination(model: ExtensionContext["model"]): ThinkingReplayCompatibility | undefined {
	return model ? { api: model.api, provider: model.provider, model: model.id } : undefined;
}

function snapshotHash(value: unknown): string | undefined {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string" ? createHash("sha256").update(serialized).digest("hex") : undefined;
	} catch {
		return undefined;
	}
}

function sameMessages(left: readonly unknown[], right: readonly unknown[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((message, index) => snapshotHash(message) === snapshotHash(right[index]));
}

function targetReference(candidate: ContextCandidate): Record<string, unknown> {
	return {
		id: candidate.id,
		entryId: candidate.entryId,
		role: candidate.role,
		blockIndex: candidate.blockIndex,
		fingerprint: candidate.fingerprint,
		kind: candidate.kind,
		start: candidate.start,
		end: candidate.end,
	};
}

interface PendingInput {
	text: string;
	sessionId: string;
	images: boolean;
}

interface ActiveAdvice {
	key: string;
	sessionId: string;
	leafId: string | null;
	prompt: string;
	rawInputText: string;

	controller: AbortController;
	userEntryId?: string;
	result: Promise<string>;
}

function isChildSession(context: ExtensionContext): boolean {
	return Boolean(context.sessionManager.getHeader()?.parentSession);
}

function onSessionNavigation(pi: ExtensionAPI, handler: () => void): void {
	pi.on("session_start", handler);
	pi.on("session_before_switch", handler);
	pi.on("session_before_fork", handler);
	pi.on("session_before_tree", handler);
	pi.on("session_tree", handler);
	pi.on("session_shutdown", handler);
	pi.on("session_abort", handler);
}

function formatTurnContext(now: Date, timeZone: string): string {
	try {
		const stamp = new Intl.DateTimeFormat("sv-SE", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		}).format(now);
		return `[Current time] ${stamp} ${timeZone}`;
	} catch {
		return `[Current time] ${now.toISOString()}`;
	}
}

function appendFixedChildPrompt(
	event: { systemPromptOptions: BuildSystemPromptOptions },
	fixed?: ChildSystemPromptOptions,
): void {
	if (!fixed) return;
	if (fixed.appendSystemPrompt?.trim()) {
		const additions = fixed.appendSystemPrompt.trim();
		const current = event.systemPromptOptions.appendSystemPrompt ?? "";
		if (!current.includes(additions))
			event.systemPromptOptions.appendSystemPrompt = current ? `${current}\n\n${additions}` : additions;
	}
	if (fixed.promptGuidelines?.length) {
		event.systemPromptOptions.promptGuidelines = [
			...new Set([...(event.systemPromptOptions.promptGuidelines ?? []), ...fixed.promptGuidelines]),
		];
	}
	if (fixed.sections)
		event.systemPromptOptions.sections = { ...(event.systemPromptOptions.sections ?? {}), ...fixed.sections };
}

function installContinuity(pi: ExtensionAPI, options: HarnessHookOptions): void {
	const injectContext = async (
		event: "session_start" | "session_compact",
		context: ExtensionContext,
	): Promise<void> => {
		const content = await options.lifecycleContext?.(event, context);
		if (content?.trim())
			pi.sendMessage(
				{ customType: "personal-harness-lifecycle-context", content, display: false },
				{ triggerTurn: false },
			);
	};
	pi.on("session_start", (_event, context) => injectContext("session_start", context));
	pi.on("session_compact", (_event, context) => injectContext("session_compact", context));

	pi.registerCommand("make-goal", {
		description: "Goalの起草を開始する。本文の承認前にはGoalを作成しない。",
		handler: async (args, context) => {
			if (isChildSession(context)) {
				context.ui.notify("Goalの起草・開始はMainが担当します。", "warning");
				return;
			}
			if (!pi.getAllTools().some((tool) => tool.name === "goal")) {
				context.ui.notify("Goal toolが登録されていません。Goal機能の設定を確認してください。", "warning");
				return;
			}
			if (!options.makeGoalSkillPath) {
				context.ui.notify("make-goal skillのruntime pathが設定されていないため、起草しません。", "warning");
				return;
			}
			let skill: string;
			try {
				skill = await readFile(options.makeGoalSkillPath, "utf8");
			} catch {
				context.ui.notify("make-goal skillを読み込めないため、起草しません。", "warning");
				return;
			}
			const active = pi.getActiveTools();
			if (!active.includes("goal")) pi.setActiveTools([...active, "goal"]);
			pi.sendUserMessage(
				`利用者がmake-goalを明示的に呼び出した。Goalを起草し、本文の開始承認を得るまで作成しない。\n\n${skill}\n\n利用者の指定:\n${args || "現在の会話から主題を確認する"}`,
				{ expandPromptTemplates: false },
			);
		},
	});

	pi.on("before_agent_start", (event, context) => {
		if (isChildSession(context)) appendFixedChildPrompt(event, options.childSystemPromptOptions);
		const now = new Date();
		const content = options.dynamicTurnContext?.(now, context) ?? formatTurnContext(now, options.timeZone ?? "UTC");
		if (!content.trim()) return;
		return { message: { customType: "personal-harness-turn-context", content, display: false } };
	});
}

function installInputAdvice(pi: ExtensionAPI, options: HarnessHookOptions): void {
	let enabled = true;
	let pending: PendingInput[] = [];
	let active: ActiveAdvice | undefined;
	let lastStatus = "not-run";

	const cancelPending = (nextStatus: string): void => {
		active?.controller.abort();
		active = undefined;
		pending = [];
		lastStatus = nextStatus;
	};

	pi.registerCommand("jev-input", {
		description: "Jev入力補助をon/off/statusで切り替えます。",
		handler: async (args, context) => {
			const command = args.trim();
			if (command === "off" || command === "on") {
				enabled = command === "on";
				cancelPending(enabled ? "not-run" : "disabled");
			} else if (command && command !== "status") {
				context.ui.notify("使い方: /jev-input on | off | status", "warning");
				return;
			}
			context.ui.notify(
				`Jev入力補助: ${enabled ? "on" : "off"} / 過去${DEFAULT_HISTORY_TURNS}往復 / 上限${DEFAULT_DEADLINE_MS}ms / 前回${lastStatus}`,
				"info",
			);
		},
	});

	pi.on("input", (event, context) => {
		if (!enabled || (event.source !== "interactive" && event.source !== "rpc") || isChildSession(context)) return;
		if (event.text.length > 65_536) {
			lastStatus = "too-large";
			return;
		}
		pending.push({
			text: event.text,
			sessionId: context.sessionManager.getSessionId(),
			images: Boolean(event.images?.length),
		});
		pending = pending.slice(-10);
	});

	pi.on("before_agent_start", async (event, context) => {
		if (!enabled || isChildSession(context)) return;
		const sessionId = context.sessionManager.getSessionId();
		const entries = context.sessionManager.getBranch();
		const leafId = context.sessionManager.getLeafId();
		const inputText = event.inputText ?? event.prompt;
		const key = createHash("sha256")
			.update(JSON.stringify([sessionId, leafId, inputText, event.prompt]))
			.digest("hex");
		if (active?.key !== key) {
			active?.controller.abort();
			active = undefined;
			pending = pending.filter((input) => input.sessionId === sessionId);
			let consumed = -1;
			for (let end = 1; end <= pending.length; end++) {
				if (
					pending
						.slice(0, end)
						.map((input) => input.text)
						.join("\n\n") === inputText
				) {
					consumed = end;
					break;
				}
			}
			if (consumed < 0) {
				const index = pending.findLastIndex((input) => input.text === inputText);
				if (index >= 0) {
					pending = pending.slice(index);
					consumed = 1;
				}
			}
			if (consumed < 0) {
				pending = [];
				lastStatus = "unmatched-input";
				return;
			}
			const inputs = pending.splice(0, consumed);
			const rawUserInputs = new Map<string, string>();
			for (const entry of entries) {
				if (
					entry.type === "custom" &&
					entry.customType === INPUT_SOURCE_ENTRY &&
					isRecord(entry.data) &&
					typeof entry.data.userEntryId === "string" &&
					typeof entry.data.rawInputText === "string"
				)
					rawUserInputs.set(entry.data.userEntryId, entry.data.rawInputText);
			}
			const prepared = buildAdviceContext(
				entries,
				inputs.map((input) => input.text).join("\n\n"),
				DEFAULT_HISTORY_TURNS,
				inputs.some((input) => input.images),
				rawUserInputs,
			);
			if (prepared.status !== "ready") {
				lastStatus = prepared.status;
				return;
			}
			const controller = new AbortController();
			const omitted =
				prepared.context.omittedHistory ||
				prepared.context.latest.omitted ||
				prepared.context.history.some((turn) => turn.user.omitted || turn.assistant?.omitted);
			const result = evaluateAdvice(prepared.input, options.evaluate, controller.signal, DEFAULT_DEADLINE_MS).then(
				(evaluation: AdviceResult) => {
					if (!controller.signal.aborted)
						lastStatus = `${evaluation.status} ${Math.round(evaluation.elapsedMs)}ms ${prepared.requestBytes}B`;
					return adviceText(evaluation, prepared.context.history.length, omitted);
				},
			);
			active = {
				key,
				sessionId,
				leafId,
				prompt: event.prompt,
				rawInputText: prepared.context.latest.text,
				controller,
				result,
			};
		}
		const request = active;
		if (!request) return;
		try {
			const guidance = await request.result;
			if (
				active !== request ||
				request.controller.signal.aborted ||
				context.sessionManager.getSessionId() !== sessionId
			)
				return;
			return { message: { customType: "jev-input-advice-v1", content: guidance, display: false } };
		} catch {
			if (active === request) {
				active = undefined;
				request.controller.abort();
			}
			lastStatus = "unavailable";
		}
	});

	pi.on("message_persisted", (event, context) => {
		const request = active;
		if (!request || request.userEntryId || request.controller.signal.aborted || event.message.role !== "user") return;
		if (context.sessionManager.getSessionId() !== request.sessionId) return;
		const entries = context.sessionManager.getBranch();
		const sourceIndex = request.leafId === null ? -1 : entries.findIndex((entry) => entry.id === request.leafId);
		if (request.leafId !== null && sourceIndex < 0) return;
		const persistedIndex = entries.findIndex((entry) => entry.id === event.entryId);
		const persisted = entries[persistedIndex];
		if (persistedIndex <= sourceIndex || persisted?.type !== "message" || persisted.message.role !== "user") return;
		const text =
			typeof event.message.content === "string"
				? event.message.content
				: event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		if (text !== request.prompt && !text.startsWith(`${request.prompt}\n\n`)) return;
		pi.appendEntry(INPUT_SOURCE_ENTRY, { userEntryId: event.entryId, rawInputText: request.rawInputText });
		request.userEntryId = event.entryId;
	});

	pi.on("agent_end", () => {
		const completed = active;
		active = undefined;
		completed?.controller.abort();
	});

	onSessionNavigation(pi, () => cancelPending(enabled ? "not-run" : "disabled"));
	pi.on("session_compact", () => cancelPending(enabled ? "not-run" : "disabled"));
	pi.on("session_compact_failed", () => cancelPending(enabled ? "not-run" : "disabled"));
}

function installJevCompact(pi: ExtensionAPI, options: HarnessHookOptions): void {
	let active: AbortController | undefined;
	const cancelActive = (): void => {
		active?.abort();
		active = undefined;
	};

	pi.on("context", (event, context) => {
		const entries = context.sessionManager.getBranch();
		const targets = contextTargetsFromBranch(entries);
		const projected = legacyProjection(event.messages, entries);
		const legacyPruned = applyLegacyContextProjection(projected, targets);
		const projection = context.sessionManager.buildSessionProjection();
		const entryIds = projectionEntryIds(projection);
		if (!entryIds) return { messages: legacyPruned };
		const visibleIndexes = projection.messages.flatMap((message, index) =>
			isRecord(message) && String(message.role) === "system" ? [] : [index],
		);
		const visibleMessages = visibleIndexes.map((index) => projection.messages[index]!);
		const visibleEntryIds = visibleIndexes.map((index) => entryIds[index]);
		const expected = legacyProjection(visibleMessages, entries);
		if (!sameMessages(projected, expected)) return { messages: legacyPruned };
		return {
			messages: applyContextProjection(
				projected,
				visibleEntryIds,
				targets,
				thinkingDestination(context.model),
				VERIFIED_THINKING_PRUNE_COMPATIBILITY,
			),
		};
	});

	onSessionNavigation(pi, cancelActive);
	pi.on("session_before_compact", cancelActive);
	pi.on("session_compact", cancelActive);
	pi.on("session_compact_failed", cancelActive);
	pi.registerCommand("jev-compact", {
		description: "Jevが明示表示された履歴範囲を判定し、省略範囲を通常送信へ固定します。",
		handler: async (args, context) => {
			if (args.trim()) {
				context.ui.notify("/jev-compact は引数不要です。", "warning");
				return;
			}
			if (!context.isIdle() || context.hasPendingMessages()) {
				context.ui.notify("処理中または送信待ちのため変更しません。", "warning");
				return;
			}
			if (active) {
				context.ui.notify("別の/jev-compact評価が進行中です。履歴は変更しません。", "warning");
				return;
			}
			const sessionId = context.sessionManager.getSessionId();
			const leafId = context.sessionManager.getLeafId();
			const entries = context.sessionManager.getBranch();
			const projection = context.sessionManager.buildSessionProjection();
			const entryIds = projectionEntryIds(projection);
			if (!entryIds) {
				context.ui.notify("履歴の発言元を確認できないため、Jevへ送らず保持します。", "warning");
				return;
			}
			const previousTargets = contextTargetsFromBranch(entries);
			const messages = legacyProjection(projection.messages, entries);
			const destination = thinkingDestination(context.model);
			const gathered = collectContextCandidates(
				messages,
				entryIds,
				previousTargets,
				VERIFIED_THINKING_PRUNE_COMPATIBILITY,
				destination,
			);
			if (!gathered.candidates.length) {
				context.ui.notify(`判定候補なし。Jev呼出しなし、保護${gathered.protected}範囲を保持します。`, "info");
				return;
			}
			const branchHash = snapshotHash(entries);
			const projectionHash = snapshotHash(messages);
			const scopeHash = snapshotHash(gathered.candidates.map(targetReference));
			if (!branchHash || !projectionHash || !scopeHash) {
				context.ui.notify("判定前の履歴・範囲hashを確定できないため、Jevへ送らず保持します。", "warning");
				return;
			}
			const controller = new AbortController();
			active = controller;
			let release: (() => void) | undefined;
			try {
				release = options.hold();
				const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
				const decision = await evaluateContextCandidates(
					messages,
					entryIds,
					gathered.candidates,
					options.evaluate,
					signal,
					previousTargets,
					destination,
					VERIFIED_THINKING_PRUNE_COMPATIBILITY,
				);
				const currentEntries = context.sessionManager.getBranch();
				const currentProjection = context.sessionManager.buildSessionProjection();
				const currentEntryIds = projectionEntryIds(currentProjection);
				const currentMessages =
					currentEntryIds === undefined ? [] : legacyProjection(currentProjection.messages, currentEntries);
				const currentCandidates =
					currentEntryIds === undefined
						? []
						: collectContextCandidates(
								currentMessages,
								currentEntryIds,
								contextTargetsFromBranch(currentEntries),
								VERIFIED_THINKING_PRUNE_COMPATIBILITY,
								thinkingDestination(context.model),
							).candidates;
				const sameSnapshot =
					context.sessionManager.getSessionId() === sessionId &&
					context.sessionManager.getLeafId() === leafId &&
					snapshotHash(currentEntries) === branchHash &&
					snapshotHash(currentMessages) === projectionHash &&
					snapshotHash(currentCandidates.map(targetReference)) === scopeHash &&
					context.isIdle() &&
					!context.hasPendingMessages();
				if (signal.aborted || !sameSnapshot) {
					context.ui.notify(
						"評価中にsession・branch・候補hashまたは操作状態が変わったため、結果を適用しませんでした。",
						"warning",
					);
					return;
				}
				const targets = decision.selected.map(({ entryId, role, blockIndex, fingerprint, kind, start, end }) => ({
					entryId,
					role,
					blockIndex,
					fingerprint,
					kind,
					start,
					end,
				}));
				const firstUnjudged = gathered.candidates[decision.unjudgedFrom];
				const lastUnjudged = gathered.candidates[decision.unjudgedFrom + decision.unjudgedCount - 1];
				pi.appendEntry(CONTEXT_PRUNE_ENTRY, {
					version: 2,
					sessionId,
					sourceLeafId: leafId,
					branchHash,
					projectionHash,
					scopeHash,
					targets,
					assessment: {
						candidateCount: gathered.candidates.length,
						protectedCount: gathered.protected,
						evaluated: decision.evaluated,
						kept: decision.kept,
						omitted: targets.length,
						uncertain: decision.uncertain,
						unjudged: {
							from: decision.unjudgedFrom,
							count: decision.unjudgedCount,
							firstCandidateId: firstUnjudged?.id ?? null,
							lastCandidateId: lastUnjudged?.id ?? null,
						},
						usage: {
							calls: decision.calls,
							inputTokens: decision.inputTokens,
							outputTokens: decision.outputTokens,
							requestBytes: decision.requestBytes,
						},
					},
				});
				const unjudgedText = decision.unjudgedCount
					? `; 未判定範囲 ${decision.unjudgedFrom + 1}-${decision.unjudgedFrom + decision.unjudgedCount} (${firstUnjudged?.id ?? "不明"}…${lastUnjudged?.id ?? "不明"})`
					: "; 未判定範囲なし";
				context.ui.notify(
					`候補${gathered.candidates.length}・保護${gathered.protected}。Jev: 保持${decision.kept}、省略${targets.length}、判断不足${decision.uncertain}、未判定${decision.unjudgedCount}${unjudgedText}。${decision.calls}回、入力${decision.inputTokens}/出力${decision.outputTokens} tokens、要求${decision.requestBytes}B。判定範囲を固定し、原記録は保持します。`,
					"info",
				);
			} catch {
				context.ui.notify("判定を完了できませんでした。途中結果は適用せず、原記録を保持します。", "warning");
			} finally {
				release?.();
				if (active === controller) active = undefined;
			}
		},
	});
}

function installReread(pi: ExtensionAPI, options: HarnessHookOptions): void {
	let pending: { sessionId: string; leafId: string; signal: AbortSignal; ranking: ReadRanking } | undefined;
	let releaseHold: (() => void) | undefined;
	const releasePendingHold = (): void => {
		const release = releaseHold;
		releaseHold = undefined;
		release?.();
	};
	let active: AbortController | undefined;
	const roots = (context: ExtensionContext): string[] => [context.cwd, ...(options.additionalReadRoots ?? [])];
	const clear = (): void => {
		pending = undefined;
		active?.abort();
		active = undefined;
		releasePendingHold();
	};

	pi.on("tool_result", async (event, context) => {
		if (event.toolName !== "read" || event.isError || !isRecord(event.input) || typeof event.toolCallId !== "string")
			return;
		const candidates = await collectRead(event as ReadObservationEvent, context.cwd, roots(context));
		for (const candidate of candidates) pi.appendEntry(READ_ENTRY, candidate);
	});

	pi.on("session_before_compact", async (event, context) => {
		releasePendingHold();
		releaseHold = options.hold();
		pending = undefined;
		active?.abort();
		const controller = new AbortController();
		active = controller;
		const signal = AbortSignal.any([event.signal, controller.signal]);
		const entries = event.branchEntries;
		const leafId = entries.at(-1)?.id;
		if (!leafId) return;
		const sessionId = context.sessionManager.getSessionId();
		const ranking = await rankCandidates({
			entries,
			snapshot: leafId,
			roots: roots(context),
			evaluate: options.evaluate,
			signal,
		});
		if (
			signal.aborted ||
			context.sessionManager.getSessionId() !== sessionId ||
			context.sessionManager.getLeafId() !== leafId
		)
			return;
		pending = { sessionId, leafId, signal, ranking };
		if (["unavailable", "partial", "insufficient"].includes(ranking.status))
			context.ui.notify(`Jev再読評価: ${ranking.status}。圧縮は継続します。`, "warning");
		else context.ui.notify(`Jev再読評価: ${ranking.considered}件を評価しました。`, "info");
	});

	pi.on("session_compact", (event, context) => {
		const current = pending;
		pending = undefined;
		active = undefined;
		if (!current || current.signal.aborted || current.sessionId !== context.sessionManager.getSessionId()) return;
		const entries = context.sessionManager.getBranch();
		if (
			!entries.some((entry) => entry.id === current.leafId) ||
			!entries.some((entry) => entry.type === "compaction" && entry.id === event.compactionEntry.id)
		)
			return;
		pi.appendEntry(PRESERVE_KEY, { compactionId: event.compactionEntry.id, ranking: current.ranking });
		if (current.ranking.selections.length)
			pi.sendMessage(
				{
					customType: MESSAGE_TYPE,
					content: guidanceText(current.ranking),
					display: false,
					details: { compactionId: event.compactionEntry.id },
				},
				{ triggerTurn: false },
			);
	});

	pi.on("session_compact", releasePendingHold);
	pi.on("session_compact_failed", clear);
	onSessionNavigation(pi, clear);
}

export function installHooks(pi: ExtensionAPI, options: HarnessHookOptions): void {
	installContinuity(pi, options);
	installInputAdvice(pi, options);
	installReread(pi, options);
	installJevCompact(pi, options);
	installModelCompactionHook(pi, {
		hold: options.hold,
		ledger: options.ledger,
		compactModel: options.compactModel,
	});
}
