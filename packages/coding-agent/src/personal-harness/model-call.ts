import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Context, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../core/model-registry.ts";
import { type HarnessUsageLedger, type HarnessUsagePurpose, reportedModelUsage } from "./usage.ts";

export interface HarnessModelSelection {
	provider: string;
	model: string;
	thinking: ThinkingLevel;
}

export const LUNA_MAX: HarnessModelSelection = { provider: "openai-codex", model: "gpt-6-luna", thinking: "max" };

export interface HarnessCompletionOptions {
	registry: ModelRegistry;
	selection: HarnessModelSelection;
	purpose: HarnessUsagePurpose;
	context: Context;
	ledger: HarnessUsageLedger;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxTokens?: number;
	/** Accept a structured tool-call result; the caller still validates its schema and does not execute it. */
	allowToolCalls?: boolean;
	sessionId?: string;
}

/** Uses the registry's authenticated request path; there is no credential extraction or fallback model. */
export async function completeHarnessTask(options: HarnessCompletionOptions): Promise<AssistantMessage> {
	const started = performance.now();
	const { selection, registry, ledger, purpose } = options;
	const modelName = `${selection.provider}/${selection.model}`;
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)])
		: AbortSignal.timeout(options.timeoutMs ?? 120_000);
	let response: AssistantMessage | undefined;
	try {
		signal.throwIfAborted();
		const model = registry.find(selection.provider, selection.model);
		if (!model) throw new Error(`Configured model is unavailable: ${modelName}`);
		if (!getSupportedThinkingLevels(model).includes(selection.thinking)) {
			throw new Error(`${modelName} does not support thinking=${selection.thinking}`);
		}
		response = await registry
			.streamSimple(model, options.context, {
				signal,
				...(selection.thinking === "off" ? {} : { reasoning: selection.thinking }),
				maxTokens: options.maxTokens ?? 8192,
				cacheRetention: "short",
				...(options.sessionId ? { sessionId: options.sessionId } : {}),
			})
			.result();
		signal.throwIfAborted();
		if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
			throw new Error(response.errorMessage ?? `Model stopped with ${response.stopReason}`);
		}
		if (
			!response.content.some(
				(part) =>
					(part.type === "text" && part.text.trim()) ||
					(options.allowToolCalls === true && part.type === "toolCall"),
			)
		) {
			throw new Error("The model returned no usable result");
		}
		ledger.record({
			purpose,
			model: modelName,
			status: "success",
			usage: response.usage,
			durationMs: performance.now() - started,
		});
		return response;
	} catch (error) {
		ledger.record({
			purpose,
			model: modelName,
			status: signal.aborted ? "aborted" : "error",
			usage: response ? reportedModelUsage(response) : undefined,
			durationMs: performance.now() - started,
		});
		throw error;
	}
}

export function harnessResponseText(response: AssistantMessage): string {
	return response.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
