import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { type OpenMicroResult, openMicro } from "../src/experimental/micro/runtime.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const FAUX_PROVIDER = "micro-compaction-test";
const FAUX_MODEL = "large-context";
const FAUX_MODEL_REF = { provider: FAUX_PROVIDER, modelId: FAUX_MODEL } as const;

function createFauxProvider(onModelCall: () => void): Provider<"openai-completions"> {
	const model: Model<"openai-completions"> = {
		id: FAUX_MODEL,
		name: "Large context test model",
		api: "openai-completions",
		provider: FAUX_PROVIDER,
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_000,
	};

	return {
		id: FAUX_PROVIDER,
		name: "Micro compaction test provider",
		auth: {
			apiKey: {
				name: "Test API key",
				login: async () => ({ type: "api_key", key: "unused-test-key" }),
				check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
		},
		getModels: () => [model],
		stream: () => {
			onModelCall();
			throw new Error("The test must not call a model");
		},
		streamSimple: () => {
			onModelCall();
			throw new Error("The test must not call a model");
		},
	};
}

describe("micro runtime compaction settings", () => {
	it("syncs current settings on continue and preserves the saved model and thinking level", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "micro-runtime-compaction-"));
		const cwd = join(tempRoot, "project");
		const agentDir = join(tempRoot, "agent");
		const projectSettingsPath = join(cwd, ".pi", "settings.json");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		let modelCalls = 0;
		let micro: OpenMicroResult | undefined;
		process.env.PI_CODING_AGENT_DIR = agentDir;

		try {
			await mkdir(join(cwd, ".pi"), { recursive: true });
			const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
			const runtime = getModelRuntime(registry);
			runtime.registerNativeProvider(createFauxProvider(() => modelCalls++));
			await runtime.refresh({ allowNetwork: false, providers: [FAUX_PROVIDER] });
			vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);

			micro = await openMicro({ cwd });
			const sessionPath = micro.view.current().session.path;
			await micro.controller.setModel(FAUX_MODEL_REF);
			await vi.waitFor(() => expect(micro?.view.current().conversation.config.model).toEqual(FAUX_MODEL_REF));
			for (
				let attempt = 0;
				attempt < 7 && micro.view.current().conversation.config.thinkingLevel !== "high";
				attempt++
			) {
				const previousThinking = micro.view.current().conversation.config.thinkingLevel;
				await micro.controller.cycleThinking();
				await vi.waitFor(() =>
					expect(micro?.view.current().conversation.config.thinkingLevel).not.toBe(previousThinking),
				);
			}
			const savedThinkingLevel = micro.view.current().conversation.config.thinkingLevel;
			expect(savedThinkingLevel).toBe("high");
			expect(micro.view.current().conversation.config).toMatchObject({
				model: FAUX_MODEL_REF,
				threshold: 83_616,
				keepRecent: 20_000,
			});
			await micro.close();
			micro = undefined;

			await writeFile(
				projectSettingsPath,
				JSON.stringify({ compaction: { thresholdPercent: 75, keepRecentTokens: 7_000 } }),
			);
			micro = await openMicro({ cwd, continueSession: true });
			await vi.waitFor(() =>
				expect(micro?.view.current().conversation.config).toMatchObject({
					model: FAUX_MODEL_REF,
					thinkingLevel: savedThinkingLevel,
					threshold: 74_999,
					keepRecent: 7_000,
				}),
			);
			await micro.close();
			micro = undefined;

			await writeFile(
				projectSettingsPath,
				JSON.stringify({ compaction: { thresholdPercent: 80, keepRecentTokens: 4_000 } }),
			);
			micro = await openMicro({ cwd, continueSession: true });
			await vi.waitFor(() =>
				expect(micro?.view.current().conversation.config).toMatchObject({
					model: FAUX_MODEL_REF,
					thinkingLevel: savedThinkingLevel,
					threshold: 79_999,
					keepRecent: 4_000,
				}),
			);
			await micro.close();
			micro = undefined;

			await writeFile(projectSettingsPath, JSON.stringify({ compaction: {} }));
			micro = await openMicro({ cwd, continueSession: true });
			await vi.waitFor(() =>
				expect(micro?.view.current().conversation.config).toMatchObject({
					model: FAUX_MODEL_REF,
					thinkingLevel: savedThinkingLevel,
					threshold: 83_616,
					keepRecent: 20_000,
				}),
			);
			await micro.close();
			micro = undefined;

			const journalPath = join(sessionPath, "main.jsonl");
			const journalBeforeUnchangedContinue = await readFile(journalPath);
			micro = await openMicro({ cwd, continueSession: true });
			await vi.waitFor(() =>
				expect(micro?.view.current().conversation.config).toMatchObject({
					model: FAUX_MODEL_REF,
					thinkingLevel: savedThinkingLevel,
					threshold: 83_616,
					keepRecent: 20_000,
				}),
			);
			await micro.close();
			micro = undefined;
			expect(await readFile(journalPath)).toEqual(journalBeforeUnchangedContinue);
			expect(modelCalls).toBe(0);
		} finally {
			await micro?.close();
			vi.restoreAllMocks();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
