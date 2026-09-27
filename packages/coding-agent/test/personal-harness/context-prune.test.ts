import { describe, expect, it } from "vitest";
import {
	type AppliedContextTarget,
	applyContextProjection,
	buildContextRequest,
	CONTEXT_PRUNE_ENTRY,
	CONTEXT_PRUNE_MARKER,
	type ContextCandidate,
	type ContextTarget,
	collectContextCandidates,
	contextTargetsFromBranch,
	evaluateContextCandidates,
	LEGACY_CONTEXT_PRUNE_ENTRY,
	LEGACY_CONTEXT_PRUNE_MARKER,
	type ThinkingReplayCompatibility,
} from "../../src/personal-harness/hooks/context-prune.ts";
import type {
	JevAnswer,
	JevEvaluationInput,
	JevEvaluationResponse,
	JevEvaluator,
} from "../../src/personal-harness/hooks/jev-types.ts";
import { isRecord } from "../../src/personal-harness/hooks/jev-types.ts";

function choiceResponse(input: JevEvaluationInput, choice: "keep" | "omit" | "uncertain"): JevEvaluationResponse {
	const answers: Record<string, JevAnswer> = {};
	for (const id of Object.keys(input.questions)) {
		answers[id] = {
			type: "choice",
			choice,
			confidence: 0.9,
			probabilities: {
				keep: choice === "keep" ? 0.9 : 0.05,
				omit: choice === "omit" ? 0.9 : 0.05,
				uncertain: choice === "uncertain" ? 0.9 : 0.05,
			},
		};
	}
	return { model: "jev-latest", answers, usage: { input_tokens: 12, output_tokens: 2 } };
}

function targetOf(candidate: ContextCandidate): ContextTarget {
	return {
		entryId: candidate.entryId,
		role: candidate.role,
		blockIndex: candidate.blockIndex,
		fingerprint: candidate.fingerprint,
		kind: candidate.kind,
		start: candidate.start,
		end: candidate.end,
	};
}

