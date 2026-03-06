/**
 * Re-export shim for backward compatibility.
 * The actual implementation has moved to llm-executor.ts.
 */
export { LlmExecutorBackend as OsProcessExecutor, type ProcessExecutorDeps } from "./llm-executor.js";
