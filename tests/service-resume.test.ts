import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowRunService, type WorkflowRunService } from "../src/service/run-service.js";
import type { PiWorkflowDriverOptions } from "../src/service/pi-workflow-driver.js";
import type { ActorRef, ActorRecord, InstanceRef, JournalStorePort, NodeRecord, RunRecord, SessionRef, StoredEvent, WorkflowDriver } from "../src/zcode-core/engine/types.js";
import type { EscalationRecord, SavedWorkflowRecord } from "../src/storage/types.js";
import type { WorkflowRepository } from "../src/storage/repository.js";

const roots: string[] = [];
const services: WorkflowRunService[] = [];

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-service-"));
  roots.push(cwd);
  return cwd;
}

function memoryRepository(): WorkflowRepository {
  const runs = new Map<string, RunRecord>();
  const actors = new Map<string, ActorRecord>();
  const nodes = new Map<string, NodeRecord>();
  const events = new Map<string, StoredEvent[]>();
  const escalations = new Map<string, EscalationRecord>();
  const saved = new Map<string, SavedWorkflowRecord>();
  const key = (runId: string, siteId: string, ordinal: number) => `${runId}:${siteId}:${ordinal}`;
  const repo: Partial<JournalStorePort> & Record<string, unknown> = {
    transaction<T>(operation: () => T): T { return operation(); },
    createRun(record) { runs.set(record.runId, { ...record }); },
    getRun(runId) { const record = runs.get(runId); return record === undefined ? undefined : { ...record }; },
    updateRunStatus(runId, status, settlement = {}) {
      const record = runs.get(runId)!;
      runs.set(runId, { ...record, status, ...(settlement.stopReason === undefined ? {} : { stopReason: settlement.stopReason }), ...(settlement.supersededBy === undefined ? {} : { supersededBy: settlement.supersededBy }), ...(settlement.failure === undefined ? {} : { failure: settlement.failure }), ...(settlement.result === undefined ? {} : { result: settlement.result }) });
    },
    updateRunUsage(runId, spentTokens) { runs.set(runId, { ...runs.get(runId)!, spentTokens }); },
    putActor(record) { actors.set(key(record.runId, record.siteId, record.ordinal), { ...record }); },
    updateActor(record) { actors.set(key(record.runId, record.siteId, record.ordinal), { ...record }); },
    getActor(runId, siteId, ordinal) { return actors.get(key(runId, siteId, ordinal)); },
    listActors(runId) { return [...actors.values()].filter((actor) => actor.runId === runId); },
    putNode(record) { nodes.set(key(record.runId, record.siteId, record.ordinal), { ...record }); },
    updateNode(record) { nodes.set(key(record.runId, record.siteId, record.ordinal), { ...record }); },
    getNode(runId, siteId, ordinal) { return nodes.get(key(runId, siteId, ordinal)); },
    listNodes(runId) { return [...nodes.values()].filter((node) => node.runId === runId); },
    appendEvent(runId, event) {
      const list = events.get(runId) ?? [];
      const stored = { sequence: list.length + 1, event, timeCreated: Date.now() } satisfies StoredEvent;
      list.push(stored); events.set(runId, list); return stored;
    },
    listEvents(runId, options = {}) { return (events.get(runId) ?? []).filter((event) => event.sequence > (options.afterSequence ?? 0)).slice(0, options.limit); },
    listRuns(workspaceKey) { return [...runs.values()].filter((run) => run.workspaceKey === workspaceKey); },
    listNonTerminalRuns(workspaceKey) { return [...runs.values()].filter((run) => run.workspaceKey === workspaceKey && (run.status === "pending" || run.status === "running")); },
    putEscalation(record) { escalations.set(record.qid, { ...record }); },
    getEscalation(qid) { return escalations.get(qid); },
    updateEscalation(qid, status, answer) { const record = { ...escalations.get(qid)!, status, ...(answer === undefined ? {} : { answer }), ...(status === "pending" ? {} : { resolvedAt: Date.now() }) }; escalations.set(qid, record); return record; },
    listPendingEscalations(runId) { return [...escalations.values()].filter((record) => record.runId === runId && record.status === "pending"); },
    saveWorkflow(record) { saved.set(`${record.scope}:${record.name}`, { ...record }); },
    listSavedWorkflows(scope) { return [...saved.values()].filter((record) => scope === undefined || record.scope === scope); },
  };
  return repo as WorkflowRepository;
}

