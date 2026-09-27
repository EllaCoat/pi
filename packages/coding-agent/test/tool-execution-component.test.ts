import { resetCapabilitiesCache, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { formatToolInput } from "../src/modes/interactive/components/input-preview.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent input and output previews", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		resetCapabilitiesCache();
	});

	test("collapses long shell command input at narrow widths and expands it with output", () => {
		const command = `echo SHELL_INPUT_START ${"segment ".repeat(40)}SHELL_INPUT_END`;
		const component = new ToolExecutionComponent(
			"bash",
			"tool-shell-input-collapse",
			{ command },
			{},
			withBuiltInRenderers("bash", undefined),
			createFakeTui(),
			process.cwd(),
		);
		const output = [
			"SHELL_OUTPUT_START",
			...Array.from({ length: 12 }, (_, index) => `output-${index + 1}`),
			"SHELL_OUTPUT_END",
		].join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false });

		const collapsed = stripAnsi(component.render(28).join("\n"));
		expect(collapsed).toContain("SHELL_INPUT_START");
		expect(collapsed).not.toContain("SHELL_INPUT_END");
		expect(collapsed).toContain("more input lines");
		expect(collapsed).not.toContain("SHELL_OUTPUT_START");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(28).join("\n"));
		expect(expanded).toContain("SHELL_INPUT_END");
		expect(expanded).toContain("SHELL_OUTPUT_START");
		expect(expanded).toContain("SHELL_OUTPUT_END");
		expect(expanded).toContain("to collapse");
	});

	test("collapses standalone multiline shell commands until expanded", () => {
		const command = [
			"echo BASH_INPUT_START",
			...Array.from({ length: 12 }, (_, index) => `echo step-${index + 1} ${"value ".repeat(4)}`),
			"echo BASH_INPUT_END",
		].join("\n");
		const component = new BashExecutionComponent(command, createFakeTui());

		const collapsed = stripAnsi(component.render(28).join("\n"));
		expect(collapsed).toContain("BASH_INPUT_START");
		expect(collapsed).not.toContain("BASH_INPUT_END");
		expect(collapsed).toMatch(/to\s+expand/);

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(28).join("\n"));
		expect(expanded).toContain("BASH_INPUT_END");
		expect(expanded).toMatch(/to\s+collapse/);
	});

	test("uses the generic fallback for long eval arguments and preserves streamed results", () => {
		const short = new ToolExecutionComponent(
			"eval",
			"eval-short",
			{ language: "javascript", code: `console.log("short")` },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const shortText = stripAnsi(short.render(120).join("\n"));
		expect(shortText).toContain("short");
		expect(shortText).not.toContain("more input lines");

		for (const language of ["javascript", "python"] as const) {
			const inputTail = `${language}-input-tail`;
			const codeLines = Array.from({ length: 16 }, (_, index) =>
				language === "python"
					? `print("line-${index + 1} value-${"long ".repeat(3)}")`
					: `console.log("line-${index + 1} value-${"long ".repeat(3)}");`,
			);
			const code = `${codeLines.join("\n")}\n${language === "python" ? "# " : "// "}${inputTail}`;
			const component = new ToolExecutionComponent(
				"eval",
				`eval-${language}`,
				{ language, code: "partial input" },
				{},
				undefined,
				createFakeTui(),
				process.cwd(),
			);

			component.updateArgs({ language, code });
			component.updateResult({ content: [{ type: "text", text: "streaming output" }], isError: false }, true);
			const streaming = stripAnsi(component.render(28).join("\n"));
			expect(streaming).toMatch(/more\s+input\s+lines/);
			expect(streaming).not.toContain(inputTail);
			expect(streaming).toContain("streaming output");

			const outputTail = `${language}-output-tail`;
			const finalOutput = [
				"evaluation failed",
				...Array.from({ length: 12 }, (_, index) => `result-${index + 1}`),
				outputTail,
			].join("\n");
			component.updateResult({ content: [{ type: "text", text: finalOutput }], isError: true });
			const failed = stripAnsi(component.render(28).join("\n"));
			expect(failed).toContain("evaluation failed");
			expect(failed).not.toContain(outputTail);

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(28).join("\n"));
			expect(expanded).toContain(inputTail);
			expect(expanded).toContain(outputTail);
			expect(expanded).toMatch(/to\s+collapse/);
		}
	});

	test("reveals full arguments omitted by a specialized call renderer", () => {
		const args = { operation: "edit", oldText: "ORIGINAL_INPUT", newText: "NEW_INPUT\nSECOND_INPUT_LINE" };
		const saved = JSON.stringify(args);
		const definition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom summary", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"full-input",
			args,
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("ORIGINAL_INPUT");
		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("custom summary");
		expect(expanded).toContain("Input arguments");
		expect(expanded).toContain("ORIGINAL_INPUT");
		expect(expanded).toContain("SECOND_INPUT_LINE");
		expect(JSON.stringify(args)).toBe(saved);
	});

	test("renders multiline code as lines and escapes terminal controls without changing arguments", () => {
		const args = { code: "first line\nsecond line\n\u001b[2J", language: "js" };
		const saved = JSON.stringify(args);
		const formatted = formatToolInput(args);
		expect(formatted).toContain("first line\n  second line");
		expect(formatted).not.toContain("\u001b");
		expect(formatted).toContain("\\u001b");
		expect(JSON.stringify(args)).toBe(saved);
	});

	test("collapses a long one-line eval result by terminal width", () => {
		const component = new ToolExecutionComponent(
			"eval",
			"single-line-output",
			{ code: "display(value)" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const output = `OUTPUT_START ${"x".repeat(2_000)} OUTPUT_END`;
		component.updateResult({ content: [{ type: "text", text: output }], isError: false });
		const collapsed = stripAnsi(component.render(40).join("\n"));
		expect(collapsed).toContain("OUTPUT_START");
		expect(collapsed).not.toContain("OUTPUT_END");
		expect(collapsed).toContain("more lines");
		expect(component.render(40).length).toBeLessThan(25);
		component.setExpanded(true);
		expect(stripAnsi(component.render(40).join("\n"))).toContain("OUTPUT_END");
	});

	test("reveals retained successful write output in the expanded view", () => {
		const component = new ToolExecutionComponent(
			"write",
			"write-output",
			{ path: "fixture.txt", content: "fixture" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "WRITE_RESULT_RETAINED" }], isError: false });
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("WRITE_RESULT_RETAINED");
		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("WRITE_RESULT_RETAINED");
	});

	test("reveals grep flags and failed edit input rather than only renderer summaries", () => {
		const cases = [
			{
				name: "grep",
				args: { pattern: "needle", path: ".", ignoreCase: true, literal: true, context: 3 },
				expected: ["ignoreCase", "literal", "context"],
			},
			{
				name: "edit",
				args: { path: "missing-fixture.txt", oldText: "OLD_EDIT_INPUT", newText: "NEW_EDIT_INPUT" },
				expected: ["OLD_EDIT_INPUT", "NEW_EDIT_INPUT"],
			},
		];
		for (const entry of cases) {
			const definition = withBuiltInRenderers(entry.name, createBaseToolDefinition(entry.name));
			const component = new ToolExecutionComponent(
				entry.name,
				`${entry.name}-arguments`,
				entry.args,
				{},
				definition,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult({
				content: [{ type: "text", text: "retained result" }],
				isError: entry.name === "edit",
			});
			component.setExpanded(true);
			const text = stripAnsi(component.render(120).join("\n"));
			for (const expected of entry.expected) expect(text).toContain(expected);
			expect(text).toContain("retained result");
		}
	});

	test("reveals full output even when a custom shell renderer omits it", () => {
		const definition: ToolDefinition = {
			...createBaseToolDefinition("bash"),
			renderResult: () => new Text("custom shell summary", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"bash",
			"overridden-shell-result",
			{ command: "true" },
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "RAW_SHELL_OUTPUT" }], isError: false });
		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("RAW_SHELL_OUTPUT");
	});

	test("does not claim an original input line count after a specialized write preview", () => {
		const content = Array.from({ length: 100 }, (_, index) => `WRITE_INPUT_${index + 1}`).join("\n");
		const component = new ToolExecutionComponent(
			"write",
			"write-many-lines",
			{ path: "fixture.txt", content },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("more input lines");
		expect(collapsed).not.toMatch(/\d+ more input lines/);
		expect(collapsed).not.toContain("WRITE_INPUT_100");
		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("WRITE_INPUT_100");
	});

	test("collapses a standard grep single-line result by visible width", () => {
		const definition = withBuiltInRenderers("grep", createBaseToolDefinition("grep"));
		const component = new ToolExecutionComponent(
			"grep",
			"grep-wide-result",
			{ pattern: "x", path: "." },
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		const output = `fixture.txt:1: ${"x".repeat(450)} MATCH_END`;
		expect(output.length).toBeLessThan(500);
		component.updateResult({ content: [{ type: "text", text: output }], isError: false });
		const collapsed = stripAnsi(component.render(30).join("\n"));
		expect(collapsed).not.toContain("MATCH_END");
		expect(collapsed).toMatch(/more\s+output\s+lines/);
		component.setExpanded(true);
		expect(stripAnsi(component.render(30).join("\n")).replace(/\s/g, "")).toContain("MATCH_END");
	});
});
