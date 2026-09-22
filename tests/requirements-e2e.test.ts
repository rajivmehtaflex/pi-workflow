import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RequirementsCoordinator } from "../src/requirements/coordinator.js";
import { createPiGenerator } from "../src/requirements/generator.js";
import { RequirementsNotifications } from "../src/requirements/notifications.js";
import { RequirementsRepository } from "../src/requirements/repository.js";
import { createWorkflowRunService } from "../src/service/run-service.js";
import { openWorkflowDatabase } from "../src/storage/db.js";

const repairFixture = fileURLToPath(
  new URL("./fixtures/fake-pi-generator-repair.mjs", import.meta.url),
);
const hangingFixture = fileURLToPath(new URL("./fixtures/fake-pi-generator.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for provider-free workflow state");
}

describe("requirements-to-result integration", () => {
  it("repairs, executes, reports, and reopens one durable workflow without a provider", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-e2e-"));
    roots.push(cwd);
    const database = await openWorkflowDatabase({ cwd, workspaceIdentity: "workspace-1" });
    const requests = new RequirementsRepository(database.db);
    const service = await createWorkflowRunService({
      cwd,
      database,
      requirementsRepository: requests,
      reconcile: false,
    });
    const generator = createPiGenerator({
      cwd,
      runningScript: repairFixture,
      sessionPath: join(cwd, ".pi", "generation.jsonl"),
      timeoutMs: 2_000,
    });
    const coordinator = new RequirementsCoordinator({
      cwd,
      workspaceKey: "workspace-1",
      repository: requests,
      generate: (input, signal) => generator(input, signal),
      validate: (source) => service.validate(source),
      launch: async (input) => {
        const accepted = await service.createWorkflowForRequest(input.requestId, {
          source: { script: input.source },
          caps: { maxConcurrency: input.input.maxConcurrency ?? 2 },
        });
        return { runId: accepted.runId };
      },
      stopRun: (runId) => service.stopRun(runId),
      resumeRun: async (runId) => {
        const accepted = await service.resumeRun(runId);
        return { runId: accepted.runId };
      },
    });

    coordinator.start({ requestId: "e2e", requirements: "Generate and run the review" });
    const running = await coordinator.waitFor("e2e");
    expect(running).toMatchObject({ state: "running", attempts: 2, runId: expect.any(String) });
    expect(running.source).toContain("return { ok: true }");
    expect(
      await readFile(join(cwd, ".pi", "workflow-requests", "e2e", "workflow.ts"), "utf8"),
    ).toBe(running.source);

    const run = await waitFor(
      () => service.getRun(running.runId!),
      (value) => value.status === "completed",
    );
    expect(run.result).toEqual({ ok: true });

    const sent: unknown[] = [];
    const notifications = new RequirementsNotifications({
      workspaceKey: "workspace-1",
      repository: requests,
      getRun: (runId) => service.getRun(runId),
      send: (message) => sent.push(message),
    });
    await notifications.poll();
    expect(requests.get("e2e")).toMatchObject({
      state: "completed",
      runId: running.runId,
      notificationDelivered: true,
    });
    expect((sent[0] as { result?: string }).result).toContain('"ok": true');
    notifications.dispose();
    await coordinator.dispose();
    await service.dispose();
    database.close();

    const reopened = await openWorkflowDatabase({ cwd, workspaceIdentity: "workspace-1" });
    const reopenedRequests = new RequirementsRepository(reopened.db);
    let reopenedLaunches = 0;
    const reopenedService = await createWorkflowRunService({
      cwd,
      database: reopened,
      requirementsRepository: reopenedRequests,
      reconcile: true,
      runWorkflow: async () => {
        reopenedLaunches += 1;
        return { status: "completed", value: { unexpected: true } };
      },
    });
    expect(reopenedRequests.get("e2e")).toMatchObject({
      state: "completed",
      runId: running.runId,
      notificationDelivered: true,
    });
    expect(reopenedService.getRun(running.runId!).result).toEqual({ ok: true });
    expect(reopenedLaunches).toBe(0);
    const recoveredMessages: unknown[] = [];
    const recoveredNotifications = new RequirementsNotifications({
      workspaceKey: "workspace-1",
      repository: reopenedRequests,
      getRun: (runId) => reopenedService.getRun(runId),
      send: (message) => recoveredMessages.push(message),
    });
    await recoveredNotifications.poll();
    expect(recoveredMessages).toHaveLength(0);
    recoveredNotifications.dispose();
    await reopenedService.dispose();
    reopened.close();
  });

  it("keeps preview provider-free and stops a hanging generation before admission", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-e2e-recovery-"));
    roots.push(cwd);
    const database = await openWorkflowDatabase({ cwd, workspaceIdentity: "workspace-1" });
    const requests = new RequirementsRepository(database.db);
    const service = await createWorkflowRunService({
      cwd,
      database,
      requirementsRepository: requests,
      reconcile: false,
    });
    const repair = createPiGenerator({
      cwd,
      runningScript: repairFixture,
      sessionPath: join(cwd, ".pi", "repair.jsonl"),
      timeoutMs: 2_000,
    });
    const hanging = createPiGenerator({
      cwd,
      runningScript: hangingFixture,
      sessionPath: join(cwd, ".pi", "hanging.jsonl"),
      timeoutMs: 10_000,
    });
    const coordinator = new RequirementsCoordinator({
      cwd,
      workspaceKey: "workspace-1",
      repository: requests,
      generate: (input, signal) =>
        input.requirements.includes("hang") ? hanging(input, signal) : repair(input, signal),
      validate: (source) => service.validate(source),
      launch: async (input) => {
        const accepted = await service.createWorkflowForRequest(input.requestId, {
          source: { script: input.source },
        });
        return { runId: accepted.runId };
      },
    });

    coordinator.start({ requestId: "preview", requirements: "Preview a review", preview: true });
    const preview = await coordinator.waitFor("preview");
    expect(preview.state).toBe("ready");
    expect(preview.runId).toBeUndefined();
    expect(service.listRuns()).toHaveLength(0);

    coordinator.start({ requestId: "cancel", requirements: "hang while generating" });
    await waitFor(
      () => coordinator.get("cancel").state,
      (state) => state === "generating",
    );
    await coordinator.stop("cancel");
    expect(coordinator.get("cancel")).toMatchObject({
      state: "stopped",
      error: { code: "Cancelled" },
    });
    expect(service.listRuns()).toHaveLength(0);

    await coordinator.dispose();
    await service.dispose();
    database.close();
  });
});
