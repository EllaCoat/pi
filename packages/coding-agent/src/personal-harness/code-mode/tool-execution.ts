import type { CodeModeToolExecution } from "./types.ts";

const MEMORY_RECALL_ACTIONS: Record<string, true> = { read: true, search: true, recall: true };
const NAMED_MEMORY_RECALL = /^memory[._:/-](?:read|search|recall)$/i;

export function describeToolExecution(name: string, args: unknown, result: unknown): CodeModeToolExecution {
	const isError = typeof result === "object" && result !== null && "isError" in result && result.isError === true;
	return {
		name,
		status: isError ? "failure" : "success",
		harnessDerivedRecall: hasDerivedRecallMarker(result) || (!isError && isDerivedRecallCall(name, args)),
	};
}

export function isDerivedRecallCall(name: string, args: unknown): boolean {
	if (name === "recall" || NAMED_MEMORY_RECALL.test(name)) return true;
	if (
		name !== "memory" ||
		typeof args !== "object" ||
		args === null ||
		!("action" in args) ||
		typeof args.action !== "string"
	) {
		return false;
	}
	return Object.hasOwn(MEMORY_RECALL_ACTIONS, args.action);
}

export function hasDerivedRecallMarker(value: unknown): boolean {
	if (typeof value !== "object" || value === null || !("details" in value)) return false;
	const details = value.details;
	return (
		typeof details === "object" &&
		details !== null &&
		"harnessDerivedRecall" in details &&
		details.harnessDerivedRecall === true
	);
}
