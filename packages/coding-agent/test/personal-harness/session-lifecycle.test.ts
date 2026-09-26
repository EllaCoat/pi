import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../suite/harness.ts";

describe("AgentSession lifecycle events", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			const harness = harnesses.pop()!;
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	it("emits session_abort for an explicit abort while idle", async () => {
		let abortEvents = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_abort", () => {
						abortEvents++;
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.abort();

		expect(abortEvents).toBe(1);
	});

	it("does not start a model request after abort during pre-agent hooks", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const prompting = harness.session.prompt("Pause before sending this request");
		await entered.promise;
		await harness.session.abort();
		release.resolve();
		await prompting;
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("awaits shutdown handlers and makes repeated dispose calls share one cleanup", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let shutdownEvents = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", async () => {
						shutdownEvents++;
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);

		const first = harness.session.dispose();
		const second = harness.session.dispose();
		try {
			expect(second).toBe(first);
			await entered.promise;
			expect(shutdownEvents).toBe(1);
		} finally {
			release.resolve();
		}
		await Promise.all([first, second]);
		expect(shutdownEvents).toBe(1);
	});
});
