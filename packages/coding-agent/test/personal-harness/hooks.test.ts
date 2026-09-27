import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "../../src/core/extensions/types.ts";
import {
	applyContextProjection,
	CONTEXT_PRUNE_ENTRY,
	CONTEXT_PRUNE_MARKER,
	collectContextCandidates,
	evaluateContextCandidates,
	IMAGE_PROJECTION_ENTRY,
	LIGHT_COMPACT_ENTRY,
	legacyProjection,
} from "../../src/personal-harness/hooks/context-prune.ts";
import { installHooks } from "../../src/personal-harness/hooks/index.ts";
import { buildAdviceContext } from "../../src/personal-harness/hooks/input-advice.ts";
import type {
	JevEvaluationInput,
	JevEvaluationResponse,
	JevEvaluator,
} from "../../src/personal-harness/hooks/jev-types.ts";
import {
	collectRead,
	READ_ENTRY,
	type ReadObservationEvent,
	rankCandidates,
} from "../../src/personal-harness/hooks/reread.ts";
import { TODO_SESSION_ENTRY_TYPE } from "../../src/personal-harness/todo/state.ts";
import { HarnessUsageLedger } from "../../src/personal-harness/usage.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("personal harness hooks", () => {
	it("projects only selected tool-result spans and restores earlier light/image markers", async () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-old", name: "read" },
					{ type: "toolCall", id: "call-new", name: "read" },
				],
			},
			{
				role: "toolResult",
				toolCallId: "call-old",
				toolName: "read",
				isError: false,
				content: [
					{
						type: "text",
						text: "an older result with useful detail and enough context to exceed the fixed omission marker safely",
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "call-new",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "the newest result remains visible" }],
			},
		];
		const gathered = collectContextCandidates(messages);
		expect(gathered.candidates).toHaveLength(1);
		const candidate = gathered.candidates[0]!;
		const evaluate: JevEvaluator = async (input: JevEvaluationInput): Promise<JevEvaluationResponse> => {
			const id = Object.keys(input.questions)[0]!;
			return {
				model: "jev-latest",
				answers: {
					[id]: {
						type: "choice",
						choice: "omit",
						confidence: 0.95,
						probabilities: { keep: 0.02, omit: 0.96, uncertain: 0.02 },
					},
				},
				usage: { input_tokens: 40, output_tokens: 3 },
			};
		};
		const decision = await evaluateContextCandidates(
			messages,
			gathered.candidates,
			evaluate,
			new AbortController().signal,
		);
		expect(decision.selected.map((item) => item.id)).toEqual([candidate.id]);
		const projected = applyContextProjection(messages, [candidate]);
		expect(projected[1]).toMatchObject({ content: [{ text: expect.stringContaining(CONTEXT_PRUNE_MARKER) }] });
		expect(messages[1]).toMatchObject({
			content: [
				{
					text: "an older result with useful detail and enough context to exceed the fixed omission marker safely",
				},
			],
		});

		const imageData = "iVBORw0KGgo=";
		const imageMessage = {
			role: "toolResult",
			toolCallId: "screen-call",
			toolName: "screen",
			content: [{ type: "image", mimeType: "image/png", data: imageData }],
		};
		const oldText = "older repeated output";
		const lightHash = createHash("sha256")
			.update(JSON.stringify([oldText]))
			.digest("hex");
		const imageHash = createHash("sha256").update("image/png").update("\0").update(imageData).digest("hex");
		const restored = legacyProjection(
			[
				{
					role: "toolResult",
					toolCallId: "move-call",
					toolName: "move",
					content: [{ type: "text", text: oldText }],
				},
				imageMessage,
			],
			[
				{
					type: "custom",
					customType: LIGHT_COMPACT_ENTRY,
					data: { version: 1, targets: [{ callId: "move-call", toolName: "move", fingerprint: lightHash }] },
				},
				{
					type: "custom",
					customType: IMAGE_PROJECTION_ENTRY,
					data: {
						version: 1,
						targets: [
							{
								callId: "screen-call",
								toolName: "screen",
								blockIndex: 0,
								hash: imageHash,
								replacement: "[image omitted: old screen]",
							},
						],
					},
				},
			],
		);
		expect(restored[0]).toMatchObject({ content: [{ text: "[omitted duplicate]" }] });
		expect(restored[1]).toMatchObject({ content: [{ text: "[image omitted: old screen]" }] });
	});

	it("keeps input advice bound to raw input and excludes likely credentials", () => {
		const expanded = "Use the skill body from C:\\skills\\test\\SKILL.md";
		const rawInput = "/skill:test inspect the handler";
		const entries = [{ type: "message", id: "user-entry", message: { role: "user", content: expanded } }];
		const prepared = buildAdviceContext(
			entries,
			"Please inspect the handler",
			5,
			false,
			new Map([["user-entry", rawInput]]),
		);
		expect(prepared.status).toBe("ready");
		if (prepared.status === "ready") {
			expect(prepared.input.questions).toHaveProperty("outcome");
			expect(JSON.stringify(prepared.input.state)).toContain(rawInput);
			expect(JSON.stringify(prepared.input.state)).not.toContain(expanded);
		}
		const unavailable = buildAdviceContext(entries, "Please inspect the handler");
		expect(unavailable.status).toBe("ready");
		if (unavailable.status === "ready") {
			expect(JSON.stringify(unavailable.input.state)).toContain("[本人入力の出自未確認");
			expect(JSON.stringify(unavailable.input.state)).not.toContain(expanded);
		}
		const sensitiveHistory = buildAdviceContext(
			entries,
			"Please inspect the handler",
			5,
			false,
			new Map([["user-entry", "api_key=sk-0123456789abcdefghijk"]]),
		);
		expect(JSON.stringify(sensitiveHistory)).not.toContain("sk-0123456789abcdefghijk");
		expect(buildAdviceContext([], "api_key=sk-0123456789abcdefghijk").status).toBe("sensitive");
	});

	it("stores only read metadata and ranks eligible rereads against the latest TODO", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-hook-reread-"));
		try {
			const sourcePath = join(root, "source.ts");
			const sourceText = "const important = 1;\nexport { important };";
			await writeFile(sourcePath, sourceText, "utf8");
			const event: ReadObservationEvent = {
				toolName: "read",
				toolCallId: "read-call",
				input: { path: "source.ts" },
				details: { resolvedPath: sourcePath, displayContent: { text: sourceText, lineNumbers: [1, 2] } },
				isError: false,
			};
			const observations = await collectRead(event, root, [root]);
			expect(observations).toHaveLength(1);
			expect(JSON.stringify(observations)).not.toContain(sourceText);
			const entries = [
				{ type: "message", id: "user-1", message: { role: "user", content: "Investigate the module safely" } },
				{
					type: "custom",
					id: "todo-1",
					customType: TODO_SESSION_ENTRY_TYPE,
					data: { items: [{ id: "todo-1", title: "Check the module contract", status: "in_progress" }] },
				},
				{ type: "custom", id: "read-1", customType: READ_ENTRY, data: observations[0] },
			] as unknown as SessionEntry[];
			const evaluate: JevEvaluator = async (input: JevEvaluationInput): Promise<JevEvaluationResponse> => {
				const id = Object.keys(input.questions)[0]!;
				return {
					model: "jev-latest",
					answers: {
						[id]: { type: "score", score: 4, legend: { low: "not needed", high: "needed" }, confidence: 0.9 },
					},
					usage: { input_tokens: 20, output_tokens: 2 },
				};
			};
			const ranking = await rankCandidates({
				entries,
				snapshot: "read-1",
				roots: [root],
				evaluate,
				signal: new AbortController().signal,
			});
			expect(ranking.status).toBe("ranked");
			expect(ranking.selections).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

it("runs light compaction evaluation only when explicitly invoked", async () => {
	const handlers = new Map<string, unknown[]>();
	const commands = new Map<string, RegisteredCommand["handler"]>();
	const appendEntry = vi.fn();
	const pi = {
		on(name: string, handler: unknown) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
			return () => undefined;
		},
		registerCommand(name: string, options: { handler: RegisteredCommand["handler"] }) {
			commands.set(name, options.handler);
		},
		appendEntry,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => undefined,
		sendUserMessage: () => undefined,
	} as unknown as ExtensionAPI;
	const release = vi.fn();
	const hold = vi.fn(() => release);
	const evaluate: JevEvaluator = vi.fn(async (input: JevEvaluationInput): Promise<JevEvaluationResponse> => {
		const id = Object.keys(input.questions)[0]!;
		return {
			model: "jev-latest",
			answers: {
				[id]: {
					type: "choice",
					choice: "omit",
					confidence: 0.95,
					probabilities: { keep: 0.02, omit: 0.96, uncertain: 0.02 },
				},
			},
			usage: { input_tokens: 40, output_tokens: 3 },
		};
	});
	installHooks(pi, { evaluate, hold, ledger: new HarnessUsageLedger() });

	const assistant = fauxAssistantMessage("read results");
	assistant.content = [
		{ type: "toolCall", id: "call-old", name: "read", arguments: { path: "old.ts" } },
		{ type: "toolCall", id: "call-new", name: "read", arguments: { path: "new.ts" } },
	];
	const messages: AgentMessage[] = [
		assistant,
		{
			role: "toolResult",
			toolCallId: "call-old",
			toolName: "read",
			isError: false,
			content: [
				{
					type: "text",
					text: "an older result with useful detail and enough context to exceed the fixed omission marker safely",
				},
			],
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call-new",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "the newest result remains visible" }],
			timestamp: 3,
		},
	];
	const branch: SessionEntry[] = [
		{
			type: "message",
			id: "leaf-1",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			message: { role: "user", content: "Continue this task", timestamp: 1 },
		},
	];
	const context = {
		cwd: process.cwd(),
		ui: { notify: vi.fn() },
		sessionManager: {
			getSessionId: () => "session-1",
			getLeafId: () => "leaf-1",
			getBranch: () => branch,
			getHeader: () => null,
			buildSessionProjection: () => ({ messages }),
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;

	const contextHandler = handlers.get("context")?.[0] as
		| ((event: ContextEvent, context: ExtensionContext) => ContextEventResult | undefined)
		| undefined;
	expect(contextHandler).toBeDefined();
	contextHandler?.({ type: "context", messages }, context);
	expect(evaluate).not.toHaveBeenCalled();

	const lightCompact = commands.get("light-compact");
	expect(lightCompact).toBeDefined();
	await lightCompact?.("", context as unknown as ExtensionCommandContext);
	expect(evaluate).toHaveBeenCalledTimes(1);
	expect(appendEntry).toHaveBeenCalledWith(
		CONTEXT_PRUNE_ENTRY,
		expect.objectContaining({ sessionId: "session-1", sourceLeafId: "leaf-1" }),
	);
	expect(release).toHaveBeenCalledTimes(1);
});

it("injects lifecycle context without starting a model turn and keeps time after user input", async () => {
	const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
	const sendMessage = vi.fn();
	const api = {
		on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: vi.fn(),
		sendMessage,
	} as unknown as ExtensionAPI;
	const lifecycleContext = vi.fn((event: "session_start" | "session_compact") => `Lifecycle: ${event}`);
	installHooks(api, {
		evaluate: async () => {
			throw new Error("not used");
		},
		hold: () => () => {},
		ledger: new HarnessUsageLedger(),
		lifecycleContext,
		dynamicTurnContext: () => "Current time fixture",
	});
	const context = { sessionManager: { getHeader: () => null } } as unknown as ExtensionContext;
	for (const name of ["session_start", "session_compact"]) await handlers.get(name)![0]({}, context);
	expect(sendMessage.mock.calls).toEqual([
		[
			{ customType: "personal-harness-lifecycle-context", content: "Lifecycle: session_start", display: false },
			{ triggerTurn: false },
		],
		[
			{ customType: "personal-harness-lifecycle-context", content: "Lifecycle: session_compact", display: false },
			{ triggerTurn: false },
		],
	]);
	const turn = await handlers.get("before_agent_start")![0]({ systemPromptOptions: {} }, context);
	expect(turn).toEqual({
		message: { customType: "personal-harness-turn-context", content: "Current time fixture", display: false },
	});
});
