import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "../../core/extensions/types.ts";
import { CompactionTranscriptReader } from "../compaction-reader.ts";
import {
	COMPACTION_SESSION_TIMEOUT_MS,
	COMPACTION_SUMMARY_MAX_CHARACTERS,
	runCompactionSession,
} from "../compaction-session.ts";
import { HARNESS_GOAL_ENTRY } from "../goal.ts";
import { type HarnessModelSelection, SOL_HIGH_FAST } from "../model-call.ts";
import { branchIdForEntries, latestTodoSnapshot } from "../session-data.ts";
import type { HarnessUsageLedger } from "../usage.ts";
import { isRecord } from "./jev-types.ts";

export interface CompactionHookOptions {
	hold: () => () => void;
	ledger: HarnessUsageLedger;
	compactModel?: HarnessModelSelection;
}

function latestGoalSnapshot(branchEntries: readonly SessionBeforeCompactEvent["branchEntries"][number][]): unknown {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry?.type === "custom" && entry.customType === HARNESS_GOAL_ENTRY && isRecord(entry.data))
			return entry.data;
	}
	return undefined;
}

function coverageNote(reader: CompactionTranscriptReader): string {
	const coverage = reader.coverage();
	const ranges = coverage.unreadRanges.map(
		(range) => `${range.fromEntryId}[${range.fromCharacter}-${range.toCharacter}]`,
	);
	const omitted = coverage.additionalUnreadRanges;
	return [
		"Transcript reader coverage (mechanically recorded):",
		`${coverage.fullyReadRecords}/${coverage.targetTextRecordCount} text records fully read; ${coverage.partiallyReadRecords} partial; ${coverage.unreadRecords} unread; ${coverage.unreadCharacters} text characters unread.`,
		`Target references: session ${reader.sessionId}, branch ${reader.branchId}, entries ${reader.targetEntryCount ? `through ${reader.targetEndEntryId}` : "(empty)"} before firstKeptEntryId ${reader.firstKeptEntryId}.`,
		ranges.length > 0
			? `Unread character ranges: ${ranges.join(", ")}${omitted > 0 ? `; ${omitted} more ranges not enumerated.` : "."}`
			: "No unread message-text ranges.",
		"Thinking payloads, image pixels, and other non-message state payloads were not exposed; readable tool arguments and custom notices were sanitized.",
	].join(" ");
}

function appendCoverageNote(summary: string, reader: CompactionTranscriptReader): string {
	const result = `${summary.trim()}\n\n${coverageNote(reader)}`;
	if (result.length > COMPACTION_SUMMARY_MAX_CHARACTERS) {
		throw new Error("Compact checkpoint and reader coverage exceed the output limit");
	}
	return result;
}

function transcriptReader(event: SessionBeforeCompactEvent, context: ExtensionContext): CompactionTranscriptReader {
	const sessionId = context.sessionManager.getSessionId();
	const reader = new CompactionTranscriptReader({
		sessionId,
		branchId: branchIdForEntries(context.sessionManager.getEntries(), event.branchEntries, sessionId),
		sessionFile: context.sessionManager.getSessionFile(),
		branchEntries: event.branchEntries,
		firstKeptEntryId: event.preparation.firstKeptEntryId,
	});
	reader.assertUnchanged(sessionId, context.sessionManager.getBranch());
	return reader;
}

export function installModelCompactionHook(pi: ExtensionAPI, options: CompactionHookOptions): void {
	let pendingRelease: (() => void) | undefined;
	const releasePending = (): void => {
		const release = pendingRelease;
		pendingRelease = undefined;
		release?.();
	};
	pi.on("session_before_compact", async (event, ctx) => {
		const operationSignal = AbortSignal.any([event.signal, AbortSignal.timeout(COMPACTION_SESSION_TIMEOUT_MS)]);
		releasePending();
		try {
			pendingRelease = options.hold();
			const selection = options.compactModel ?? SOL_HIGH_FAST;
			const reader = transcriptReader(event, ctx);
			const initialContext = reader.initialContext({
				previousSummary: event.preparation.previousSummary,
				currentGoal: latestGoalSnapshot(event.branchEntries),
				currentTodo: latestTodoSnapshot(event.branchEntries, ctx.sessionManager.getSessionId()),
				customInstructions: event.customInstructions,
			});
			const result = await runCompactionSession({
				registry: ctx.modelRegistry,
				selection,
				ledger: options.ledger,
				sessionId: ctx.sessionManager.getSessionId(),
				reader,
				initialContext,
				signal: operationSignal,
			});
			operationSignal.throwIfAborted();
			reader.assertUnchanged(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch());
			const summary = appendCoverageNote(result.summary, reader);
			return {
				compaction: {
					summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: result.usage,
					details: {
						model: `${selection.provider}/${selection.model}`,
						thinking: selection.thinking,
						fast: selection.fast === true,
						transcript: {
							sessionId: reader.sessionId,
							branchId: reader.branchId,
							firstKeptEntryId: reader.firstKeptEntryId,
							targetEndEntryId: reader.targetEndEntryId,
							coverage: reader.coverage(),
						},
						timeoutMs: COMPACTION_SESSION_TIMEOUT_MS,
					},
				},
			};
		} catch {
			if (!event.signal.aborted) {
				ctx.ui.notify("専用モデルによる圧縮に失敗したため、履歴は変更せず圧縮を中止しました。", "warning");
			}
			return { cancel: true };
		}
	});

	pi.on("session_compact", releasePending);
	pi.on("session_compact_failed", releasePending);
	pi.on("session_shutdown", releasePending);
}
