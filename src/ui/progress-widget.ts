import type { WorkflowRunService } from "../service/run-service.js";
import { formatWorkflowRuns } from "./renderers.js";

export interface WorkflowUiApi {
  setStatus?(id: string, text: string): void;
  setWidget?(id: string, content?: string[]): void;
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
    const requests = service.requirementsRepository?.list(service.workspaceKey).slice(0, 8) ?? [];
    const activeRequests = requests.filter((request) =>
      ["queued", "generating", "validating", "repairing", "launching", "running"].includes(
        request.state,
      ),
    );
    const requestLines = requests.map(
      (request) =>
        `${request.requestId}: ${request.state}${request.runId === undefined ? "" : ` · run=${request.runId}`}`,
    );
    const widgetSections = [
      requestLines.length === 0 ? undefined : `requirements:\n${requestLines.join("\n")}`,
      active.length === 0 ? undefined : `runs:\n${formatWorkflowRuns(active, { maxLength: 1500 })}`,
    ].filter((section): section is string => section !== undefined);
    const activeCount =
      active.length + activeRequests.filter((request) => request.runId === undefined).length;
    context.ui?.setStatus?.(
      "pi-workflow",
      activeCount === 0 ? "" : `workflow: ${activeCount} active`,
    );
    const widgetText =
      widgetSections.length === 0 ? undefined : widgetSections.join("\n\n").slice(0, 1800);
    context.ui?.setWidget?.(
      "pi-workflow",
      widgetText === undefined ? undefined : widgetText.split("\n"),
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
