import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [pkg, ...files] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]*$/.test(pkg ?? "") || files.length === 0 || files.some((file) => !/^test\/[\w./-]+\.(test|spec)\.ts$/.test(file) || file.includes(".."))) {
	console.error("Usage: node scripts/run-harness-tests.mjs <package> test/name.test.ts [...]");
	process.exit(2);
}
const logs = mkdtempSync(join(tmpdir(), "pi-harness-tests-"));
const report = join(logs, "results.json");
const result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "--run", "--reporter=json", `--outputFile=${report}`, ...files], {
	cwd: join(root, "packages", pkg), encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
});
const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
writeFileSync(join(logs, "output.log"), log);
console.log(`Scope: ${pkg}: ${files.join(", ")}`);
console.log(`Exit: ${result.status ?? "none"}; signal: ${result.signal ?? "none"}; logs: ${logs}`);
if (result.error) console.error(`Process error: ${result.error.code ?? result.error.name}: ${result.error.message}`);
let data;
try { data = JSON.parse(readFileSync(report, "utf8")); } catch { /* Missing output is a runner failure, never a pass. */ }
if (data) {
	console.log(`Tests: ${data.numTotalTests}; passed: ${data.numPassedTests}; failed: ${data.numFailedTests}; pending: ${data.numPendingTests}`);
	let diagnostics = "";
	for (const suite of data.testResults ?? []) {
		for (const test of suite.assertionResults ?? []) {
			if (test.status === "failed") diagnostics += `${suite.name}: ${test.fullName}\n${(test.failureMessages ?? []).join("\n")}\n`;
		}
		if (suite.message) diagnostics += `${suite.name}: ${suite.message}\n`;
	}
	if (diagnostics) console.error(diagnostics.slice(0, 16000));
	if (diagnostics.length > 16000) console.error(`Diagnostics truncated (${diagnostics.length} characters); full report: ${report}`);
} else {
	console.error(`No test report: tests are not confirmed executed.\n${log.slice(-16000)}`);
}
if (result.status !== 0 && data) console.error(log.slice(-6000));
const exit = result.error?.code === "ETIMEDOUT" ? 124 : result.status ?? 1;
process.exit(exit || (!data || !data.success || data.numTotalTests === 0 ? 1 : 0));
