import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { type Component, Container, type Focusable, type TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type DialogMethods = {
	showExtensionSelector(
		this: InteractiveMode,
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
	showExtensionConfirm(
		this: InteractiveMode,
		title: string,
		message: string,
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<boolean>;
	showExtensionInput(
		this: InteractiveMode,
		title: string,
		placeholder?: string,
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
	showExtensionEditor(this: InteractiveMode, title: string, prefill?: string): Promise<string | undefined>;
	showExtensionCustom<T>(
		this: InteractiveMode,
		factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
		options?: { overlay?: boolean },
	): Promise<T>;
};

const dialogMethods = InteractiveMode.prototype as unknown as DialogMethods;

class TestFocusableComponent implements Component, Focusable {
	focused = false;
	private readonly label: string;
	private text = "";

	constructor(label: string) {
		this.label = label;
	}

	handleInput(_data: string): void {}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}
}

function createInteractiveModeFixture(): {
	mode: InteractiveMode;
	editorContainer: Container;
} {
	const ui: TUI = new TuiMainScreen(new VirtualTerminal(80, 24));
	const editorContainer = new Container();
	const editor = new TestFocusableComponent("EDITOR");
	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	ui.setFocus(editor);

	const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		ui,
		editorContainer,
		editor,
		extensionSelector: undefined,
		extensionInput: undefined,
		extensionEditor: undefined,
		activeExtensionDialogCancel: undefined,
		activeSelectorToken: undefined,
		activeSelectorDispose: undefined,
		keybindings: new KeybindingsManager(),
		runtimeHost: {
			session: {
				settingsManager: { getExternalEditorCommand: () => undefined },
			},
		},
	});

	return { mode, editorContainer };
}

describe("InteractiveMode extension dialog replacement", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());

	test("cancels a pending selector when a confirmation opens and isolates the new selector", async () => {
		vi.useFakeTimers();
		const { mode, editorContainer } = createInteractiveModeFixture();
		const askController = new AbortController();
		const ask = dialogMethods.showExtensionSelector.call(mode, "Ask", ["Proceed"], {
			signal: askController.signal,
			timeout: 1000,
		});
		expect(editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent);

		const confirmation = dialogMethods.showExtensionConfirm.call(mode, "Goal", "Create it?");
		await expect(ask).resolves.toBeUndefined();
		const activeConfirmation = editorContainer.children[0];
		expect(activeConfirmation).toBeInstanceOf(ExtensionSelectorComponent);

		askController.abort();
		await vi.advanceTimersByTimeAsync(1100);
		expect(editorContainer.children[0]).toBe(activeConfirmation);

		if (!(activeConfirmation instanceof ExtensionSelectorComponent)) throw new Error("Confirmation selector missing");
		activeConfirmation.handleInput("\n");
		await expect(confirmation).resolves.toBe(true);
		expect(editorContainer.children[0]).not.toBe(activeConfirmation);
	});

	test("cancels replaced free-text input without allowing its timeout or abort to close the new selector", async () => {
		vi.useFakeTimers();
		const { mode, editorContainer } = createInteractiveModeFixture();
		const inputController = new AbortController();
		const input = dialogMethods.showExtensionInput.call(mode, "Ask", "Answer", {
			signal: inputController.signal,
			timeout: 1000,
		});
		const selection = dialogMethods.showExtensionSelector.call(mode, "Next", ["Continue"]);
		await expect(input).resolves.toBeUndefined();

		const activeSelector = editorContainer.children[0];
		expect(activeSelector).toBeInstanceOf(ExtensionSelectorComponent);
		inputController.abort();
		await vi.advanceTimersByTimeAsync(1100);
		expect(editorContainer.children[0]).toBe(activeSelector);

		if (!(activeSelector instanceof ExtensionSelectorComponent)) throw new Error("Replacement selector missing");
		activeSelector.handleInput("\n");
		await expect(selection).resolves.toBe("Continue");
	});

	test("settles an ask before opening editor or custom extension UI", async () => {
		const { mode, editorContainer } = createInteractiveModeFixture();
		const askController = new AbortController();
		const ask = dialogMethods.showExtensionSelector.call(mode, "Ask", ["Choice"], {
			signal: askController.signal,
		});
		const editor = dialogMethods.showExtensionEditor.call(mode, "Editor");
		await expect(ask).resolves.toBeUndefined();
		const activeEditor = editorContainer.children[0];
		expect(activeEditor).toBeInstanceOf(ExtensionEditorComponent);
		askController.abort();
		expect(editorContainer.children[0]).toBe(activeEditor);

		const inputController = new AbortController();
		const input = dialogMethods.showExtensionInput.call(mode, "Text", "Answer", {
			signal: inputController.signal,
		});
		await expect(editor).resolves.toBeUndefined();
		const activeInput = editorContainer.children[0];
		expect(activeInput).toBeInstanceOf(ExtensionInputComponent);
		if (!(activeInput instanceof ExtensionInputComponent)) throw new Error("Replacement input missing");
		activeInput.handleInput("a");

		let closeCustom: (result: string) => void = () => {
			throw new Error("Custom UI close callback was not initialized");
		};
		const customComponent = new TestFocusableComponent("CUSTOM");
		const custom = dialogMethods.showExtensionCustom.call(mode, (_tui, _theme, _keybindings, done) => {
			closeCustom = done;
			return customComponent;
		});
		await expect(input).resolves.toBeUndefined();
		await Promise.resolve();
		expect(editorContainer.children[0]).toBe(customComponent);
		inputController.abort();
		expect(editorContainer.children[0]).toBe(customComponent);

		closeCustom("closed");
		await expect(custom).resolves.toBe("closed");
	});
});
