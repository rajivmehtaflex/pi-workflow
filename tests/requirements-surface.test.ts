import { describe, expect, it, vi } from "vitest";
import {
  parseWorkflowCommand,
  registerWorkflowCommand,
  type WorkflowCommandContext,
} from "../src/commands/workflow-command.js";
import {
  registerWorkflowTools,
  type WorkflowToolRegistration,
} from "../src/tools/workflow-tools.js";
import type { WorkflowRunService } from "../src/service/run-service.js";
import type { RequirementsCoordinator } from "../src/requirements/coordinator.js";
import type { RequirementsRequest } from "../src/requirements/types.js";
import { RequirementsNotifications } from "../src/requirements/notifications.js";

const request = (overrides: Partial<RequirementsRequest> = {}): RequirementsRequest => ({
  requestId: "request-1",
  workspaceKey: "workspace-1",
  input: { requirements: "Review the repository", maxConcurrency: 2 },
  state: "queued",
  attempts: 0,
  diagnostics: [],
  assumptions: ["The repository is available"],
  acceptanceCriteria: ["The workflow completes"],
  createdAt: 1,
  updatedAt: 1,
  notificationDelivered: false,
  ...overrides,
});

function commandRegistration(service: WorkflowRunService, coordinator: RequirementsCoordinator) {
  const pi = { registerCommand: vi.fn() };
  registerWorkflowCommand(pi, service, () => coordinator);
  return pi.registerCommand.mock.calls[0]?.[1] as {
    handler(args: string, context: WorkflowCommandContext): Promise<void>;
  };
}

describe("automatic requirements surface", () => {
  it("preserves free-form requirements and parses request targets", () => {
    expect(
      parseWorkflowCommand(
        'auto --preview -- Review changed files; preserve "quoted JSON" and {"key":"value"}\nnext line',
      ),
    ).toEqual({
      ok: true,
      command: {
        kind: "auto",
        requirements: 'Review changed files; preserve "quoted JSON" and {"key":"value"}\nnext line',
        preview: true,
      },
    });
    expect(
      parseWorkflowCommand("auto --max-concurrency 3 --model openai/gpt-5:high Review risks"),
    ).toEqual({
      ok: true,
      command: {
        kind: "auto",
        requirements: "Review risks",
        maxConcurrency: 3,
        model: "openai/gpt-5",
        thinking: "high",
      },
    });
    expect(parseWorkflowCommand("auto")).toMatchObject({
      ok: false,
      error: expect.stringContaining("requirements"),
    });
    expect(parseWorkflowCommand("status request:req-1")).toEqual({
      ok: true,
      command: { kind: "status", requestId: "req-1" },
    });
    expect(parseWorkflowCommand("stop request:req-1")).toEqual({
      ok: true,
      command: { kind: "stop", requestId: "req-1" },
    });
    expect(parseWorkflowCommand("resume request:req-1")).toEqual({
      ok: true,
      command: { kind: "resume", requestId: "req-1" },
    });
  });

  it("routes automatic and request lifecycle commands through the coordinator", async () => {
    const notify = vi.fn();
    const coordinator = {
      start: vi.fn(() => request()),
      get: vi.fn(() => request({ state: "running", runId: "run-1" })),
      stop: vi.fn(async () => undefined),
      resume: vi.fn(async () => request({ state: "running", runId: "run-1" })),
    } as unknown as RequirementsCoordinator;
    const service = {
      listRuns: vi.fn(() => []),
      getRun: vi.fn(() => undefined),
    } as unknown as WorkflowRunService;
    const handler = commandRegistration(service, coordinator);
    const context: WorkflowCommandContext = { ui: { notify } };

    await handler.handler("auto -- Review the changed files", context);
    await handler.handler("status request:request-1", context);
    await handler.handler("stop request:request-1", context);
    await handler.handler("resume request:request-1", context);

    expect(coordinator.start).toHaveBeenCalledWith({ requirements: "Review the changed files" });
    expect(coordinator.get).toHaveBeenCalledWith("request-1");
    expect(coordinator.stop).toHaveBeenCalledWith("request-1");
    expect(coordinator.resume).toHaveBeenCalledWith("request-1");
    expect(notify).toHaveBeenCalled();
  });

  it("registers the requirements tool and returns before generation settles", async () => {
    const tools: WorkflowToolRegistration[] = [];
    const coordinator = {
      start: vi.fn(() => request()),
    } as unknown as RequirementsCoordinator;
    registerWorkflowTools(
      { registerTool: (tool) => tools.push(tool) },
      {} as WorkflowRunService,
      () => coordinator,
    );
    const tool = tools.find((candidate) => candidate.name === "create_workflow_from_requirements");
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      "call-1",
      { requirements: "Review the repository", preview: true },
      new AbortController().signal,
      vi.fn(),
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("request-1");
    expect(coordinator.start).toHaveBeenCalledWith({
      requirements: "Review the repository",
      preview: true,
    });
  });

  it("reports a terminal request once with bounded result details", async () => {
    const current = request({ state: "running", runId: "run-1" });
    const transition = vi.fn((_id: string, _state: string, patch: Partial<RequirementsRequest>) => {
      Object.assign(current, patch, {
        notificationDelivered: patch.notificationDelivered ?? current.notificationDelivered,
      });
      return current;
    });
    const send = vi.fn();
    const notifications = new RequirementsNotifications({
      workspaceKey: "workspace-1",
      repository: { list: () => [current], transition } as never,
      getRun: () =>
        ({
          runId: "run-1",
          status: "completed",
          result: { output: "x".repeat(20_000) },
        }) as never,
      send,
    });

    await notifications.poll();
    await notifications.poll();

    expect(current.state).toBe("completed");
    expect(current.notificationDelivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls[0]?.[0]).length).toBeLessThan(10_000);
    notifications.dispose();
  });
});
