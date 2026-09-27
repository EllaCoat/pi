import { readFile } from "node:fs/promises";
import { HarnessMcpClient } from "../packages/coding-agent/dist/personal-harness/mcp/index.js";

const [run, configPath, serverName, taskId] = process.argv.slice(2);
if (run !== "--run" || !configPath || !serverName || !taskId) {
	console.error("Usage: node scripts/probe-harness-mcp.mjs --run <existing-mcp-config> <server> <authorized-task-id>");
	process.exit(2);
}
let client;
try {
	const entry = JSON.parse(await readFile(configPath, "utf8")).mcpServers?.[serverName];
	if (!entry || typeof entry.command !== "string") throw new Error("Configured stdio server not found");
	client = new HarnessMcpClient({ transport: { type: "stdio", command: entry.command, args: entry.args, cwd: entry.cwd, env: entry.env, stderr: "pipe" } });
	await client.connect({ timeoutMs: 15_000 });
	const tools = await client.listTools({ timeoutMs: 15_000 });
	const response = await client.call("read", { action: "get_task", args: { id: taskId } }, { timeoutMs: 15_000 });
	let result = response.structuredContent;
	if (!result) result = JSON.parse(response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
	const taskMatched = result?.task?.id === taskId;
	console.log(JSON.stringify({ server: serverName, connected: true, tools: tools.tools.map((tool) => tool.name), fingerprint: tools.fingerprint, taskMatched, toolError: response.isError === true }));
	if (!taskMatched || response.isError) process.exitCode = 1;
} catch (error) {
	console.log(JSON.stringify({ server: serverName, status: "failed", errorType: error?.name ?? "unknown", kind: error?.kind }));
	process.exitCode = 1;
} finally {
	await client?.close();
}
