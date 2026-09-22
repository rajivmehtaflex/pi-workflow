import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { WorkflowError, toWorkflowErrorJson } from "../zcode-core/engine/errors.js";
import {
  AmendWorkflowSchema,
  CreateWorkflowFromRequirementsSchema,
  CreateWorkflowSchema,
  EvalWorkflowSnippetSchema,
  GetWorkflowRunSchema,
  ListSavedWorkflowsSchema,
  ListWorkflowRunsSchema,
  ResolveWorkflowQuestionSchema,
  ResumeWorkflowRunSchema,
  SaveWorkflowSchema,
  workflowToolSchemas,
} from "./schemas.js";
import {
  formatWorkflowEvents,
  formatWorkflowRuns,
  renderWorkflowToolCall,
  renderWorkflowToolResult,
} from "../ui/renderers.js";
import type { WorkflowRunService, WorkflowSourceInput } from "../service/run-service.js";
import type { RequirementsCoordinator } from "../requirements/coordinator.js";

export interface WorkflowToolUpdate {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export interface WorkflowToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface WorkflowToolContext {
  cwd?: string;
  hasUI?: boolean;
  ui?: unknown;
}

export interface WorkflowToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    onUpdate: (update: WorkflowToolUpdate) => void,
    context: WorkflowToolContext,
  ): Promise<WorkflowToolResult>;
  renderCall?(call: { name?: string; arguments?: unknown }): string;
  renderResult?(result: WorkflowToolResult): string;
}

export interface WorkflowToolApi {
  registerTool(tool: WorkflowToolRegistration): void;
  sendMessage?(message: unknown, options?: { deliverAs?: "followUp"; triggerTurn?: boolean }): void;
}

function textResult(text: string, details?: unknown): WorkflowToolResult {
  return { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) };
}

function errorResult(error: unknown): WorkflowToolResult {
  const json = toWorkflowErrorJson(error);
  return { content: [{ type: "text", text: json.message }], details: json, isError: true };
}

function checked<T>(schema: TSchema, params: unknown): T {
  if (!Value.Check(schema, params))
    throw new WorkflowError("ValidationFailed", "Workflow tool arguments do not match its schema");
  return params as T;
}

function sourceFromParams(params: Record<string, unknown>): WorkflowSourceInput {
  if (typeof params.script === "string") return { script: params.script };
  if (typeof params.path === "string") return { path: params.path };
  const saved = params.saved;
  if (typeof saved === "string") return { saved };
  if (
    typeof saved === "object" &&
    saved !== null &&
    (saved as { scope?: unknown }).scope !== undefined &&
    (saved as { name?: unknown }).name !== undefined
  )
    return {
      saved: {
        scope: (saved as { scope: "project" | "global" }).scope,
        name: (saved as { name: string }).name,
      },
    };
  throw new WorkflowError("ValidationFailed", "Exactly one workflow source is required");
}

function capsFromParams(params: Record<string, unknown>): { maxConcurrency?: number } | undefined {
  return typeof params.maxConcurrency === "number"
    ? { maxConcurrency: params.maxConcurrency }
    : undefined;
}

function acceptedDetails(run: { runId: string; status: string; scriptHash?: string }): object {
  return {
    runId: run.runId,
    status: run.status,
    ...(run.scriptHash ? { scriptHash: run.scriptHash } : {}),
  };
}

