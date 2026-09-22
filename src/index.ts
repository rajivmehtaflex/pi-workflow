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
import { RequirementsCoordinator } from "./requirements/coordinator.js";
import { createPiGenerator } from "./requirements/generator.js";
import { RequirementsNotifications } from "./requirements/notifications.js";
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

interface RequirementsSlot {
  current?: RequirementsCoordinator;
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
    get requirementsRepository() {
      return requireService(slot).requirementsRepository;
    },
    createWorkflow: (input: CreateWorkflowInput) => requireService(slot).createWorkflow(input),
    createWorkflowForRequest: (requestId: string, input: CreateWorkflowInput) =>
      requireService(slot).createWorkflowForRequest(requestId, input),
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
  requirements: RequirementsSlot,
  notifications: RequirementsNotifications | undefined,
): Promise<void> {
  projection?.dispose();
  notifications?.dispose();
  const coordinator = requirements.current;
  requirements.current = undefined;
  if (coordinator !== undefined) await coordinator.dispose();
  const service = slot.current;
  slot.current = undefined;
  if (service !== undefined) await service.dispose();
}

export function workflowExtension(
  pi: WorkflowExtensionApi,
  options: WorkflowExtensionOptions = {},
): void {
  const slot: ServiceSlot = {};
  const requirements: RequirementsSlot = {};
  const lazyService = createLazyService(slot);
  let projection: WorkflowUiProjection | undefined;
  let notifications: RequirementsNotifications | undefined;
  const createService = options.createService ?? createWorkflowRunService;

  registerWorkflowCommand(pi, lazyService, () => requirements.current);
  registerWorkflowTools(pi, lazyService, () => requirements.current);
  pi.registerEntryRenderer?.("pi-workflow", (entry) =>
    renderWorkflowTranscriptEntry(
      entry as { customType?: string; text?: string; runId?: string; status?: string },
    ),
  );

  pi.on("session_start", async (_event, context) => {
    await disposeSlot(slot, projection, requirements, notifications);
    projection = undefined;
    notifications = undefined;
    slot.current = await createService({
      cwd: context.cwd,
      hasUI: context.hasUI,
      askInteractive: createPiEscalationAsk(context),
      reconcile: true,
    });
    projection = createWorkflowUiProjection(context, slot.current);
    const repository = slot.current.requirementsRepository;
    if (repository !== undefined) {
      requirements.current = new RequirementsCoordinator({
        cwd: context.cwd,
        workspaceKey: slot.current.workspaceKey,
        repository,
        generate: createPiGenerator({ cwd: context.cwd }),
        validate: (source) => slot.current!.validate(source),
        launch: async (input) => {
          const accepted = await slot.current!.createWorkflowForRequest(input.requestId, {
            source: { script: input.source },
            ...(input.input.model === undefined ? {} : { model: input.input.model }),
            ...(input.input.thinking === undefined ? {} : { thinking: input.input.thinking }),
            caps: { maxConcurrency: input.input.maxConcurrency ?? 2 },
          });
          return { runId: accepted.runId };
        },
        stopRun: (runId) => {
          slot.current?.stopRun(runId);
        },
        resumeRun: async (runId) => {
          const accepted = await slot.current!.resumeRun(runId);
          return { runId: accepted.runId };
        },
      });
      notifications = new RequirementsNotifications({
        workspaceKey: slot.current.workspaceKey,
        repository,
        getRun: (runId) => {
          try {
            return slot.current?.getRun(runId);
          } catch {
            return undefined;
          }
        },
        send: (message) => {
          pi.sendMessage?.(message, { deliverAs: "followUp", triggerTurn: true });
        },
        onChange: () => projection?.refresh(),
      });
      notifications.start();
    }
    projection.refresh();
  });

  pi.on("session_shutdown", async () => {
    await disposeSlot(slot, projection, requirements, notifications);
    projection = undefined;
    notifications = undefined;
  });
}

export default workflowExtension;
