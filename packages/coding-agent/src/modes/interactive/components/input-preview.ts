import {
	type Component,
	dispatchMouseEvent,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

const DEFAULT_PREVIEW_LINES = 10;

/** Keep multiline code readable without executing terminal control bytes. */
export function formatToolInput(args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return JSON.stringify(args, null, 2) ?? "";
	return Object.entries(args)
		.map(([name, value]) => {
			if (typeof value === "string" && value.includes("\n")) {
				const printable = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (character) =>
					JSON.stringify(character).slice(1, -1),
				);
				return `${JSON.stringify(name)}:\n${printable
					.split("\n")
					.map((line) => `  ${line}`)
					.join("\n")}`;
			}
			return `${JSON.stringify(name)}: ${JSON.stringify(value, null, 2)}`;
		})
		.join("\n");
}

export class ToolContentPreview implements Component {
	private visibleLines = 0;
	private readonly content: Component;
	private readonly expanded: boolean;
	private readonly kind: "input" | "output" | "rendered-output";

	constructor(content: Component, expanded: boolean, kind: "input" | "output" | "rendered-output" = "input") {
		this.content = content;
		this.expanded = expanded;
		this.kind = kind;
	}

	render(width: number): string[] {
		const lines = this.content.render(width);
		if (lines.length <= DEFAULT_PREVIEW_LINES) {
			this.visibleLines = lines.length;
			return lines;
		}
		this.visibleLines = this.expanded ? lines.length : DEFAULT_PREVIEW_LINES;
		const hiddenLines = lines.length - this.visibleLines;
		// Specialized renderers may already summarize their original content.
		const hidden =
			this.kind === "input"
				? "more input lines"
				: this.kind === "rendered-output"
					? "more output lines"
					: `${hiddenLines} more lines`;
		const hint = this.expanded
			? `(${keyHint("app.tools.expand", "to collapse")})`
			: `${theme.fg("muted", `... ${hidden} (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		return [...lines.slice(0, this.visibleLines), ...new Text(hint, 0, 0).render(Math.max(1, width))];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y < 0 || event.y >= this.visibleLines) return undefined;
		return dispatchMouseEvent(this.content, event);
	}

	invalidate(): void {
		this.content.invalidate();
	}
}
