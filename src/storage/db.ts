import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations } from "./migrations.js";
import type { WorkflowDatabaseHandle } from "./types.js";

export interface OpenWorkflowDatabaseOptions {
  cwd: string;
  workspaceIdentity?: string;
}

export async function openWorkflowDatabase(options: OpenWorkflowDatabaseOptions): Promise<WorkflowDatabaseHandle> {
  const cwd = resolve(options.cwd);
  const dbPath = resolve(cwd, ".pi", "workflows.db");
  await mkdir(resolve(cwd, ".pi"), { recursive: true });
  const db = new Database(dbPath);
  applyMigrations(db);
  return {
    db,
    dbPath,
    workspaceKey: options.workspaceIdentity?.trim() || cwd,
    close: () => db.close(),
  };
}
