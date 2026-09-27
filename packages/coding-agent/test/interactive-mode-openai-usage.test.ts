import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { OpenAICodexUsageController } from "../src/core/openai-codex-usage.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const refreshUsage = Reflect.get(InteractiveMode.prototype, "refreshOpenAIUsage") as (
	this: object,
	invalidate?: boolean,
) => void;
const stop = Reflect.get(InteractiveMode.prototype, "stop") as (this: object, exitOutput: "transcript") => void;

function createContext() {
	const context = {
		isInitialized: true,
		isShuttingDown: false,
		session: {
			sessionId: "session-a",
			model: { provider: "anthropic", id: "other-main-model" },
			modelRuntime: { getProvider: () => undefined } as unknown as ModelRuntime,
		},
		openAIUsageController: undefined as OpenAICodexUsageController | undefined,
		openAIUsageSession: undefined as object | undefined,
		openAIUsageTimer: undefined as NodeJS.Timeout | undefined,
		footer: { setOpenAIUsage: vi.fn(), dispose: vi.fn() },
		footerDataProvider: { dispose: vi.fn() },
		ui: { requestRender: vi.fn() },
		settingsManager: { getShowTerminalProgress: () => false },
		cancelActiveExtensionDialog: vi.fn(),
		disposeActiveSelector: vi.fn(),
		clearStatusIndicator: vi.fn(),
		themeController: { disableAutoSync: vi.fn() },
		clearExtensionTerminalInputListeners: vi.fn(),
		stopInteractiveTui: vi.fn(),
		unregisterSignalHandlers: vi.fn(),
		refreshOpenAIUsage(invalidate = false) {
			refreshUsage.call(context, invalidate);
		},
	};
	return context;
}

describe("InteractiveMode OpenAI allowance lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv("PI_OFFLINE", "0");
		vi.spyOn(OpenAICodexUsageController.prototype, "refresh").mockResolvedValue();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("refreshes asynchronously for a non-OpenAI main model and owns one timer", async () => {
		const context = createContext();
		const setContext = vi.spyOn(OpenAICodexUsageController.prototype, "setContext");
		context.refreshOpenAIUsage();
		expect(setContext).toHaveBeenCalledWith({
			sessionId: "session-a",
			providerId: "anthropic",
			modelId: "other-main-model",
		});
		expect(vi.getTimerCount()).toBe(1);
		context.refreshOpenAIUsage();
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(OpenAICodexUsageController.prototype.refresh).toHaveBeenCalledTimes(3);
		expect(context.footer.setOpenAIUsage).toHaveBeenCalled();
	});

	it("does not create requests or timers offline or after shutdown starts", () => {
		const context = createContext();
		vi.stubEnv("PI_OFFLINE", "true");
		context.refreshOpenAIUsage();
		vi.stubEnv("PI_OFFLINE", "0");
		context.isShuttingDown = true;
		context.refreshOpenAIUsage();
		expect(OpenAICodexUsageController.prototype.refresh).not.toHaveBeenCalled();
		expect(context.openAIUsageController).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("invalidates the cached account after an authentication change", () => {
		const context = createContext();
		const invalidate = vi.spyOn(OpenAICodexUsageController.prototype, "invalidate");
		context.refreshOpenAIUsage(true);
		expect(invalidate).toHaveBeenCalledOnce();
	});

	it("cancels the old controller and ignores its late result after a session switch", async () => {
		let finishOld: () => void = () => {};
		vi.mocked(OpenAICodexUsageController.prototype.refresh).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishOld = resolve;
				}),
		);
		const context = createContext();
		context.refreshOpenAIUsage();
		const oldController = context.openAIUsageController;
		if (!oldController) throw new Error("Controller not created");
		const dispose = vi.spyOn(oldController, "dispose");
		context.session = { ...context.session, sessionId: "session-b" };
		context.refreshOpenAIUsage();
		await Promise.resolve();
		expect(dispose).toHaveBeenCalledOnce();
		expect(context.openAIUsageController).not.toBe(oldController);
		context.footer.setOpenAIUsage.mockClear();
		finishOld();
		await Promise.resolve();
		expect(context.footer.setOpenAIUsage).not.toHaveBeenCalled();
	});

	it("disposes the request controller and timer on CLI stop", async () => {
		const context = createContext();
		context.refreshOpenAIUsage();
		const controller = context.openAIUsageController;
		if (!controller) throw new Error("Controller not created");
		const dispose = vi.spyOn(controller, "dispose");
		stop.call(context, "transcript");
		await Promise.resolve();
		expect(dispose).toHaveBeenCalledOnce();
		expect(context.openAIUsageController).toBeUndefined();
		expect(context.openAIUsageTimer).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		expect(context.isInitialized).toBe(false);
	});
});
