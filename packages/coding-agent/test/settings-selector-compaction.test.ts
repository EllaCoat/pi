import { describe, expect, it, vi } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("SettingsSelectorComponent compaction threshold", () => {
	it.each([
		["global selection", undefined, undefined, 50, 50],
		["project override", 80, undefined, 85, 80],
		["Default with project override", 100, 75, undefined, 100],
		["Default without project override", undefined, 100, undefined, undefined],
	] as const)(
		"shows the effective threshold after %s",
		async (_label, projectValue, globalValue, selected, effective) => {
			initTheme("dark");
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ compaction: { thresholdPercent: globalValue } }));
			storage.withLock("project", () => JSON.stringify({ compaction: { thresholdPercent: projectValue } }));
			const manager = SettingsManager.fromStorage(storage);
			const onThresholdChange = vi.fn((value: number | undefined) => {
				manager.setCompactionThresholdPercent(value);
				return manager.getCompactionThresholdPercent();
			});
			const noop = () => {};
			const callbacks = new Proxy(
				{ onCompactionThresholdPercentChange: onThresholdChange } as unknown as SettingsCallbacks,
				{
					get(target, property, receiver) {
						return Reflect.get(target, property, receiver) ?? noop;
					},
				},
			);
			const config: SettingsConfig = {
				autoCompact: true,
				autoCompactThresholdPercent: manager.getCompactionThresholdPercent(),
				defaultModel: "not set",
				availableDefaultModels: [],
				showImages: false,
				imageWidthCells: 60,
				autoResizeImages: true,
				blockImages: false,
				enableSkillCommands: true,
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				transport: "auto",
				httpIdleTimeoutMs: 0,
				cacheWarmingMode: "streaming",
				thinkingLevel: "medium",
				availableThinkingLevels: ["off", "medium"],
				modelThinkingLevels: {},
				currentTheme: "dark",
				terminalTheme: "dark",
				availableThemes: ["dark"],
				hideThinkingBlock: false,
				mermaidRenderingMode: "streaming",
				showCacheMissNotices: false,
				collapseChangelog: false,
				enableInstallTelemetry: true,
				doubleEscapeAction: "tree",
				treeFilterMode: "default",
				showHardwareCursor: false,
				editorPaddingX: 0,
				outputPad: 1,
				autocompleteMaxVisible: 5,
				quietStartup: false,
				defaultProjectTrust: "ask",
				clearOnShrink: false,
				showTerminalProgress: false,
				tuiMode: "regular",
				fullscreenExitOutput: "transcript",
				fullscreenScrollbar: "auto",
				fullscreenCopyOnSelect: true,
				warnings: {},
			};
			const selector = new SettingsSelectorComponent(config, callbacks);
			const settings = selector.getSettingsList();
			settings.selectItem("compaction-threshold");
			settings.handleInput("\r");

			expect(onThresholdChange).toHaveBeenCalledWith(selected);
			const row = settings
				.render(120)
				.map(stripAnsi)
				.find((line) => line.includes("Auto-compact threshold"));
			expect(row).toContain(effective === undefined ? "Default" : `${effective}%`);
			await manager.flush();
			await manager.reload();
			expect(manager.getCompactionThresholdPercent()).toBe(effective);
			const globalManager = SettingsManager.fromStorage(storage, { projectTrusted: false });
			expect(globalManager.getCompactionThresholdPercent()).toBe(selected);
		},
	);
});
