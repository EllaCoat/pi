export type CodeModeLanguage = "javascript" | "python";

export type CodeModeOutputType = "stdout" | "stderr" | "display" | "result";

export interface CodeModeOutput {
	type: CodeModeOutputType;
	data: unknown;
}

export interface CodeModeExecutionError {
	name: string;
	message: string;
	stack?: string;
}

export type CodeModeToolExecutionStatus = "success" | "failure" | "unknown";

export interface CodeModeToolExecution {
	name: string;
	status: CodeModeToolExecutionStatus;
	harnessDerivedRecall: boolean;
}

export interface CodeModeExecutionResult {
	outputs: CodeModeOutput[];
	toolExecutions: CodeModeToolExecution[];
	harnessDerivedRecall: boolean;
	error?: CodeModeExecutionError;
	interrupted?: boolean;
}

export type CodeModeToolDispatcher = (name: string, args: unknown, signal: AbortSignal) => unknown | Promise<unknown>;

export interface CodeModeSessionOptions {
	cwd?: string;
}

export interface CodeModeSessionManagerOptions {
	dispatcher: CodeModeToolDispatcher;
	pythonExecutable?: string;
}

export interface CodeModeExecuteOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}
