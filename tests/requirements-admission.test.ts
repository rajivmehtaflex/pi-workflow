import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequirementsRepository } from "../src/requirements/repository.js";
import { openWorkflowDatabase } from "../src/storage/db.js";
import { createWorkflowRunService, type WorkflowRunService } from "../src/service/run-service.js";

const source = 'phase("Check"); return { ok: true };';
const contexts: Array<{
  cwd: string;
  database: Awaited<ReturnType<typeof openWorkflowDatabase>>;
  service: WorkflowRunService;
}> = [];

async function makeService(): Promise<{
  cwd: string;
  database: Awaited<ReturnType<typeof openWorkflowDatabase>>;
  service: WorkflowRunService;
  requests: RequirementsRepository;
  launches: { count: number };
}> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-admission-"));
  const database = await openWorkflowDatabase({ cwd, workspaceIdentity: "workspace-1" });
  const requests = new RequirementsRepository(database.db);
  const launches = { count: 0 };
  const service = await createWorkflowRunService({
    cwd,
    database,
    requirementsRepository: requests,
    reconcile: false,
    runWorkflow: async () => {
      launches.count += 1;
      return { status: "completed", value: { ok: true } };
    },
  });
  const context = { cwd, database, service };
  contexts.push(context);
  return { cwd, database, service, requests, launches };
}

afterEach(async () => {
  await Promise.all(
    contexts.splice(0).map(async ({ cwd, database, service }) => {
      await service.dispose();
      database.close();
      await rm(cwd, { recursive: true, force: true });
    }),
  );
});

function readyRequest(
  requests: RequirementsRepository,
  requestId: string,
  workspaceKey = "workspace-1",
) {
  requests.create({ requestId, requirements: "Review this" }, workspaceKey);
  requests.transition(requestId, "queued", { state: "ready", source });
}

describe("requirements request run admission", () => {
  it("admits one durable run for repeated requests and launches once", async () => {
    const { service, requests, launches } = await makeService();
    readyRequest(requests, "request-1");

    const first = await service.createWorkflowForRequest("request-1", {
      source: { script: source },
    });
    const second = await service.createWorkflowForRequest("request-1", {
      source: { script: source },
    });

    expect(second).toEqual(first);
    expect(service.repository.listRuns("workspace-1")).toHaveLength(1);
    expect(requests.get("request-1")).toMatchObject({ state: "running", runId: first.runId });
    expect(launches.count).toBe(1);
  });

  it("rolls back the run and request link when admission fails", async () => {
    const { service, requests } = await makeService();
    readyRequest(requests, "request-rollback");
    const transition = vi.spyOn(requests, "transition").mockImplementationOnce(() => {
      throw new Error("link failed");
    });

    await expect(
      service.createWorkflowForRequest("request-rollback", { source: { script: source } }),
    ).rejects.toThrow("link failed");
    expect(service.repository.listRuns("workspace-1")).toEqual([]);
    expect(requests.get("request-rollback").runId).toBeUndefined();
    transition.mockRestore();
  });

  it("rejects stopped requests without launching a child", async () => {
    const { service, requests, launches } = await makeService();
    requests.create({ requestId: "request-stopped", requirements: "Review this" }, "workspace-1");
    requests.transition("request-stopped", "queued", {
      state: "stopped",
      error: { code: "Cancelled", message: "user stopped" },
    });

    await expect(
      service.createWorkflowForRequest("request-stopped", { source: { script: source } }),
    ).rejects.toMatchObject({ json: { code: "Cancelled" } });
    expect(launches.count).toBe(0);
    expect(service.repository.listRuns("workspace-1")).toEqual([]);
  });

  it("rejects requests from another workspace", async () => {
    const { service, requests } = await makeService();
    readyRequest(requests, "request-other", "workspace-2");
    await expect(
      service.createWorkflowForRequest("request-other", { source: { script: source } }),
    ).rejects.toMatchObject({ code: "WorkspaceMismatch" });
  });

  it("returns the existing run after a crash between admission and launch", async () => {
    const { service, requests, launches } = await makeService();
    readyRequest(requests, "request-recovered");
    const lowered = service.validate(source);
    expect(lowered.ok).toBe(true);
    service.repository.createRun({
      runId: "run-recovered",
      workspaceKey: "workspace-1",
      cwd: "/workspace",
      scriptText: source,
      scriptHash: lowered.lowered!.scriptHash,
      caps: { maxConcurrency: 2 },
      spentTokens: 0,
      status: "running",
    });
    requests.transition("request-recovered", "ready", {
      state: "running",
      runId: "run-recovered",
    });

    const accepted = await service.createWorkflowForRequest("request-recovered", {
      source: { script: source },
    });
    expect(accepted.runId).toBe("run-recovered");
    expect(launches.count).toBe(0);
    expect(service.repository.listRuns("workspace-1")).toHaveLength(1);
  });

  it("reconciles unfinished generation and linked interrupted runs", async () => {
    const { service, requests } = await makeService();
    requests.create({ requestId: "request-generating", requirements: "Generate" }, "workspace-1");
    requests.transition("request-generating", "queued", { state: "generating", attempts: 1 });
    readyRequest(requests, "request-linked");
    service.repository.createRun({
      runId: "run-linked",
      workspaceKey: "workspace-1",
      cwd: "/workspace",
      scriptText: source,
      caps: { maxConcurrency: 2 },
      spentTokens: 0,
      status: "running",
    });
    requests.transition("request-linked", "ready", {
      state: "running",
      runId: "run-linked",
    });

    service.reconcile();

    expect(requests.get("request-generating")).toMatchObject({
      state: "stopped",
      error: { code: "Interrupted" },
    });
    expect(requests.get("request-linked")).toMatchObject({
      state: "stopped",
      runId: "run-linked",
      error: { code: "Interrupted" },
    });
    expect(service.getRun("run-linked").status).toBe("stopped");
  });
});
