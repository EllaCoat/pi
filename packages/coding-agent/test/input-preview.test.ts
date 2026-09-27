import { dispatchMouseEvent, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ToolContentPreview } from "../src/modes/interactive/components/input-preview.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const click: TuiMouseEvent = {
	type: "click",
	button: "left",
	x: 1,
	y: 2,
	screenX: 5,
	screenY: 6,
	width: 20,
	height: 12,
	shift: false,
	alt: false,
	ctrl: false,
};

describe("tool content preview mouse delegation", () => {
	beforeAll(() => initTheme("axia"));

	it("preserves the concrete child's focus and capture targets", () => {
		const child = {
			focused: false,
			render: () => Array.from({ length: 14 }, (_, index) => `row ${index}`),
			invalidate: vi.fn(),
			handleMouse: vi.fn(() => ({ focus: true, capture: true })),
			handleInput: vi.fn(),
		};
		const preview = new ToolContentPreview(child, false);
		preview.render(20);
		const result = dispatchMouseEvent(preview, click);
		expect(result?.focusTarget).toBe(child);
		expect(result?.target.component).toBe(child);
		expect(result?.capture).toBe(true);
		result?.focusTarget?.handleInput?.("x");
		expect(child.handleInput).toHaveBeenCalledWith("x");
	});

	it("does not route the expansion hint into the clipped child", () => {
		const child = {
			render: () => Array.from({ length: 14 }, () => "row"),
			invalidate: vi.fn(),
			handleMouse: vi.fn(() => ({ focus: true })),
		};
		const preview = new ToolContentPreview(child, false);
		preview.render(20);
		expect(dispatchMouseEvent(preview, { ...click, y: 10 })).toBeUndefined();
		expect(child.handleMouse).not.toHaveBeenCalled();
	});
});