describe("jev-compact candidate selection", () => {
	it("prunes Codex text while preserving its message-id and phase metadata", () => {
		const signature = JSON.stringify({ v: 1, id: "msg_fixture", phase: "final_answer" });
		const original = "An old completed answer unrelated to the current task. ".repeat(4);
		const messages = [
			{ role: "user", content: "A completed earlier task." },
			{
				role: "assistant",
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: "gpt-6-luna",
				stopReason: "stop",
				content: [{ type: "text", text: original, textSignature: signature }],
			},
			{ role: "user", content: "Work on the new task instead." },
		];
		const ids = ["user-old", "assistant-old", "user-current"];
		const candidate = collectContextCandidates(messages, ids).candidates.find((c) => c.role === "assistant");
		expect(candidate).toBeDefined();
		if (!candidate) throw new Error("Codex text candidate missing");
		const projected = applyContextProjection(messages, ids, [targetOf(candidate)]);
		expect(projected[1]).toMatchObject({ content: [{ textSignature: signature }] });
		expect(JSON.stringify(projected[1])).toContain(CONTEXT_PRUNE_MARKER);
		expect(messages[1]).toMatchObject({ content: [{ text: original, textSignature: signature }] });
	});

	it("selects entry-bound old user, assistant, and tool content while protecting active turns and system/developer messages", () => {
		const messages = [
			{ role: "system", content: "SYSTEM_ONLY_SENTINEL" },
			{ role: "developer", content: "DEVELOPER_ONLY_SENTINEL" },
			{ role: "user", content: "A concluded old request with enough text to be judged safely." },
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "text", text: "An earlier assistant response with enough context to assess independently." },
					{ type: "toolCall", id: "old-call", name: "read", arguments: { path: "example.ts" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "old-call",
				toolName: "read",
				isError: false,
				content: [
					{ type: "text", text: "Earlier tool evidence with details that can be judged as an exact range." },
				],
			},
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "A completed earlier answer with a result." }],
			},
			{ role: "user", content: "The current request must remain visible." },
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "current-call", name: "read", arguments: { path: "current.ts" } }],
			},
			{
				role: "toolResult",
				toolCallId: "current-call",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "The newest tool exchange must remain intact." }],
			},
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "The latest answer must remain intact." }],
			},
		];
		const entryIds = [
			"system-entry",
			"developer-entry",
			"old-user",
			"old-assistant-call",
			"old-tool-result",
			"old-assistant-final",
			"latest-user",
			"latest-assistant-call",
			"latest-tool-result",
			"latest-assistant-final",
		];
		const gathered = collectContextCandidates(messages, entryIds);
		const roles = gathered.candidates.map((candidate) => candidate.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
		expect(roles).toContain("toolResult");
		expect(gathered.candidates.every((candidate) => candidate.messageIndex < 6)).toBe(true);
		expect(gathered.candidates.some((candidate) => candidate.entryId === "old-tool-result")).toBe(true);
		const input = buildContextRequest(messages, entryIds, [gathered.candidates[0]!]);
		expect(JSON.stringify(input)).not.toContain("SYSTEM_ONLY_SENTINEL");
		expect(JSON.stringify(input)).not.toContain("DEVELOPER_ONLY_SENTINEL");
	});

	it("uses complete UTF-8-safe text chunks and applies only the matching entry/hash/span", () => {
		const repeated = "🙂detail-".repeat(900);
		const messages = [
			{ role: "user", content: repeated },
			{ role: "user", content: repeated },
			{ role: "user", content: "Latest request stays visible." },
		];
		const entryIds = ["first-copy", "second-copy", "current-user"];
		const gathered = collectContextCandidates(messages, entryIds);
		const firstCopy = gathered.candidates.filter((candidate) => candidate.entryId === "first-copy");
		expect(firstCopy.length).toBeGreaterThan(1);
		for (const candidate of firstCopy) {
			const piece = repeated.slice(candidate.start, candidate.end);
			expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(4096);
			expect(piece).not.toMatch(/[\uD800-\uDBFF]$/);
			expect(piece).not.toMatch(/^[\uDC00-\uDFFF]/);
		}
		const target = firstCopy[1]!;
		const projected = applyContextProjection(messages, entryIds, [targetOf(target)]);
		const projectedFirst = projected[0];
		const text = isRecord(projectedFirst) ? projectedFirst.content : undefined;
		const expected = repeated.slice(0, target.start) + CONTEXT_PRUNE_MARKER + repeated.slice(target.end);
		expect(text).toBe(expected);
		const projectedSecond = projected[1];
		expect(isRecord(projectedSecond) ? projectedSecond.content : undefined).toBe(repeated);
		expect(messages[0]?.content).toBe(repeated);
		const changed = [{ role: "user", content: `${repeated} changed` }, messages[1], messages[2]];
		const stale = applyContextProjection(changed, entryIds, [targetOf(target)]);
		const staleFirst = stale[0];
		expect(isRecord(staleFirst) ? staleFirst.content : undefined).toBe(changed[0]?.content);
	});

	it("keeps legacy and v2 tool-result ranges bound to the original block", () => {
		const originalText = "Historical tool output remains bound to its original offsets. ".repeat(220);
		const messages = [
			{ role: "user", content: "The first task requested an older read." },
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "old-call", name: "read", arguments: { path: "fixture.ts" } }],
			},
			{
				role: "toolResult",
				toolCallId: "old-call",
				toolName: "read",
				content: [{ type: "text", text: originalText }],
			},
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The first task concluded." }] },
			{ role: "user", content: "A later task requested another read." },
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "new-call", name: "read", arguments: { path: "latest.ts" } }],
			},
			{
				role: "toolResult",
				toolCallId: "new-call",
				toolName: "read",
				content: [{ type: "text", text: "The newest read remains protected." }],
			},
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The later task concluded." }] },
			{ role: "user", content: "The current task must remain visible." },
		];
		const entryIds = [
			"old-user",
			"old-call",
			"old-result",
			"old-final",
			"later-user",
			"new-call",
			"new-result",
			"new-final",
			"current-user",
		];
		const originalCandidates = collectContextCandidates(messages, entryIds).candidates.filter(
			(candidate) => candidate.entryId === "old-result",
		);
		const first = originalCandidates.find((candidate) => candidate.start === 0);
		expect(first).toBeDefined();
		if (!first) throw new Error("Missing initial tool-result range");
		const legacyTarget: AppliedContextTarget = {
			callId: "old-call",
			toolName: "read",
			blockIndex: 0,
			fingerprint: first.fingerprint,
			kind: "text",
			start: first.start,
			end: first.end,
		};
		const remaining = collectContextCandidates(messages, entryIds, [legacyTarget]).candidates.filter(
			(candidate) => candidate.entryId === "old-result",
		);
		expect(remaining.map((candidate) => [candidate.start, candidate.end])).toEqual([
			[4096, 8192],
			[8192, 12_288],
			[12_288, originalText.length],
		]);
		const second = remaining.find((candidate) => candidate.start === 4096);
		expect(second).toBeDefined();
		if (!second) throw new Error("Missing next tool-result range");

		const projected = applyContextProjection(messages, entryIds, [legacyTarget, targetOf(second)]);
		const projectedResult = projected[2];
		const content =
			isRecord(projectedResult) && Array.isArray(projectedResult.content) ? projectedResult.content : [];
		expect(content[0]).toEqual({
			type: "text",
			text: `${LEGACY_CONTEXT_PRUNE_MARKER}${CONTEXT_PRUNE_MARKER}${originalText.slice(8192)}`,
		});
		expect(messages[2]).toMatchObject({ content: [{ type: "text", text: originalText }] });
	});

	it("judges visible historical reasoning only under an exact verified model gate and removes its whole item", () => {
		const opaqueSignature = "opaque-reasoning-signature-must-not-be-sent";
		const thinkingText = "A complete historical reasoning item shown as readable text.";
		const messages = [
			{ role: "user", content: "The earlier task began here." },
			{
				role: "assistant",
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-6-sol",
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: thinkingText, thinkingSignature: opaqueSignature },
					{ type: "text", text: "The completed answer must remain." },
				],
			},
			{ role: "user", content: "A later user turn establishes that the earlier turn is complete." },
		];
		const entryIds = ["reasoning-start", "reasoning-answer", "latest-user"];
		const withoutGate = collectContextCandidates(messages, entryIds);
		expect(withoutGate.candidates.some((candidate) => candidate.kind === "thinking")).toBe(false);
		const verified: ThinkingReplayCompatibility[] = [
			{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-sol" },
		];
		const withGate = collectContextCandidates(messages, entryIds, [], verified, verified[0]!);
		const candidate = withGate.candidates.find((item) => item.kind === "thinking");
		expect(candidate).toMatchObject({ start: 0, end: thinkingText.length, part: 1, parts: 1, text: thinkingText });
		const input = buildContextRequest(messages, entryIds, [candidate!], [], verified[0]!, verified);
		expect(JSON.stringify(input)).toContain(thinkingText);
		expect(JSON.stringify(input)).not.toContain(opaqueSignature);
		const projected = applyContextProjection(messages, entryIds, [targetOf(candidate!)], verified[0]!, verified);
		expect(projected[1]).toMatchObject({ content: [{ type: "text", text: "The completed answer must remain." }] });
		expect(messages[1]?.content?.[0]).toEqual({
			type: "thinking",
			thinking: thinkingText,
			thinkingSignature: opaqueSignature,
		});

		const incomplete = messages.map((message, index) =>
			index === 1 && typeof message === "object" && message !== null
				? { ...message, stopReason: "toolUse" }
				: message,
		);
		expect(
			collectContextCandidates(incomplete, entryIds, [], verified, verified[0]!).candidates.some(
				(item) => item.kind === "thinking",
			),
		).toBe(false);
	});

	it("preserves saved reasoning targets on unknown destinations and reapplies them after returning to a verified model", () => {
		const source: ThinkingReplayCompatibility = {
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-6-luna",
		};
		const verified: ThinkingReplayCompatibility[] = [
			source,
			{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-sol" },
			{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-astra" },
		];
		const unverified = { api: "faux-api", provider: "faux", model: "faux-1" };
		const thinking = "A complete old reasoning item that was selected for omission on Luna.";
		const answer = "An old visible answer remains separately eligible for plain-text pruning.";
		const messages = [
			{ role: "user", content: "The earlier task started here." },
			{
				role: "assistant",
				api: source.api,
				provider: source.provider,
				model: source.model,
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking, thinkingSignature: "opaque-signature" },
					{ type: "text", text: answer },
					{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
				],
			},
			{ role: "user", content: "The current task begins after the earlier turn." },
		];
		const entryIds = ["old-user", "old-assistant", "current-user"];
		const onUnverified = collectContextCandidates(messages, entryIds, [], verified, unverified).candidates;
		expect(onUnverified.some((candidate) => candidate.kind === "thinking")).toBe(false);
		expect(onUnverified.map((candidate) => candidate.kind)).toEqual(expect.arrayContaining(["text", "image"]));
		expect(
			collectContextCandidates(messages, entryIds, [], verified).candidates.some(
				(candidate) => candidate.kind === "thinking",
			),
		).toBe(false);

		const onVerified = collectContextCandidates(messages, entryIds, [], verified, source).candidates;
		const savedTargets = onVerified.map(targetOf);
		expect(savedTargets.some((target) => target.kind === "thinking")).toBe(true);
		const unknownProjection = applyContextProjection(messages, entryIds, savedTargets, undefined, verified);
		expect(unknownProjection[1]).toMatchObject({
			content: expect.arrayContaining([expect.objectContaining({ type: "thinking", thinking })]),
		});
		expect(JSON.stringify(unknownProjection[1]).split(CONTEXT_PRUNE_MARKER).length - 1).toBe(2);
		const preserved = applyContextProjection(messages, entryIds, savedTargets, unverified, verified);
		expect(preserved[1]).toMatchObject({
			content: expect.arrayContaining([expect.objectContaining({ type: "thinking", thinking })]),
		});
		expect(JSON.stringify(preserved[1]).split(CONTEXT_PRUNE_MARKER).length - 1).toBe(2);
		const restored = applyContextProjection(messages, entryIds, savedTargets, source, verified);
		expect(restored[1]).not.toMatchObject({
			content: expect.arrayContaining([expect.objectContaining({ type: "thinking", thinking })]),
		});
		expect(JSON.stringify(restored[1])).toContain(CONTEXT_PRUNE_MARKER);
		expect(messages[1]?.content?.[0]).toMatchObject({ type: "thinking", thinking });
	});

	it("scrubs credentials embedded in tool-code strings before JSON escaping task-context arguments", () => {
		const code = 'const config = {"password":"synthetic-secret"};';
		const messages = [
			{ role: "user", content: "A completed old request with enough detail to assess on its own." },
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "toolCall", id: "call-edit", name: "edit", arguments: { code } }],
			},
			{ role: "user", content: "The current task remains visible." },
		];
		const entryIds = ["old-user", "edit-call", "current-user"];
		const candidate = collectContextCandidates(messages, entryIds).candidates.find((item) => item.role === "user");
		expect(candidate).toBeDefined();
		if (!candidate) throw new Error("Expected a prior user candidate");
		const request = buildContextRequest(messages, entryIds, [candidate]);
		if (!isRecord(request.state)) throw new Error("Expected structured Jev state");
		const serializedContext = JSON.stringify(request.state.taskContext);
		expect(serializedContext).not.toContain("synthetic-secret");
		expect(serializedContext).toContain("[credential removed]");
	});

	it("retains explicit legacy targets and reports the bounded, unevaluated suffix without pruning it", async () => {
		const messages = Array.from({ length: 260 }, (_, index) => ({
			role: "user",
			content: `A completed historical user item ${index} has enough content to evaluate safely.`,
		}));
		messages.push({ role: "user", content: "The latest task remains visible and protected." });
		const entryIds = messages.map((_, index) => `entry-${index}`);
		const candidates = collectContextCandidates(messages, entryIds).candidates;
		const requests: JevEvaluationInput[] = [];
		const evaluate: JevEvaluator = async (input) => {
			requests.push(input);
			return choiceResponse(input, "keep");
		};
		const decision = await evaluateContextCandidates(
			messages,
			entryIds,
			candidates,
			evaluate,
			new AbortController().signal,
		);
		const serializedRequests = requests.map((request) =>
			JSON.stringify({ state: request.state, model: "jev-latest", questions: request.questions }),
		);
		expect(requests.length).toBeLessThanOrEqual(16);
		expect(serializedRequests.every((request) => Buffer.byteLength(request) <= 65_536)).toBe(true);
		expect(decision.requestBytes).toBe(
			serializedRequests.reduce((total, request) => total + Buffer.byteLength(request), 0),
		);
		expect(decision.requestBytes).toBeLessThanOrEqual(262_144);
		expect(decision.evaluated + decision.unjudgedCount).toBe(candidates.length);
		expect(decision.unjudgedCount).toBeGreaterThan(0);
		expect(decision.unjudgedFrom).toBe(decision.evaluated);
		expect(decision.kept + decision.selected.length + decision.uncertain).toBe(decision.evaluated);
		expect(decision.selected).toEqual([]);
		const legacyEntry = {
			type: "custom",
			customType: LEGACY_CONTEXT_PRUNE_ENTRY,
			data: {
				version: 1,
				targets: [
					{
						callId: "old-call",
						toolName: "read",
						blockIndex: 0,
						fingerprint: "a".repeat(64),
						kind: "text",
						start: 0,
						end: 20,
					},
				],
			},
		};
		const modernTarget = targetOf(candidates[0]!);
		const modernEntry = {
			type: "custom",
			customType: CONTEXT_PRUNE_ENTRY,
			data: { version: 2, targets: [modernTarget] },
		};
		const restored = contextTargetsFromBranch([legacyEntry, modernEntry]);
		expect(restored).toHaveLength(2);
		expect(restored[0]).toMatchObject({ callId: "old-call", toolName: "read" });
		expect(restored[1]).toEqual(modernTarget);
	});
});
