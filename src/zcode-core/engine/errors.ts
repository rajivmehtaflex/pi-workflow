import type { WorkflowErrorCode, WorkflowErrorJson } from "./types.js";

export class WorkflowError extends Error {
  readonly json: WorkflowErrorJson;

  constructor(code: WorkflowErrorCode, message: string, details: Omit<WorkflowErrorJson, "code" | "message"> = {}) {
    super(message);
    this.name = "WorkflowError";
    this.json = { code, message, ...details };
  }
}

export function toWorkflowErrorJson(error: unknown, fallback = "Workflow operation failed"): WorkflowErrorJson {
  if (error instanceof WorkflowError) return error.json;
  if (error instanceof Error) return { code: "DriverError", message: error.message };
  return { code: "DriverError", message: fallback };
}
