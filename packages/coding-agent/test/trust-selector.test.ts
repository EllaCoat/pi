import { dirname, resolve } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("TrustSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the saved trusted decision marked while browsing", () => {
		const cwd = resolve("/project");
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: { path: cwd, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		let output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (${cwd})`);
		expect(output).toContain("Current session: trusted");
		expect(output).toContain("→ ✓ Trust");

		selector.handleInput("\x1b[B");
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("✓ Trust");
		expect(output).toContain(`→   Trust parent folder (${dirname(cwd)})`);
		expect(output).not.toContain("✓ Do not trust");
	});

	it("selects a trust decision", () => {
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: resolve("/project"),
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [{ path: resolve("/project"), decision: true }],
		});
	});

	it("labels saved ancestor decisions as inherited", () => {
		const cwd = resolve("/parent/project/nested");
		const savedPath = resolve("/parent");
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: { path: savedPath, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (inherited from ${savedPath})`);
	});

	it("adds a trust parent option", () => {
		const onSelect = vi.fn();
		const parent = resolve("/parent");
		const cwd = resolve(parent, "project");
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: { path: parent, decision: true },
			projectTrusted: true,
			onSelect,
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (inherited from ${parent})`);
		expect(output).toContain(`✓ Trust parent folder (${parent})`);

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [
				{ path: parent, decision: true },
				{ path: cwd, decision: null },
			],
		});
	});
});
