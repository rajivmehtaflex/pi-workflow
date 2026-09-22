import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openWorkflowDatabase } from "../src/storage/db.js";
import { WorkflowRepository } from "../src/storage/repository.js";
import {
  RequirementsRepository,
  RequirementsRepositoryError,
} from "../src/requirements/repository.js";

async function withDatabase<T>(
  callback: (repository: RequirementsRepository, db: Database.Database) => Promise<T> | T,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-requirements-"));
  const handle = await openWorkflowDatabase({ cwd, workspaceIdentity: "workspace-1" });
  try {
    return await callback(new RequirementsRepository(handle.db), handle.db);
  } finally {
    handle.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("requirements request storage", () => {
  it("migrates a version-one database without losing existing runs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-v1-"));
    const dbPath = join(cwd, ".pi", "workflows.db");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE workflow_runs (
        run_id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        args_json TEXT NOT NULL DEFAULT '{}',
        caps_json TEXT NOT NULL,
        spent_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
    `);
    legacy
      .prepare(
        `INSERT INTO workflow_runs
          (run_id, workspace_key, cwd, status, caps_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-run", "workspace-1", cwd, "completed", '{"maxConcurrency":2}', 1, 1);
    legacy.pragma("user_version = 1");
    legacy.close();

    const handle = await openWorkflowDatabase({ cwd, workspaceIdentity: "workspace-1" });
    try {
      expect(new WorkflowRepository(handle.db).getRun("legacy-run")?.status).toBe("completed");
      const request = new RequirementsRepository(handle.db).create(
        { requestId: "request-1", requirements: "Review the changed files" },
        "workspace-1",
      );
      expect(request.state).toBe("queued");
    } finally {
      handle.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("persists, reopens, and deduplicates requests by id and input", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-request-"));
    const input = {
      requestId: "request-2",
      requirements: "审核 changed files ✅",
      preview: true,
      model: "provider/model",
      thinking: "high",
      maxConcurrency: 4,
    };
    const firstHandle = await openWorkflowDatabase({ cwd, workspaceIdentity: "workspace-1" });
    const first = new RequirementsRepository(firstHandle.db).create(input, "workspace-1");
    expect(first.input).toMatchObject(input);
    firstHandle.close();

    const secondHandle = await openWorkflowDatabase({ cwd, workspaceIdentity: "workspace-1" });
    try {
      const repository = new RequirementsRepository(secondHandle.db);
      expect(repository.get("request-2")).toEqual(first);
      expect(repository.create(input, "workspace-1")).toEqual(first);
      expect(() =>
        repository.create({ ...input, requirements: "a different requirement" }, "workspace-1"),
      ).toThrowError(RequirementsRepositoryError);
      expect(() => repository.create(input, "workspace-2")).toThrowError(
        RequirementsRepositoryError,
      );
      expect(repository.list("workspace-1")).toHaveLength(1);
      expect(repository.list("workspace-2")).toHaveLength(0);
    } finally {
      secondHandle.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("enforces the UTF-8 requirement limit and compare-and-set transitions", async () => {
    await withDatabase((repository) => {
      expect(() => repository.create({ requirements: "😀".repeat(8193) }, "workspace-1")).toThrow(
        "32 KiB",
      );

      const request = repository.create(
        { requestId: "request-3", requirements: "Generate a review workflow" },
        "workspace-1",
      );
      const generating = repository.transition("request-3", "queued", {
        state: "generating",
        attempts: 1,
      });
      expect(generating.state).toBe("generating");
      expect(generating.attempts).toBe(1);
      expect(() => repository.transition(request.requestId, "queued", { state: "failed" })).toThrow(
        "stale",
      );

      repository.recordAttempt("request-3", 1, 'phase("Check"); return { ok: true };', [
        "initial candidate",
      ]);
      expect(repository.listAttempts("request-3")).toEqual([
        expect.objectContaining({ attempt: 1, diagnostics: ["initial candidate"] }),
      ]);
    });
  });

  it("rolls back a request transaction completely", async () => {
    await withDatabase((repository) => {
      expect(() =>
        repository.transaction(() => {
          repository.create(
            { requestId: "request-4", requirements: "will roll back" },
            "workspace-1",
          );
          throw new Error("admission failed");
        }),
      ).toThrow("admission failed");
      expect(repository.list("workspace-1")).toEqual([]);
    });
  });

  it("rejects invalid concurrency instead of storing an unsafe option", async () => {
    await withDatabase((repository) => {
      expect(() =>
        repository.create({ requirements: "bad concurrency", maxConcurrency: 0 }, "workspace-1"),
      ).toThrow("between 1 and 16");
      expect(() =>
        repository.create({ requirements: "bad concurrency", maxConcurrency: 17 }, "workspace-1"),
      ).toThrow("between 1 and 16");
    });
  });
});
