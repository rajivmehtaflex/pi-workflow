import { describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_USAGE,
  parseWorkflowCommand,
  registerWorkflowCommand,
  type WorkflowCommandContext,
} from "../src/commands/workflow-command.js";
import type { AcceptedWorkflowRun, WorkflowRunService } from "../src/service/run-service.js";

describe("/workflow command grammar", () => {
  it("parses a run with saved scope, JSON args, model thinking, and bounded concurrency", () => {
    expect(
      parseWorkflowCommand(
        'run project:review --args {"branch":"main"} --model openai/gpt-5:high --max-concurrency 4',
      ),
    ).toEqual({
      ok: true,
      command: {
        kind: "run",
        source: { kind: "saved", scope: "project", name: "review" },
        args: { branch: "main" },
        model: "openai/gpt-5",
        thinking: "high",
        maxConcurrency: 4,
      },
    });
  });

  it("keeps paths relative and recognizes cancel as an explicit stop alias", () => {
    expect(parseWorkflowCommand('validate "workflows/review.ts"')).toEqual({
      ok: true,
      command: { kind: "validate", source: { kind: "path", value: "workflows/review.ts" } },
    });
    expect(parseWorkflowCommand("cancel run-123")).toEqual({
      ok: true,
      command: { kind: "stop", runId: "run-123", alias: "cancel" },
    });
    expect(parseWorkflowCommand("stop")).toEqual({
      ok: true,
      command: { kind: "stop" },
    });
  });

  it("rejects malformed JSON and out-of-range numeric options without creating a run", () => {
    expect(parseWorkflowCommand("run project:review --args {bad}")).toEqual({
      ok: false,
      error: expect.stringContaining("--args"),
      usage: WORKFLOW_USAGE,
    });
    expect(parseWorkflowCommand("list --limit 101")).toEqual({
      ok: false,
      error: expect.stringContaining("limit"),
      usage: WORKFLOW_USAGE,
    });
  });

  it("routes read-only and lifecycle commands through the service", async () => {
    const accepted: AcceptedWorkflowRun = {
      runId: "run-1",
      status: "pending",
      scriptHash: "hash",
      graph: { phases: [], sites: [], causality: { edges: [] } },
    };
    const service = {
      createWorkflow: vi.fn(async () => accepted),
      validateSource: vi.fn(async () => ({ ok: true, diagnostics: [], lowered: accepted.graph })),
      listRuns: vi.fn(() => []),
      getRun: vi.fn(() => undefined),
      stopRun: vi.fn(() => undefined),
      resumeRun: vi.fn(async () => accepted),
    } as unknown as WorkflowRunService;
    const notify = vi.fn();
    const context: WorkflowCommandContext = { cwd: "/workspace", ui: { notify } };
    const pi = { registerCommand: vi.fn() };

    registerWorkflowCommand(pi, service);
    const registration = pi.registerCommand.mock.calls[0]?.[1] as {
      handler: (args: string, ctx: WorkflowCommandContext) => Promise<void>;
    };
    await registration.handler("run project:review --max-concurrency 2", context);
    await registration.handler("validate project:review", context);
    await registration.handler("stop run-1", context);

    expect(service.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { saved: { scope: "project", name: "review" } },
        caps: { maxConcurrency: 2 },
      }),
    );
    expect(service.validateSource).toHaveBeenCalledWith({
      saved: { scope: "project", name: "review" },
    });
    expect(service.stopRun).toHaveBeenCalledWith("run-1");
    expect(notify).toHaveBeenCalled();
  });

  it("selects the only active run when stop has no id", async () => {
    const service = {
      listRuns: vi.fn(() => [
        { runId: "run-1", status: "running" },
        { runId: "run-2", status: "completed" },
      ]),
      stopRun: vi.fn(() => undefined),
    } as unknown as WorkflowRunService;
    const notify = vi.fn();
    const pi = { registerCommand: vi.fn() };
    registerWorkflowCommand(pi, service);
    const registration = pi.registerCommand.mock.calls[0]?.[1] as {
      handler: (args: string, ctx: WorkflowCommandContext) => Promise<void>;
    };

    await registration.handler("stop", { ui: { notify } });

    expect(service.stopRun).toHaveBeenCalledWith("run-1");
  });
});
