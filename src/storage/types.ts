import type Database from "better-sqlite3";

export interface WorkflowDatabaseHandle {
  db: Database.Database;
  dbPath: string;
  workspaceKey: string;
  close(): void;
}

export interface ArtifactInsert {
  id: string;
  kind: string;
  title?: string;
  description?: string;
  contentType?: string;
  bytes?: number;
  sha256?: string;
  uri?: string;
  sourcePath?: string;
  spec?: unknown;
  primary?: boolean;
}

export interface SavedWorkflowRecord {
  scope: "project" | "global";
  name: string;
  sourceText: string;
  scriptHash: string;
  argsSchema?: unknown;
  updatedAt: number;
}
