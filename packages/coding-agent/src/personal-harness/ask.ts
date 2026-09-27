import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";

const OptionSchema = Type.Object({
	value: Type.String({ description: "Stable value returned for this option" }),
	label: Type.String({ description: "Option text shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional explanation shown with the option" })),
	recommended: Type.Optional(Type.Boolean({ description: "Mark this option as recommended" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier included with the eventual answer" }),
	label: Type.Optional(Type.String({ description: "Short context for this question" })),
	prompt: Type.String({ description: "Question shown to the user" }),
	options: Type.Optional(
		Type.Array(OptionSchema, { description: "Choices; omit or leave empty for a free-text question" }),
	),
	allowOther: Type.Optional(Type.Boolean({ description: "Offer an Other/free-text choice (defaults to true)" })),
	multiple: Type.Optional(Type.Boolean({ description: "Allow choosing more than one listed option" })),
});

const AskParameters = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Grouped questions to present to the user" }),
});

type AskInput = Static<typeof AskParameters>;
type AskQuestionInput = AskInput["questions"][number];
type AskOptionInput = NonNullable<AskQuestionInput["options"]>[number];

interface AskQuestion {
	id: string;
	label: string;
	prompt: string;
	options: AskOptionInput[];
	allowOther: boolean;
	multiple: boolean;
}

interface AskSelection {
	value: string;
	label: string;
	source: "option" | "other";
}

interface AskAnswer {
	questionId: string;
	selections: AskSelection[];
}

interface AskRequest {
	id: string;
	questionIds: string[];
	sessionId: string;
	controller: AbortController;
	cancelled: boolean;
	removeSignalListener?: () => void;
}

type CollectionResult = { status: "answered"; answers: AskAnswer[] } | { status: "cancelled"; answers: AskAnswer[] };

function errorResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text }],
		details: { status: "unavailable", harnessError: true, ...details },
	};
}

function validateQuestions(questions: readonly AskQuestionInput[]): string | undefined {
	if (questions.length === 0) return "Provide at least one question.";

	const ids = new Set<string>();
	for (const question of questions) {
		if (!question.id.trim()) return "Every question needs a non-empty stable id.";
		if (ids.has(question.id)) return `Question id is duplicated: ${question.id}`;
		ids.add(question.id);
		if (!question.prompt.trim()) return `Question ${question.id} needs prompt text.`;

		const options = question.options ?? [];
		if (options.some((option) => !option.label.trim())) return `Every option in ${question.id} needs a label.`;
		if (
			options.some((option) => !option.value.trim()) ||
			new Set(options.map((option) => option.value)).size !== options.length
		)
			return "Each listed option needs a unique, non-empty value within its question.";
		if (options.length === 0 && question.allowOther === false)
			return `Question ${question.id} has no choices and free-text input is disabled.`;
		if (question.multiple && options.length === 0)
			return `Question ${question.id} needs listed choices to allow multiple selections.`;
	}
	return undefined;
}

function normalizeQuestions(questions: readonly AskQuestionInput[]): AskQuestion[] {
	return questions.map((question, index) => ({
		id: question.id,
		label: question.label?.trim() || `Question ${index + 1}`,
		prompt: question.prompt,
		options: question.options ?? [],
		allowOther: question.allowOther !== false,
		multiple: question.multiple === true,
	}));
}

function optionText(option: AskOptionInput, index: number): string {
	const recommendation = option.recommended ? " (recommended)" : "";
	const description = option.description ? ` — ${option.description}` : "";
	return `${index + 1}. ${option.label}${recommendation}${description}`;
}

async function collectAnswers(
	ui: ExtensionContext["ui"],
	questions: readonly AskQuestion[],
	signal: AbortSignal,
): Promise<CollectionResult> {
	const answers: AskAnswer[] = [];

	for (const [questionIndex, question] of questions.entries()) {
		const title = `${question.label} (${questionIndex + 1}/${questions.length}): ${question.prompt}`;
		const selections: AskSelection[] = [];

		if (question.options.length === 0) {
			const value = await ui.input(title, "Write your answer", { signal });
			if (value === undefined) return { status: "cancelled", answers };
			selections.push({ value, label: value, source: "other" });
		} else {
			const selectedIndexes = new Set<number>();
			while (true) {
				const choices = question.options
					.map((option, index) => ({ option, index, text: optionText(option, index) }))
					.filter((choice) => !selectedIndexes.has(choice.index));
				const otherText = `${question.options.length + 1}. Other (write an answer)`;
				const doneText = `${question.options.length + (question.allowOther ? 2 : 1)}. Done selecting`;
				const displayed = choices.map((choice) => choice.text);
				if (question.allowOther) displayed.push(otherText);
				if (question.multiple) displayed.push(doneText);

				const selected = await ui.select(
					question.multiple && selections.length > 0
						? `${title} (selected: ${selections.map((answer) => answer.label).join(", ")})`
						: title,
					displayed,
					{ signal },
				);
				if (selected === undefined) return { status: "cancelled", answers };
				if (question.multiple && selected === doneText) break;

				const choice = choices.find((candidate) => candidate.text === selected);
				if (choice) {
					selectedIndexes.add(choice.index);
					selections.push({ value: choice.option.value, label: choice.option.label, source: "option" });
					if (!question.multiple) break;
					continue;
				}

				if (question.allowOther && selected === otherText) {
					const value = await ui.input(`${question.label}: ${question.prompt}`, "Write your answer", { signal });
					if (value === undefined) return { status: "cancelled", answers };
					selections.push({ value, label: value, source: "other" });
					if (!question.multiple) break;
				}
			}
		}

		answers.push({ questionId: question.id, selections });
	}

	return { status: "answered", answers };
}

