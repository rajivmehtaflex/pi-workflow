import type { WorkflowErrorCode, WorkflowErrorJson } from "./types.js";

export class WorkflowError extends Error {
  readonly json: WorkflowErrorJson;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    details: Omit<WorkflowErrorJson, "code" | "message"> = {},
  ) {
    super(message);
    this.name = "WorkflowError";
    this.json = { code, message, ...details };
  }
}

export function toWorkflowErrorJson(
  error: unknown,
  fallback = "Workflow operation failed",
): WorkflowErrorJson {
  if (error instanceof WorkflowError) return error.json;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    const record = error as Record<string, unknown>;
    return {
      code: error.code as WorkflowErrorJson["code"],
      message: error.message,
      ...(Array.isArray(record.violations) ? { violations: record.violations } : {}),
      ...(typeof record.finalText === "string" ? { finalText: record.finalText } : {}),
    };
  }
  if (error instanceof Error) return { code: "DriverError", message: error.message };
  return { code: "DriverError", message: fallback };
}
