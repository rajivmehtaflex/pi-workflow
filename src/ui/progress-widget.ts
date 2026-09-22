import type { WorkflowRunService } from "../service/run-service.js";
import { formatWorkflowRuns } from "./renderers.js";

export interface WorkflowUiApi {
  setStatus?(id: string, text: string): void;
  setWidget?(id: string, content?: unknown): void;
}

export interface WorkflowUiContext {
  hasUI?: boolean;
  ui?: WorkflowUiApi;
}

export interface WorkflowUiProjection {
  refresh(): void;
  clear(): void;
  dispose(): void;
}

export function createWorkflowUiProjection(
  context: WorkflowUiContext,
  service: WorkflowRunService,
): WorkflowUiProjection {
  let disposed = false;
  const enabled = context.hasUI !== false && context.ui !== undefined;
  const clear = (): void => {
    if (!enabled) return;
    context.ui?.setStatus?.("pi-workflow", "");
    context.ui?.setWidget?.("pi-workflow", undefined);
  };
  const refresh = (): void => {
    if (disposed || !enabled) return;
    const runs = service.listRuns(8);
    const active = runs.filter((run) => run.status === "pending" || run.status === "running");
    context.ui?.setStatus?.(
      "pi-workflow",
      active.length === 0 ? "" : `workflow: ${active.length} active`,
    );
    context.ui?.setWidget?.(
      "pi-workflow",
      active.length === 0 ? undefined : formatWorkflowRuns(active, { maxLength: 1800 }),
    );
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clear();
  };
  refresh();
  return { refresh, clear, dispose };
}
