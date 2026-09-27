import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CodeModeExecutionResult,
	type CodeModeOutputType,
	type CodeModeSessionManager,
	createCodeModeSessionManager,
} from "../../src/personal-harness/code-mode/index.ts";

const managers: CodeModeSessionManager[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createSession(
	id: string,
	dispatcher: (name: string, args: unknown, signal: AbortSignal) => unknown | Promise<unknown> = () => undefined,
) {
	const manager = createCodeModeSessionManager({ dispatcher });
	managers.push(manager);
	return manager.createSession(id);
}

function outputsOfType(result: CodeModeExecutionResult, type: CodeModeOutputType): unknown[] {
	return result.outputs.filter((output) => output.type === type).map((output) => output.data);
}

describe("personal harness Code Mode", () => {
	it("excludes an explicit parent reply wait from the cell deadline and resumes timing afterwards", async () => {
		const entered = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<string>();
		const session = createSession("parent-reply", async () => {
			const release = session.pauseTimeout();
			entered.resolve();
			try {
				return await reply.promise;
			} finally {
				release();
			}
		});
		await session.execute("javascript", "1");
		const pending = session.execute("javascript", "await tool.parent_reply({})", { timeoutMs: 200 });
		await entered.promise;
		await new Promise((resolve) => setTimeout(resolve, 300));
		reply.resolve("reply received");
		const result = await pending;
		expect(result.error).toBeUndefined();
		expect(outputsOfType(result, "result")).toEqual(["reply received"]);
		const resumed = await session.execute(
			"javascript",
			"await tool.parent_reply({}); await new Promise(resolve=>setTimeout(resolve,400));",
			{ timeoutMs: 200 },
		);
		expect(resumed.interrupted).toBe(true);
		expect(resumed.error?.name).toBe("TimeoutError");
	});

	it("keeps JavaScript bindings, supports top-level await, and routes parallel tools through the dispatcher", async () => {
		const calls: Array<{ name: string; args: unknown; signal: AbortSignal }> = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const toolGate = Promise.withResolvers<void>();
		const bothToolCallsStarted = Promise.withResolvers<void>();
		const session = createSession("javascript", async (name, args, signal) => {
			calls.push({ name, args, signal });
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			if (inFlight === 2) bothToolCallsStarted.resolve();
			await toolGate.promise;
			inFlight -= 1;
			return { name, args };
		});

		const first = await session.execute(
			"javascript",
			'const retained = await Promise.resolve(40); print("ready"); retained + 2',
		);
		expect(outputsOfType(first, "stdout").join("")).toContain("ready");
		expect(outputsOfType(first, "result")).toEqual([42]);
		const next = await session.execute("javascript", "retained + 1");
		expect(next.toolExecutions).toEqual([]);
		expect(outputsOfType(next, "result")).toEqual([41]);

		const parallelExecution = session.execute(
			"javascript",
			"await Promise.all([tool.left({ value: 1 }), tool.right({ value: 2 })])",
		);
		await bothToolCallsStarted.promise;
		toolGate.resolve();
		const parallel = await parallelExecution;
		const dependent = await session.execute(
			"javascript",
			"const prepared = await tool.prepare({ id: 3 }); await tool.consume({ previous: prepared.name })",
		);
		expect(outputsOfType(dependent, "result")).toEqual([{ name: "consume", args: { previous: "prepare" } }]);
		expect(dependent.toolExecutions.map(({ name, status }) => `${name}:${status}`).sort()).toEqual([
			"consume:success",
			"prepare:success",
		]);
		expect(outputsOfType(parallel, "result")).toEqual([
			[
				{ name: "left", args: { value: 1 } },
				{ name: "right", args: { value: 2 } },
			],
		]);
		expect(parallel.toolExecutions.map(({ name, status }) => `${name}:${status}`).sort()).toEqual([
			"left:success",
			"right:success",
		]);
		expect(parallel.harnessDerivedRecall).toBe(false);
		expect(calls.map((call) => call.name)).toEqual(["left", "right", "prepare", "consume"]);
		expect(calls.map((call) => call.args)).toEqual([{ value: 1 }, { value: 2 }, { id: 3 }, { previous: "prepare" }]);
		expect(calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
		expect(maxInFlight).toBe(2);
	});

	it("keeps Python bindings and transfers structured image bytes through async tools", async () => {
		const bytes = new Uint8Array([0, 1, 127, 255]);
		const session = createSession("python", async (name, args) => ({
			name,
			args,
			image: { mimeType: "image/png", data: bytes },
		}));
		const first = await session.execute(
			"python",
			'import asyncio\nretained = await asyncio.sleep(0, result=40)\nprint("ready")\nretained + 2',
		);
		expect(outputsOfType(first, "stdout").join("")).toContain("ready");
		expect(outputsOfType(first, "result")).toEqual([42]);
		const next = await session.execute("python", "retained + 1");
		expect(outputsOfType(next, "result")).toEqual([41]);
		expect(next.toolExecutions).toEqual([]);

		const image = await session.execute("python", "image = await tool.fetchImage({'id': 7})\ndisplay(image)\nimage");
		expect(image.error?.message).toBeUndefined();
		const displayed = outputsOfType(image, "display")[0] as { image: { data: Uint8Array } };
		const returned = outputsOfType(image, "result")[0] as { args: { id: number }; image: { data: Uint8Array } };
		expect(displayed.image.data).toBeInstanceOf(Uint8Array);
		expect([...displayed.image.data]).toEqual([...bytes]);
		expect(returned.args).toEqual({ id: 7 });
		expect([...returned.image.data]).toEqual([...bytes]);
		const gathered = await session.execute(
			"python",
			"await asyncio.gather(tool.first({'id': 1}), tool.second({'id': 2}))",
		);
		expect(outputsOfType(gathered, "result")).toEqual([
			[
				{ name: "first", args: { id: 1 }, image: { mimeType: "image/png", data: bytes } },
				{ name: "second", args: { id: 2 }, image: { mimeType: "image/png", data: bytes } },
			],
		]);
		expect(gathered.toolExecutions.map(({ name, status }) => `${name}:${status}`).sort()).toEqual([
			"first:success",
			"second:success",
		]);
	});

	it("keeps error-shaped tool results recoverable and records nested failures separately", async () => {
		const failure = {
			content: [{ type: "text", text: "Tool rejected" }],
			details: { retained: true },
			isError: true,
		};
		const session = createSession("tool-failure", () => failure);
		const javascript = await session.execute(
			"javascript",
			'const result = await tool.run({}); display(result); if (!result.isError || !result.details.retained || result.content[0].text !== "Tool rejected") throw new Error("tool result was changed"); "handled"',
		);
		expect(javascript.error).toBeUndefined();
		expect(outputsOfType(javascript, "display")).toEqual([failure]);
		expect(outputsOfType(javascript, "result")).toEqual(["handled"]);
		expect(javascript.toolExecutions).toEqual([{ name: "run", status: "failure", harnessDerivedRecall: false }]);

		const python = await session.execute(
			"python",
			'result = await tool.run({})\ndisplay(result)\nassert result["isError"] and result["details"]["retained"] and result["content"][0]["text"] == "Tool rejected"\n"handled"',
		);
		expect(python.error).toBeUndefined();
		expect(outputsOfType(python, "display")).toEqual([failure]);
		expect(outputsOfType(python, "result")).toEqual(["handled"]);
		expect(python.toolExecutions).toEqual([{ name: "run", status: "failure", harnessDerivedRecall: false }]);
	});

	it("tracks recall tool names across cells on their own persistent kernels", async () => {
		const session = createSession("derived-kernels", (name, args) => ({ name, args }));
		const javascript = await session.execute(
			"javascript",
			'globalThis.recalled = await tool.recall({ query: "prior work" }); recalled.name',
		);
		expect(javascript.harnessDerivedRecall).toBe(true);
		expect(javascript.toolExecutions).toEqual([{ name: "recall", status: "success", harnessDerivedRecall: true }]);
		const laterJavascript = await session.execute("javascript", "recalled.name");
		expect(laterJavascript.harnessDerivedRecall).toBe(true);
		expect(laterJavascript.toolExecutions).toEqual([]);

		const cleanPython = await session.execute("python", "42");
		expect(cleanPython.harnessDerivedRecall).toBe(false);
		const python = await session.execute(
			"python",
			'memory_result = await tool.memory({"action": "search", "query": "prior work"})\nmemory_result["name"]',
		);
		expect(python.harnessDerivedRecall).toBe(true);
		expect(python.toolExecutions).toEqual([{ name: "memory", status: "success", harnessDerivedRecall: true }]);
		const laterPython = await session.execute("python", 'memory_result["name"]');
		expect(laterPython.harnessDerivedRecall).toBe(true);
		expect(laterPython.toolExecutions).toEqual([]);
	});
	it("marks notes search and read as derived recall across Code Mode calls", async () => {
		const session = createSession("derived-notes", (name, args) => ({ name, args }));
		const search = await session.execute(
			"javascript",
			'globalThis.noteSearch = await tool.notes({action: "search", query: "prior work"}); noteSearch.name',
		);
		expect(search.harnessDerivedRecall).toBe(true);
		expect(search.toolExecutions).toEqual([{ name: "notes", status: "success", harnessDerivedRecall: true }]);
		const read = await session.execute("python", 'await tool.notes({"action": "read", "id": "project/example.md"})');
		expect(read.harnessDerivedRecall).toBe(true);
		expect(read.toolExecutions).toEqual([{ name: "notes", status: "success", harnessDerivedRecall: true }]);
		expect((await session.execute("javascript", "noteSearch.name")).harnessDerivedRecall).toBe(true);
	});

	it("honors explicit derived-recall details without tainting memory writes", async () => {
		const marked = createSession("derived-details", () => ({
			details: { harnessDerivedRecall: true },
			value: "prior",
		}));
		const first = await marked.execute("javascript", "await tool.lookup({})");
		expect(first.harnessDerivedRecall).toBe(true);
		expect(first.toolExecutions).toEqual([{ name: "lookup", status: "success", harnessDerivedRecall: true }]);
		expect((await marked.execute("javascript", "1")).harnessDerivedRecall).toBe(true);

		const write = createSession("memory-write", () => ({ value: "saved" }));
		const written = await write.execute("javascript", 'await tool.memory({ action: "correct" })');
		expect(written.harnessDerivedRecall).toBe(false);
		expect(written.toolExecutions).toEqual([{ name: "memory", status: "success", harnessDerivedRecall: false }]);
	});

	it("keeps timed-out, cancelled, and late tool results out of cell metadata", async () => {
		for (const language of ["javascript", "python"] as const) {
			for (const ending of ["timeout", "cancel"] as const) {
				const started = Promise.withResolvers<void>();
				const signalAborted = Promise.withResolvers<void>();
				const lateResult = Promise.withResolvers<unknown>();
				const lateDispatchSettled = Promise.withResolvers<void>();
				const session = createSession(`late-${language}-${ending}`, (_name, _args, signal) => {
					started.resolve();
					signal.addEventListener("abort", () => signalAborted.resolve(), { once: true });
					return lateResult.promise.finally(() => lateDispatchSettled.resolve());
				});
				const warm = await session.execute(language, "6 * 7");
				expect(warm.error).toBeUndefined();
				const controller = new AbortController();
				const pending = session.execute(
					language,
					"await tool.pending({})",
					ending === "timeout" ? { timeoutMs: 250 } : { signal: controller.signal, timeoutMs: 5_000 },
				);
				await started.promise;
				if (ending === "cancel") controller.abort(new Error("cancelled by test"));
				await signalAborted.promise;
				const interrupted = await pending;
				expect(interrupted.interrupted).toBe(true);
				expect(interrupted.toolExecutions).toEqual([
					{ name: "pending", status: "unknown", harnessDerivedRecall: false },
				]);

				lateResult.resolve({ details: { harnessDerivedRecall: true }, value: "arrived too late" });
				await lateDispatchSettled.promise;
				const next = await session.execute(language, "6 * 7");
				expect(next.harnessDerivedRecall).toBe(false);
				expect(next.toolExecutions).toEqual([]);
				expect(interrupted.toolExecutions).toEqual([
					{ name: "pending", status: "unknown", harnessDerivedRecall: false },
				]);
			}
		}
	});

	it("preserves partial effects and errors without replaying a failed cell", async () => {
		const session = createSession("partial");
		const jsFailure = await session.execute(
			"javascript",
			'globalThis.cellRuns = (globalThis.cellRuns ?? 0) + 1; print("before error"); throw new Error("javascript failed")',
		);
		expect(jsFailure.error?.message).toBe("javascript failed");
		expect(outputsOfType(jsFailure, "stdout").join("")).toContain("before error");
		expect(outputsOfType(await session.execute("javascript", "globalThis.cellRuns"), "result")).toEqual([1]);

		const pyFailure = await session.execute(
			"python",
			'cell_runs = globals().get("cell_runs", 0) + 1\nprint("before error")\nraise RuntimeError("python failed")',
		);
		expect(pyFailure.error?.message).toBe("python failed");
		expect(outputsOfType(pyFailure, "stdout").join("")).toContain("before error");
		expect(outputsOfType(await session.execute("python", "cell_runs"), "result")).toEqual([1]);
	});

	it("isolates variables by session and language", async () => {
		const first = createSession("isolation-first");
		const second = createSession("isolation-second");
		expect(
			outputsOfType(await first.execute("javascript", "globalThis.sharedValue = 9; sharedValue"), "result"),
		).toEqual([9]);
		expect(outputsOfType(await second.execute("javascript", "typeof sharedValue"), "result")).toEqual(["undefined"]);
		expect(outputsOfType(await first.execute("python", '"sharedValue" in globals()'), "result")).toEqual([false]);
	});
	it("keeps JavaScript and Python relative files inside each session cwd", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-code-mode-cwd-"));
		temporaryDirectories.push(root);
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		mkdirSync(join(firstCwd, "nested"), { recursive: true });
		mkdirSync(join(secondCwd, "nested"), { recursive: true });
		const manager = createCodeModeSessionManager({ dispatcher: () => undefined });
		managers.push(manager);
		const first = manager.createSession("cwd-first", { cwd: firstCwd });
		const second = manager.createSession("cwd-second", { cwd: secondCwd });
		const parentCwd = process.cwd();
		const defaultCwd = manager.createSession("cwd-default");
		expect(outputsOfType(await defaultCwd.execute("javascript", "process.cwd()"), "result")).toEqual([parentCwd]);
		expect(outputsOfType(await defaultCwd.execute("python", "import os\nos.getcwd()"), "result")).toEqual([
			parentCwd,
		]);

		const firstJavaScript = await first.execute(
			"javascript",
			'const fs = require("node:fs"); fs.writeFileSync("shared.txt", "javascript-first"); fs.readFileSync("shared.txt", "utf8")',
		);
		expect(outputsOfType(firstJavaScript, "result")).toEqual(["javascript-first"]);
		const changedJavaScript = await first.execute(
			"javascript",
			'process.chdir("nested"); require("node:fs").writeFileSync("after-chdir.txt", "first")',
		);
		expect(changedJavaScript.error).toBeUndefined();
		const secondJavaScript = await second.execute(
			"javascript",
			'const fs = require("node:fs"); fs.writeFileSync("shared.txt", "javascript-second"); [fs.readFileSync("shared.txt", "utf8"), process.cwd()]',
		);
		expect(outputsOfType(secondJavaScript, "result")).toEqual([["javascript-second", secondCwd]]);
		expect(readFileSync(join(firstCwd, "shared.txt"), "utf8")).toBe("javascript-first");
		expect(readFileSync(join(firstCwd, "nested", "after-chdir.txt"), "utf8")).toBe("first");
		expect(readFileSync(join(secondCwd, "shared.txt"), "utf8")).toBe("javascript-second");

		const firstPython = await first.execute(
			"python",
			'import os\nwith open("shared.txt", "w") as file:\n    file.write("python-first")\nos.chdir("nested")\nwith open("after-chdir.txt", "w") as file:\n    file.write("first")\nos.getcwd()',
		);
		expect(outputsOfType(firstPython, "result")).toEqual([join(firstCwd, "nested")]);
		const secondPython = await second.execute(
			"python",
			'import os\nwith open("shared.txt", "w") as file:\n    file.write("python-second")\nos.getcwd()',
		);
		expect(outputsOfType(secondPython, "result")).toEqual([secondCwd]);
		expect(readFileSync(join(firstCwd, "shared.txt"), "utf8")).toBe("python-first");
		expect(readFileSync(join(firstCwd, "nested", "after-chdir.txt"), "utf8")).toBe("first");
		expect(readFileSync(join(secondCwd, "shared.txt"), "utf8")).toBe("python-second");
		expect(process.cwd()).toBe(parentCwd);
	});

	it("aborts pending dispatches and resets only the explicitly restarted kernel", async () => {
		const started = Promise.withResolvers<void>();
		let toolAborted = false;
		const session = createSession("restart", (_name, _args, signal) => {
			const deferred = Promise.withResolvers<string>();
			started.resolve();
			signal.addEventListener(
				"abort",
				() => {
					toolAborted = true;
					deferred.resolve("stopped");
				},
				{ once: true },
			);
			return deferred.promise;
		});
		const pending = session.execute("javascript", "await tool.wait({})", { timeoutMs: 5_000 });
		await started.promise;
		await session.restart("javascript");
		const interrupted = await pending;
		expect(interrupted.interrupted).toBe(true);
		expect(toolAborted).toBe(true);
		expect(outputsOfType(await session.execute("javascript", "typeof retained"), "result")).toEqual(["undefined"]);
	});

	it("times out non-yielding kernels without blocking the main thread or hiding prior output", async () => {
		const session = createSession("timeout");
		await session.execute("javascript", "6 * 7");
		const js = await session.execute("javascript", 'print("starting"); while (true) {}', { timeoutMs: 150 });
		expect(js.interrupted).toBe(true);
		expect(js.error?.name).toBe("TimeoutError");
		expect(outputsOfType(js, "stdout").join("")).toContain("starting");
		await session.restart("javascript");
		expect(outputsOfType(await session.execute("javascript", "6 * 7"), "result")).toEqual([42]);

		const python = await session.execute("python", 'print("starting")\nwhile True: pass', { timeoutMs: 800 });
		expect(python.interrupted).toBe(true);
		expect(python.error?.name).toBe("TimeoutError");
		expect(outputsOfType(python, "stdout").join("")).toContain("starting");
		await session.restart("python");
		expect(outputsOfType(await session.execute("python", "6 * 7"), "result")).toEqual([42]);
	});
	it("shutdown interrupts an outstanding Python tool dispatch and closes the session", async () => {
		const started = Promise.withResolvers<void>();
		let toolAborted = false;
		const session = createSession("shutdown", (_name, _args, signal) => {
			const deferred = Promise.withResolvers<string>();
			started.resolve();
			signal.addEventListener(
				"abort",
				() => {
					toolAborted = true;
					deferred.resolve("stopped");
				},
				{ once: true },
			);
			return deferred.promise;
		});
		const pending = session.execute("python", "await tool.wait({'name': 'blocked'})");
		await started.promise;
		await session.shutdown();
		expect((await pending).interrupted).toBe(true);
		expect(toolAborted).toBe(true);
		await expect(session.execute("python", "1")).rejects.toThrow("shut down");
	});
});
