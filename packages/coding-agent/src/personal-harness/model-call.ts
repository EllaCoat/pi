import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ModelsApiStreamOptions, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { type AssistantMessage, type Context, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../core/model-registry.ts";
import { type HarnessUsageLedger, type HarnessUsagePurpose, reportedModelUsage } from "./usage.ts";

export interface HarnessModelSelection {
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	fast?: boolean;
}

export const LUNA_MAX: HarnessModelSelection = { provider: "openai-codex", model: "gpt-6-luna", thinking: "max" };
export const LUNA_HIGH_FAST: HarnessModelSelection = {
	provider: "openai-codex",
	model: "gpt-6-luna",
	thinking: "high",
	fast: true,
};

export const SOL_HIGH_FAST: HarnessModelSelection = {
	provider: "openai-codex",
	model: "gpt-6-sol",
	thinking: "high",
	fast: true,
};

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
		if (selection.fast && model.api !== "openai-codex-responses") {
			throw new Error(`${modelName} does not support Codex Fast Mode`);
		}
		if (!getSupportedThinkingLevels(model).includes(selection.thinking)) {
			throw new Error(`${modelName} does not support thinking=${selection.thinking}`);
		}
		const commonOptions = {
			signal,
			maxTokens: options.maxTokens ?? 8192,
			cacheRetention: "short" as const,
			...(options.sessionId ? { sessionId: options.sessionId } : {}),
		};
		if (selection.fast) {
			const codexModel = model as Model<"openai-codex-responses">;
			const streamOptions: ModelsApiStreamOptions<"openai-codex-responses"> = {
				...commonOptions,
				...(selection.thinking === "off" ? {} : { reasoningEffort: selection.thinking }),
				serviceTier: "priority",
			};
			response = await registry.stream(codexModel, options.context, streamOptions).result();
		} else {
			const streamOptions: ModelsSimpleStreamOptions = {
				...commonOptions,
				...(selection.thinking === "off" ? {} : { reasoning: selection.thinking }),
			};
			response = await registry.streamSimple(model, options.context, streamOptions).result();
		}
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
