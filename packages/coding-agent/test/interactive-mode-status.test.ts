import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type Expandable = { setExpanded: (expanded: boolean) => void };

type FakeInteractiveMode = {
	toolOutputExpanded: boolean;
	customHeader: undefined;
	builtInHeader: Expandable;
	loadedResourcesContainer: { children: Expandable[] };
	chatContainer: { children: Expandable[] };
	ui: { requestRender: () => void };
	showStatus: (message: string) => void;
};

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to active entries and announces input/output", () => {
		const header = { setExpanded: vi.fn() };
		const loadedResourcesChild = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const fakeThis: FakeInteractiveMode = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			loadedResourcesContainer: { children: [loadedResourcesChild] },
			chatContainer: { children: [chatChild] },
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
		};

		// Access the private method directly to isolate its expansion state transition.
		const interactiveModePrototype = InteractiveMode.prototype as unknown as {
			setToolsExpanded: (this: FakeInteractiveMode, expanded: boolean) => void;
		};
		const setToolsExpanded = interactiveModePrototype.setToolsExpanded;
		setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(loadedResourcesChild.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Tool input/output: expanded");
	});
});
