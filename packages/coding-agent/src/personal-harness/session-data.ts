import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "../core/session-manager.ts";
import { isRecord } from "./hooks/jev-types.ts";
import type { MemorySourceRecord } from "./memory/index.ts";
import { TODO_SESSION_ENTRY_TYPE } from "./todo/index.ts";

function imageReference(value: Record<string, unknown>): string | undefined {
	if (typeof value.data !== "string" || typeof value.mimeType !== "string") return undefined;
	const digest = createHash("sha256").update(value.data, "base64").digest("hex");
	return `[image sha256:${digest} mime=${value.mimeType}]`;
}

function messageText(message: AgentMessage): string {
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (part.type === "image") {
			const reference = imageReference(part);
			if (reference) parts.push(reference);
		}
	}
	return parts.join("\n");
}

function outcome(message: AgentMessage): MemorySourceRecord["outcome"] {
	if (message.role === "toolResult") return message.isError ? "failed" : "completed";
	if (message.role === "assistant") {
		if (message.stopReason === "error" || message.stopReason === "aborted") return "failed";
		if (message.stopReason === "stop" || message.stopReason === "toolUse") return "completed";
	}
	return "unverified";
}

/** Stable for linear appends; switches to the selected child ID only at a real branch point. */
export function branchIdForEntries(
	allEntries: readonly SessionEntry[],
	branch: readonly SessionEntry[],
	sessionId: string,
): string {
	const childCounts = new Map<string | null, number>();
	for (const entry of allEntries) childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
	let branchId = `root_${sessionId}`;
	for (const entry of branch) {
		if ((childCounts.get(entry.parentId) ?? 0) > 1) branchId = entry.id;
	}
	return branchId;
}

export function memoryRecordsFromBranch(
	entries: readonly SessionEntry[],
	sessionId: string,
	branchId: string,
	startIndex = 0,
): MemorySourceRecord[] {
	const records: MemorySourceRecord[] = [];
	for (let ordinal = Math.max(0, startIndex); ordinal < entries.length; ordinal++) {
		const entry = entries[ordinal];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
		const content = messageText(message).trim();
		if (!content) continue;
		const role = message.role === "toolResult" ? "tool" : message.role;
		const sourceRevision = `sha256:${createHash("sha256")
			.update(JSON.stringify({ role, content, outcome: outcome(message) }))
			.digest("hex")}`;
		records.push({
			sessionId,
			branchId,
			entryId: entry.id,
			sourceRevision,
			ordinal,
			role,
			origin:
				message.role === "toolResult" &&
				(message.toolName === "recall" ||
					message.toolName === "memory" ||
					(isRecord(message.details) && message.details.harnessDerivedRecall === true))
					? "derived-recall"
					: role === "tool"
						? "tool"
						: "session",
			content,
			timestamp: entry.timestamp,
			outcome: outcome(message),
		});
	}
	return records;
}

/** Return the newest TODO snapshot on the selected branch, regardless of its prior branch scope. */
export function latestTodoSnapshot(entries: readonly SessionEntry[], sessionId: string): unknown {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== TODO_SESSION_ENTRY_TYPE || !isRecord(entry.data)) continue;
		if (entry.data.sessionId !== sessionId) continue;
		return entry.data;
	}
	return undefined;
}