async function waitForTerminal(service: WorkflowRunService, runId: string): Promise<ReturnType<WorkflowRunService["getRun"]>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = service.getRun(runId);
    if (["completed", "errored", "stopped"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run did not settle: ${runId}`);
}

function fakeDriverFactory(state: { active: number; maxActive: number; starts: string[]; delayMs?: number }) {
  return (options: PiWorkflowDriverOptions): WorkflowDriver => {
    const pending = new Map<string, NodeJS.Timeout>();
    const runningSessions = new Map<string, string>();
    const sessions = new Map<string, ActorRef>();
    const activeSessions = new Set<string>();
    const queue: Array<{ session: SessionRef; instance: InstanceRef; instructions: string }> = [];
    const pump = () => {
      while (state.active < options.maxConcurrency && queue.length > 0) {
        const index = queue.findIndex((candidate) => !activeSessions.has(candidate.session.id));
        if (index < 0) return;
        const task = queue.splice(index, 1)[0]!;
        activeSessions.add(task.session.id);
        state.starts.push(task.instructions);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        const key = `${task.instance.siteId}@${task.instance.ordinal}`;
        runningSessions.set(key, task.session.id);
        const timer = setTimeout(() => {
          pending.delete(key);
          state.active -= 1;
          activeSessions.delete(task.session.id);
          runningSessions.delete(key);
          options.onResolveAsk?.(task.instance, { answer: task.instructions }, { totalTokens: 1, messageBoundary: 1 });
          pump();
        }, state.delayMs ?? 5);
        pending.set(key, timer);
      }
    };
    const reject = (instance: InstanceRef, error: Error) => {
      const key = `${instance.siteId}@${instance.ordinal}`;
      const timer = pending.get(key);
      if (timer !== undefined) clearTimeout(timer);
      if (pending.delete(key)) state.active -= 1;
      const sessionId = runningSessions.get(key);
      if (sessionId !== undefined) activeSessions.delete(sessionId);
      runningSessions.delete(key);
      const index = queue.findIndex((task) => `${task.instance.siteId}@${task.instance.ordinal}` === key);
      if (index >= 0) queue.splice(index, 1);
      options.onRejectAsk?.(instance, error);
      pump();
    };
    return {
      journal: options.journal,
      async createActorSession(actor: ActorRef): Promise<SessionRef> {
        const id = `${actor.siteId}@${actor.ordinal}`;
        sessions.set(id, actor);
        return { id };
      },
      startAsk(session, instance, message) {
        if (!sessions.has(session.id)) {
          reject(instance, new Error("unknown fake session"));
          return;
        }
        queue.push({ session, instance, instructions: message.instructions });
        pump();
      },
      respondToSubmit() {},
      cancelAsk(instance) {
        reject(instance, new Error("fake actor interrupted"));
      },
      async executeWorldRead() {
        return { ok: true };
      },
      emit() {},
      dispose() {
        for (const key of pending.keys()) {
          const [siteId, ordinal] = key.split("@");
          reject({ siteId: siteId!, ordinal: Number(ordinal) }, new Error("fake driver disposed"));
        }
      },
    };
  };
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  await Promise.all(roots.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

describe("workflow run service ownership and resume", () => {
  it("keeps same-actor asks FIFO while allowing the real Boundary-A child to run", async () => {
    const state = { active: 0, maxActive: 0, starts: [] as string[] };
    const service = await createWorkflowRunService({ cwd: await workspace(), repository: memoryRepository(), driverFactory: fakeDriverFactory(state) });
    services.push(service);
    const accepted = await service.createWorkflow({
      source: { script: `
        const reviewer = agent("reviewer");
        const first = reviewer.ask("first");
        const second = reviewer.ask("second");
        return await Promise.all([first, second]);
      ` },
      caps: { maxConcurrency: 2 },
    });
    const run = await waitForTerminal(service, accepted.runId);
    expect(run.status).toBe("completed");
    expect(state.starts).toEqual(["first", "second"]);
    expect(state.maxActive).toBe(1);
    expect(service.repository.listNodes(accepted.runId).filter((node) => node.kind === "ask").every((node) => node.status === "completed")).toBe(true);
  });

  it("enforces the global actor cap across parallel actors", async () => {
    const state = { active: 0, maxActive: 0, starts: [] as string[], delayMs: 25 };
    const service = await createWorkflowRunService({ cwd: await workspace(), repository: memoryRepository(), driverFactory: fakeDriverFactory(state) });
    services.push(service);
    const accepted = await service.createWorkflow({
      source: { script: `
        const first = agent("first");
        const second = agent("second");
        return await Promise.all([first.ask("one"), second.ask("two")]);
      ` },
      caps: { maxConcurrency: 1 },
    });
    expect((await waitForTerminal(service, accepted.runId)).status).toBe("completed");
    expect(state.maxActive).toBe(1);
  });

  it("settles stop races once and resumes only with the same source hash", async () => {
    const state = { active: 0, maxActive: 0, starts: [] as string[], delayMs: 10_000 };
    const service = await createWorkflowRunService({ cwd: await workspace(), repository: memoryRepository(), driverFactory: fakeDriverFactory(state) });
    services.push(service);
    const source = `const reviewer = agent("reviewer"); return await reviewer.ask("wait");`;
    const accepted = await service.createWorkflow({ source: { script: source } });
    for (let attempt = 0; attempt < 100 && state.active === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(service.stopRun(accepted.runId).status).toBe("stopped");
    expect((await waitForTerminal(service, accepted.runId)).stopReason).toBe("user");
    await expect(service.resumeRun(accepted.runId, { script: `${source}\nlog("changed");` })).rejects.toMatchObject({ json: { code: "ScriptHashMismatch" } });
    state.delayMs = 5;
    const resumed = await service.resumeRun(accepted.runId, { script: source });
    expect(resumed.runId).toBe(accepted.runId);
    const resumedRun = await waitForTerminal(service, resumed.runId);
    expect(resumedRun.status).toBe("completed");
  });

  it("does not wait forever for a headless escalation", async () => {
    const service = await createWorkflowRunService({ cwd: await workspace(), repository: memoryRepository(), hasUI: false });
    services.push(service);
    const accepted = await service.createWorkflow({ source: { script: `log("no escalation in facade"); return true;` } });
    const answer = service.escalation.request({ runId: accepted.runId, question: "continue?" });
    await expect(answer).rejects.toMatchObject({ json: { code: "Cancelled" } });
    expect(service.escalation.pendingForRun(accepted.runId)).toEqual([]);
    expect((await waitForTerminal(service, accepted.runId)).status).toBe("completed");
  });
});