function answerText(requestId: string, questionIds: readonly string[], outcome: CollectionResult): string {
	const lines = outcome.answers.map((answer) => {
		const value =
			answer.selections.length > 0
				? answer.selections
						.map(
							(selection) =>
								`${selection.source === "other" ? "free text" : "selected"} ${JSON.stringify(selection.value)}`,
						)
						.join(", ")
				: "no choices selected";
		return `${answer.questionId}: ${value}`;
	});
	const status = outcome.status === "cancelled" ? "cancelled" : "answered";
	return [
		`Ask request ${requestId} ${status}.`,
		`Question ids: ${questionIds.join(", ")}`,
		...lines,
		"Use only the permissions explicitly granted by these answers. Unanswered or cancelled questions grant none.",
	].join("\n");
}

export function registerHarnessAsk(pi: ExtensionAPI): void {
	let pending: AskRequest | undefined;

	function detach(request: AskRequest): void {
		request.removeSignalListener?.();
		request.removeSignalListener = undefined;
	}

	function cancelPending(): void {
		const request = pending;
		if (!request) return;
		pending = undefined;
		request.cancelled = true;
		detach(request);
		request.controller.abort();
	}

	function isCurrent(request: AskRequest): boolean {
		return pending === request && !request.cancelled;
	}

	function sendOutcome(
		request: AskRequest,
		ctx: ExtensionContext,
		outcome: CollectionResult | { status: "failed"; error: string },
	): void {
		try {
			if (!isCurrent(request)) return;
			if (ctx.sessionManager.getSessionId() !== request.sessionId) {
				cancelPending();
				return;
			}

			pending = undefined;
			detach(request);
			const status = outcome.status === "failed" ? "failed" : outcome.status;
			const answers = outcome.status === "failed" ? [] : outcome.answers;
			const content =
				outcome.status === "failed"
					? `Ask request ${request.id} failed: ${outcome.error}\nQuestion ids: ${request.questionIds.join(", ")}`
					: answerText(request.id, request.questionIds, outcome);
			pi.sendMessage(
				{
					customType: "personal-harness-ask-answer",
					content,
					display: true,
					details: {
						version: 1,
						requestId: request.id,
						questionIds: request.questionIds,
						status,
						answers,
						...(outcome.status === "failed" ? { error: outcome.error } : {}),
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			if (pending === request) {
				pending = undefined;
				detach(request);
			}
		}
	}

	const invalidateRequest = (): void => cancelPending();
	pi.on("session_start", invalidateRequest);
	pi.on("session_abort", invalidateRequest);
	pi.on("session_before_switch", invalidateRequest);
	pi.on("session_before_fork", invalidateRequest);
	pi.on("session_before_tree", invalidateRequest);
	pi.on("session_tree", invalidateRequest);
	pi.on("session_shutdown", invalidateRequest);

	pi.registerTool({
		name: "ask",
		label: "ask user",
		description:
			"Ask the user grouped questions for preferences, missing context, or explicit approval. Returns a pending receipt immediately so you can continue independent work; answers arrive later in the originating session. Do not poll or start another ask while one is pending. Pending input is not permission.",
		promptSnippet:
			"Ask the user for preferences or missing context; continue independent work while an answer is pending.",
		promptGuidelines: [
			"Use ask only when user input is genuinely needed; continue unrelated work after receiving a pending receipt.",
			"Do not poll or submit another ask while a request is pending. Defer only actions that truly depend on the answer.",
			"For approval questions, act only within the scope explicitly approved by the answer. Unanswered or cancelled questions do not grant permission.",
		],
		parameters: AskParameters,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				return errorResult("Ask is unavailable outside interactive TUI mode; no request was created.");
			}
			if (signal?.aborted) return errorResult("Ask was cancelled before a request was created.");
			if (pending) {
				return errorResult(`Ask request ${pending.id} is still pending; it was not replaced.`, {
					requestId: pending.id,
					questionIds: pending.questionIds,
				});
			}

			const validationError = validateQuestions(params.questions);
			if (validationError) return errorResult(validationError);

			const questions = normalizeQuestions(params.questions);
			const request: AskRequest = {
				id: randomUUID(),
				questionIds: questions.map((question) => question.id),
				sessionId: ctx.sessionManager.getSessionId(),
				controller: new AbortController(),
				cancelled: false,
			};
			pending = request;
			if (signal) {
				const onAbort = (): void => {
					if (!isCurrent(request)) return;
					pending = undefined;
					request.cancelled = true;
					detach(request);
					request.controller.abort();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				request.removeSignalListener = () => signal.removeEventListener("abort", onAbort);
			}

			void collectAnswers(ctx.ui, questions, request.controller.signal).then(
				(outcome) => sendOutcome(request, ctx, outcome),
				(error: unknown) =>
					sendOutcome(request, ctx, {
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
					}),
			);

			if (!isCurrent(request)) return errorResult("Ask was cancelled before the pending request could be created.");
			return {
				content: [
					{
						type: "text",
						text: [
							`Ask request ${request.id} is pending.`,
							`Question ids: ${request.questionIds.join(", ")}`,
							"Continue independent work. Do not poll or replace this request. If a next action genuinely requires an answer, defer only that action; the answer will be sent to this Main session.",
							"Pending input is not approval or authorization.",
						].join("\n"),
					},
				],
				details: { status: "pending", requestId: request.id, questionIds: request.questionIds },
			};
		},
	});
}