function acceptedText(run: { runId: string; status: string }): string {
  return `Workflow accepted: ${run.runId} (${run.status})`;
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

async function publishCompletion(
  pi: WorkflowToolApi,
  service: WorkflowRunService,
  runId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const run = service.getRun(runId);
    if (run.status === "completed" || run.status === "errored" || run.status === "stopped") {
      const text = `Workflow ${runId} ${run.status}`;
      pi.sendMessage?.(
        { customType: "pi-workflow", runId, status: run.status, text },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return;
    }
    await waitFor(250);
  }
}

function startBackgroundRun(
  pi: WorkflowToolApi,
  service: WorkflowRunService,
  runId: string,
  signal: AbortSignal,
  onUpdate: (update: WorkflowToolUpdate) => void,
): void {
  onUpdate({
    content: [{ type: "text", text: `Workflow ${runId} is running` }],
    details: { runId, status: "pending" },
  });
  signal.addEventListener(
    "abort",
    () => {
      try {
        service.stopRun(runId);
      } catch {
        // A terminal run needs no cancellation action.
      }
    },
    { once: true },
  );
  void publishCompletion(pi, service, runId).catch((error) => {
    pi.sendMessage?.(
      {
        customType: "pi-workflow",
        runId,
        status: "errored",
        text: toWorkflowErrorJson(error).message,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
}

async function createWorkflow(
  pi: WorkflowToolApi,
  service: WorkflowRunService,
  params: unknown,
  signal: AbortSignal,
  onUpdate: (update: WorkflowToolUpdate) => void,
): Promise<WorkflowToolResult> {
  const value = checked<Record<string, unknown>>(CreateWorkflowSchema, params);
  const run = await service.createWorkflow({
    source: sourceFromParams(value),
    ...(value.args === undefined ? {} : { args: value.args as Record<string, unknown> }),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
    ...(capsFromParams(value) === undefined ? {} : { caps: capsFromParams(value) }),
  });
  startBackgroundRun(pi, service, run.runId, signal, onUpdate);
  return textResult(acceptedText(run), acceptedDetails(run));
}

async function createWorkflowFromRequirements(
  coordinator: RequirementsCoordinator | undefined,
  params: unknown,
  signal: AbortSignal,
  onUpdate: (update: WorkflowToolUpdate) => void,
): Promise<WorkflowToolResult> {
  if (coordinator === undefined)
    throw new WorkflowError("DriverError", "Requirements workflow is not initialized");
  const value = checked<Record<string, unknown>>(CreateWorkflowFromRequirementsSchema, params);
  const request = coordinator.start({
    requirements: String(value.requirements),
    ...(typeof value.preview === "boolean" ? { preview: value.preview } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
    ...(typeof value.maxConcurrency === "number" ? { maxConcurrency: value.maxConcurrency } : {}),
    ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
  });
  onUpdate({
    content: [
      { type: "text", text: `Requirements request ${request.requestId} is ${request.state}` },
    ],
    details: { requestId: request.requestId, status: request.state },
  });
  signal.addEventListener(
    "abort",
    () => {
      void coordinator.stop(request.requestId).catch(() => undefined);
    },
    { once: true },
  );
  return textResult(`Requirements request accepted: ${request.requestId} (${request.state})`, {
    requestId: request.requestId,
    status: request.state,
  });
}

export function registerWorkflowTools(
  pi: WorkflowToolApi,
  service: WorkflowRunService,
  getRequirements?: () => RequirementsCoordinator | undefined,
): void {
  const register = (
    name: string,
    label: string,
    description: string,
    parameters: TSchema,
    execute: WorkflowToolRegistration["execute"],
  ): void =>
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      execute: async (toolCallId, params, signal, onUpdate, context) => {
        try {
          return await execute(toolCallId, params, signal, onUpdate, context);
        } catch (error) {
          return errorResult(error);
        }
      },
      renderCall: renderWorkflowToolCall,
      renderResult: renderWorkflowToolResult,
    });

  register(
    "create_workflow",
    "Create workflow",
    "Compile and launch a durable workflow run in the background.",
    workflowToolSchemas.create_workflow,
    async (_toolCallId, params, signal, onUpdate) =>
      createWorkflow(pi, service, params, signal, onUpdate),
  );
  register(
    "create_workflow_from_requirements",
    "Create workflow from requirements",
    "Generate, validate, repair, and launch a durable workflow from plain-language requirements.",
    workflowToolSchemas.create_workflow_from_requirements,
    async (_toolCallId, params, signal, onUpdate) =>
      createWorkflowFromRequirements(getRequirements?.(), params, signal, onUpdate),
  );
  register(
    "amend_workflow",
    "Amend workflow",
    "Supersede a workflow run with a replacement source.",
    workflowToolSchemas.amend_workflow,
    async (_toolCallId, params, signal, onUpdate) => {
      const value = checked<Record<string, unknown>>(AmendWorkflowSchema, params);
      const run = await service.amendRun(String(value.runId), {
        source: sourceFromParams(value),
        ...(value.args === undefined ? {} : { args: value.args as Record<string, unknown> }),
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(typeof value.model === "string" ? { model: value.model } : {}),
        ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
        ...(capsFromParams(value) === undefined ? {} : { caps: capsFromParams(value) }),
      });
      startBackgroundRun(pi, service, run.runId, signal, onUpdate);
      return textResult(acceptedText(run), acceptedDetails(run));
    },
  );
  register(
    "get_workflow_run",
    "Get workflow run",
    "Read one bounded workflow run projection and event tail.",
    workflowToolSchemas.get_workflow_run,
    async (_toolCallId, params) => {
      const value = checked<{ runId: string }>(GetWorkflowRunSchema, params);
      const run = service.getRun(value.runId);
      const events = service.repository.listEvents(value.runId, { afterSequence: 0, limit: 40 });
      return textResult(JSON.stringify({ run, events }, null, 2).slice(0, 9000), {
        run,
        eventCount: events.length,
        eventTail: formatWorkflowEvents(events, { maxLength: 3500 }),
      });
    },
  );
  register(
    "list_workflow_runs",
    "List workflow runs",
    "List recent workflow runs without creating a second queue.",
    workflowToolSchemas.list_workflow_runs,
    async (_toolCallId, params) => {
      const value = checked<{ limit?: number }>(ListWorkflowRunsSchema, params);
      const runs = service.listRuns(value.limit);
      return textResult(formatWorkflowRuns(runs), { runs });
    },
  );
  register(
    "eval_workflow_snippet",
    "Evaluate workflow snippet",
    "Compile a read-only workflow snippet without creating a durable run.",
    workflowToolSchemas.eval_workflow_snippet,
    async (_toolCallId, params) => {
      const value = checked<{ script: string }>(EvalWorkflowSnippetSchema, params);
      const result = service.validate(value.script);
      return result.ok
        ? textResult(JSON.stringify(result.lowered?.graph ?? {}, null, 2), {
            graph: result.lowered?.graph,
          })
        : errorResult(
            new WorkflowError("ValidationFailed", "Workflow snippet is invalid", {
              violations: result.diagnostics.map((diagnostic) => ({
                path: `${diagnostic.line}:${diagnostic.column}`,
                expected: "valid workflow source",
                actual: diagnostic.message,
              })),
            }),
          );
    },
  );
  register(
    "resume_workflow_run",
    "Resume workflow run",
    "Resume a compatible stopped workflow run.",
    workflowToolSchemas.resume_workflow_run,
    async (_toolCallId, params, signal, onUpdate) => {
      const value = checked<{ runId: string }>(ResumeWorkflowRunSchema, params);
      const run = await service.resumeRun(value.runId);
      startBackgroundRun(pi, service, run.runId, signal, onUpdate);
      return textResult(`Workflow resumed: ${run.runId} (${run.status})`, acceptedDetails(run));
    },
  );
  register(
    "save_workflow",
    "Save workflow",
    "Persist a project or global workflow definition.",
    workflowToolSchemas.save_workflow,
    async (_toolCallId, params) => {
      const value = checked<{
        scope: "project" | "global";
        name: string;
        sourceText: string;
        argsSchema?: unknown;
      }>(SaveWorkflowSchema, params);
      const saved = service.saveWorkflow(value);
      return textResult(`Saved workflow: ${saved.scope}:${saved.name}`, saved);
    },
  );
  register(
    "list_saved_workflows",
    "List saved workflows",
    "List saved workflow definitions for the selected scope.",
    workflowToolSchemas.list_saved_workflows,
    async (_toolCallId, params) => {
      const value = checked<{ scope?: "project" | "global" }>(ListSavedWorkflowsSchema, params);
      const saved = service.listSavedWorkflows(value.scope);
      return textResult(JSON.stringify(saved, null, 2).slice(0, 9000), { saved });
    },
  );
  register(
    "resolve_workflow_question",
    "Resolve workflow question",
    "Resolve one pending workflow escalation.",
    workflowToolSchemas.resolve_workflow_question,
    async (_toolCallId, params) => {
      const value = checked<{ qid: string; answer: string }>(ResolveWorkflowQuestionSchema, params);
      service.resolveWorkflowQuestion(value.qid, value.answer);
      return textResult(`Workflow question resolved: ${value.qid}`, { qid: value.qid });
    },
  );
}
