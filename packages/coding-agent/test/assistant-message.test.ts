import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("preserves full assistant and user text at narrow widths", () => {
		initTheme("dark");
		const assistantText = `${"assistant content ".repeat(32)}END`;
		const assistant = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: assistantText }]));
		expect(stripAnsi(assistant.render(18).join("\n"))).toContain("END");

		const userText = `${"user content ".repeat(32)}USEREND`;
		const user = new UserMessageComponent(userText);
		expect(stripAnsi(user.render(18).join("\n"))).toContain("USEREND");
	});

	test("preserves the provider reasoning summary without generating a replacement", () => {
		initTheme("dark");
		const summary = `${"provider summary ".repeat(32)}SUMMARYEND`;
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: summary }]),
		);

		expect(stripAnsi(component.render(18).join("\n"))).toContain("SUMMARYEND");
	});
});
