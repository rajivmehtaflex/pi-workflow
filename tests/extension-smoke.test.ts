import { describe, expect, it, vi } from "vitest";
import {
  registerWorkflowTools,
  type WorkflowToolRegistration,
} from "../src/tools/workflow-tools.js";
import { createWorkflowUiProjection } from "../src/ui/progress-widget.js";
import type { WorkflowRunService } from "../src/service/run-service.js";
import workflowExtension, { type WorkflowExtensionApi } from "../src/index.js";

function fakeRun(status: "running" | "completed" = "completed") {
  return {
    runId: "run-1",
    workspaceKey: "/workspace",
    cwd: "/workspace",
    caps: { maxConcurrency: 2 },
    spentTokens: 0,
    status,
    createdAt: 1,
    updatedAt: 1,
  } as const;
}

describe("workflow tool and UI projections", () => {
  it("registers the complete tool family, rejects invalid source unions, and launches in background", async () => {
    const tools: WorkflowToolRegistration[] = [];
    const sendMessage = vi.fn();
    const service = {
      createWorkflow: vi.fn(async () => ({
        runId: "run-1",
        status: "pending" as const,
        scriptHash: "hash",
        graph: { phases: [], sites: [], causality: { edges: [] } },
      })),
      getRun: vi.fn(() => fakeRun()),
      repository: { listEvents: vi.fn(() => []) },
      listRuns: vi.fn(() => []),
      validate: vi.fn(() => ({ ok: true, diagnostics: [], lowered: undefined })),
      resumeRun: vi.fn(),
      amendRun: vi.fn(),
      saveWorkflow: vi.fn(),
      listSavedWorkflows: vi.fn(),
      resolveWorkflowQuestion: vi.fn(),
    } as unknown as WorkflowRunService;
    registerWorkflowTools({ registerTool: (tool) => tools.push(tool), sendMessage }, service);

    expect(tools.map((tool) => tool.name)).toEqual([
      "create_workflow",
      "amend_workflow",
      "get_workflow_run",
      "list_workflow_runs",
      "eval_workflow_snippet",
      "resume_workflow_run",
      "save_workflow",
      "list_saved_workflows",
      "resolve_workflow_question",
    ]);
    const create = tools[0]!;
    const invalid = await create.execute(
      "call-1",
      { script: "agent().ask('x')", path: "other.ts" },
      new AbortController().signal,
      vi.fn(),
      {},
    );
    expect(invalid.isError).toBe(true);
    expect(service.createWorkflow).not.toHaveBeenCalled();

    const updates = vi.fn();
    const accepted = await create.execute(
      "call-2",
      { script: "const answer = await agent().ask('x'); report(answer);" },
      new AbortController().signal,
      updates,
      {},
    );
    expect(accepted.isError).toBeUndefined();
    expect(updates).toHaveBeenCalledWith(
      expect.objectContaining({ details: { runId: "run-1", status: "pending" } }),
    );
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-workflow", runId: "run-1", status: "completed" }),
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  it("projects active runs into bounded status/widget state and clears both on dispose", () => {
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const service = {
      listRuns: vi.fn(() => [fakeRun("running")]),
    } as unknown as WorkflowRunService;
    const projection = createWorkflowUiProjection(
      { hasUI: true, ui: { setStatus, setWidget } },
      service,
    );
    expect(setStatus).toHaveBeenCalledWith("pi-workflow", "workflow: 1 active");
    expect(setWidget).toHaveBeenCalledWith("pi-workflow", expect.stringContaining("run-1"));
    projection.dispose();
    expect(setStatus).toHaveBeenLastCalledWith("pi-workflow", "");
    expect(setWidget).toHaveBeenLastCalledWith("pi-workflow", undefined);
  });

  it("registers commands/tools and reconstructs then disposes the service on lifecycle hooks", async () => {
    const service = {
      listRuns: vi.fn(() => []),
      dispose: vi.fn(async () => undefined),
    } as unknown as WorkflowRunService;
    const hooks = new Map<
      string,
      (event: unknown, context: { cwd: string; hasUI: boolean }) => Promise<void>
    >();
    const pi: WorkflowExtensionApi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn((event, handler) => hooks.set(event, handler)),
      sendMessage: vi.fn(),
    };
    const createService = vi.fn(async () => service);
    workflowExtension(pi, { createService });

    expect(pi.registerCommand).toHaveBeenCalledWith("workflow", expect.anything());
    expect(pi.registerTool).toHaveBeenCalledTimes(9);
    const start = hooks.get("session_start");
    const shutdown = hooks.get("session_shutdown");
    expect(start).toBeDefined();
    expect(shutdown).toBeDefined();
    await start?.({}, { cwd: "/workspace", hasUI: false });
    await shutdown?.({}, { cwd: "/workspace", hasUI: false });
    await shutdown?.({}, { cwd: "/workspace", hasUI: false });
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace", reconcile: true }),
    );
    expect(service.dispose).toHaveBeenCalledTimes(1);
  });
});
