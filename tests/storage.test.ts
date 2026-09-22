import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkflowDatabase } from "../src/storage/db.js";
import { WorkflowJournal } from "../src/storage/journal.js";
import type { RunRecord, RunEvent } from "../src/zcode-core/engine/types.js";

const workspaces: string[] = [];

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-storage-"));
  workspaces.push(cwd);
  return cwd;
}

function runRecord(runId = "run-1"): RunRecord {
  return {
    runId,
    workspaceKey: "workspace-1",
    cwd: "/workspace",
    scriptText: 'phase("review");',
    scriptHash: "hash-1",
    args: { target: "src" },
    caps: { maxConcurrency: 2 },
    spentTokens: 0,
    status: "pending",
    createdAt: 1,
  };
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

describe("SQLite workflow journal", () => {
  it("creates a safe .pi database, migrates it, and reopens idempotently", async () => {
    const cwd = await makeWorkspace();
    const first = await openWorkflowDatabase({ cwd, workspaceIdentity: " workspace-1 " });
    expect(first.dbPath).toBe(join(cwd, ".pi", "workflows.db"));
    expect(first.workspaceKey).toBe("workspace-1");
    expect(first.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(first.db.pragma("user_version", { simple: true })).toBeGreaterThan(0);
    first.close();

    const second = await openWorkflowDatabase({ cwd, workspaceIdentity: "workspace-1" });
    expect(second.db.pragma("user_version", { simple: true })).toBe(2);
    await readFile(second.dbPath);
    second.close();
  });

  it("persists runs, actors, nodes, usage, script hashes, and terminal settlement atomically", async () => {
    const database = await openWorkflowDatabase({ cwd: await makeWorkspace() });
    const journal = new WorkflowJournal(database.db);
    journal.createRun(runRecord());
    journal.putActor({ runId: "run-1", siteId: "actor#1", ordinal: 1, name: "reviewer" });
    journal.putNode({
      runId: "run-1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "input-1",
      status: "running",
    });
    journal.updateRunUsage("run-1", 42);
    journal.updateRunStatus("run-1", "completed", { result: { ok: true } });

    expect(journal.getRun("run-1")).toMatchObject({
      status: "completed",
      spentTokens: 42,
      scriptHash: "hash-1",
      result: { ok: true },
    });
    expect(journal.listActors("run-1")).toHaveLength(1);
    expect(journal.listNodes("run-1")).toHaveLength(1);
    database.close();
  });

  it("rejects duplicate actor and node identities", async () => {
    const database = await openWorkflowDatabase({ cwd: await makeWorkspace() });
    const journal = new WorkflowJournal(database.db);
    journal.createRun(runRecord());
    journal.putActor({ runId: "run-1", siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: "run-1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "input-1",
      status: "running",
    });
    expect(() => journal.putActor({ runId: "run-1", siteId: "actor#1", ordinal: 1 })).toThrow();
    expect(() =>
      journal.putNode({
        runId: "run-1",
        siteId: "ask#1",
        ordinal: 1,
        kind: "ask",
        inputHash: "input-2",
        status: "running",
      }),
    ).toThrow();
    database.close();
  });

  it("allocates journal sequences and paginates after a cursor in SQL order", async () => {
    const database = await openWorkflowDatabase({ cwd: await makeWorkspace() });
    const journal = new WorkflowJournal(database.db);
    journal.createRun(runRecord());
    const events: RunEvent[] = [
      { type: "log", message: "one" },
      { type: "log", message: "two" },
      { type: "log", message: "three" },
    ];
    events.forEach((event) => journal.appendEvent("run-1", event));
    expect(
      journal.listEvents("run-1", { afterSequence: 1, limit: 1 }).map((event) => event.event),
    ).toEqual([events[1]]);
    expect(journal.listEvents("missing", { afterSequence: 0, limit: 2 })).toEqual([]);
    database.close();
  });

  it("versions immutable artifacts and preserves resume mismatch data", async () => {
    const database = await openWorkflowDatabase({ cwd: await makeWorkspace() });
    const journal = new WorkflowJournal(database.db);
    journal.createRun(runRecord());
    const first = journal.insertArtifactVersion("run-1", {
      id: "report",
      kind: "markdown",
      bytes: 4,
      sha256: "a",
    });
    const second = journal.insertArtifactVersion("run-1", {
      id: "report",
      kind: "markdown",
      bytes: 5,
      sha256: "b",
    });
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(journal.listArtifactVersions("run-1", "report")).toHaveLength(2);
    expect(journal.getRun("run-1")?.scriptHash).toBe("hash-1");
    database.close();
  });

  it("rolls back a transaction and keeps unknown reads empty", async () => {
    const database = await openWorkflowDatabase({ cwd: await makeWorkspace() });
    const journal = new WorkflowJournal(database.db);
    journal.createRun(runRecord());
    expect(() =>
      journal.transaction(() => {
        journal.updateRunStatus("run-1", "running");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(journal.getRun("run-1")?.status).toBe("pending");
    expect(journal.getActor("missing", "actor", 1)).toBeUndefined();
    expect(journal.listEvents("missing")).toEqual([]);
    database.close();
  });
});
