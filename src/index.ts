import { createPiEscalationAsk, type PiEscalationUi } from "./interaction/pi-escalation-ui.js";
import {
  registerWorkflowCommand,
  type WorkflowCommandApi,
  type WorkflowCommandContext,
} from "./commands/workflow-command.js";
import {
  registerWorkflowTools,
  type WorkflowToolApi,
  type WorkflowToolContext,
} from "./tools/workflow-tools.js";
import {
  createWorkflowUiProjection,
  type WorkflowUiApi,
  type WorkflowUiProjection,
} from "./ui/progress-widget.js";
import { renderWorkflowTranscriptEntry } from "./ui/renderers.js";
import {
  createWorkflowRunService,
  type WorkflowRunService,
  type WorkflowRunServiceDependencies,
  type CreateWorkflowInput,
  type WorkflowSourceInput,
} from "./service/run-service.js";
import type { SavedWorkflowRecord } from "./storage/types.js";

export interface WorkflowExtensionUi extends PiEscalationUi, WorkflowUiApi {
  notify?(message: string, level?: "info" | "warning" | "error"): void;
}

export interface WorkflowExtensionContext extends WorkflowCommandContext, WorkflowToolContext {
  cwd: string;
  hasUI?: boolean;
  ui?: WorkflowExtensionUi;
}

export interface WorkflowExtensionApi extends WorkflowCommandApi, WorkflowToolApi {
  on(
    event: "session_start" | "session_shutdown",
    handler: (event: unknown, context: WorkflowExtensionContext) => Promise<void>,
  ): void;
  registerEntryRenderer?(type: string, renderer: (entry: unknown) => string): void;
}

export interface WorkflowExtensionOptions {
  createService?(dependencies: WorkflowRunServiceDependencies): Promise<WorkflowRunService>;
}

interface ServiceSlot {
  current?: WorkflowRunService;
}

function requireService(slot: ServiceSlot): WorkflowRunService {
  if (slot.current === undefined)
    throw new Error("Pi workflow is not initialized; wait for session_start");
  return slot.current;
}

function createLazyService(slot: ServiceSlot): WorkflowRunService {
  return {
    get repository() {
      return requireService(slot).repository;
    },
    createWorkflow: (input: CreateWorkflowInput) => requireService(slot).createWorkflow(input),
    validate: (source: string) => requireService(slot).validate(source),
    validateSource: (source: WorkflowSourceInput) => requireService(slot).validateSource(source),
    amendRun: (runId: string, input: CreateWorkflowInput) =>
      requireService(slot).amendRun(runId, input),
    resumeRun: (runId: string, source?: WorkflowSourceInput) =>
      requireService(slot).resumeRun(runId, source),
    stopRun: (runId: string) => requireService(slot).stopRun(runId),
    getRun: (runId: string) => requireService(slot).getRun(runId),
    listRuns: (limit?: number) => requireService(slot).listRuns(limit),
    resolveWorkflowQuestion: (qid: string, answer: string) =>
      requireService(slot).resolveWorkflowQuestion(qid, answer),
    saveWorkflow: (record: Omit<SavedWorkflowRecord, "scriptHash" | "updatedAt">) =>
      requireService(slot).saveWorkflow(record),
    listSavedWorkflows: (scope?: SavedWorkflowRecord["scope"]) =>
      requireService(slot).listSavedWorkflows(scope),
    reconcile: () => requireService(slot).reconcile(),
    dispose: () => requireService(slot).dispose(),
    workspaceKey: "lazy",
    escalation: undefined,
  } as unknown as WorkflowRunService;
}

async function disposeSlot(
  slot: ServiceSlot,
  projection: WorkflowUiProjection | undefined,
): Promise<void> {
  projection?.dispose();
  const service = slot.current;
  slot.current = undefined;
  if (service !== undefined) await service.dispose();
}

export function workflowExtension(
  pi: WorkflowExtensionApi,
  options: WorkflowExtensionOptions = {},
): void {
  const slot: ServiceSlot = {};
  const lazyService = createLazyService(slot);
  let projection: WorkflowUiProjection | undefined;
  const createService = options.createService ?? createWorkflowRunService;

  registerWorkflowCommand(pi, lazyService);
  registerWorkflowTools(pi, lazyService);
  pi.registerEntryRenderer?.("pi-workflow", (entry) =>
    renderWorkflowTranscriptEntry(
      entry as { customType?: string; text?: string; runId?: string; status?: string },
    ),
  );

  pi.on("session_start", async (_event, context) => {
    await disposeSlot(slot, projection);
    projection = undefined;
    slot.current = await createService({
      cwd: context.cwd,
      hasUI: context.hasUI,
      askInteractive: createPiEscalationAsk(context),
      reconcile: true,
    });
    projection = createWorkflowUiProjection(context, slot.current);
    projection.refresh();
  });

  pi.on("session_shutdown", async () => {
    await disposeSlot(slot, projection);
    projection = undefined;
  });
}

export default workflowExtension;
