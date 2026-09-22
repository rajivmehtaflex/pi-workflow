import type Database from "better-sqlite3";

export const LATEST_SCHEMA_VERSION = 2;

const migrations: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        cwd TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','running','completed','errored','stopped')),
        stop_reason TEXT,
        superseded_by TEXT,
        parent_session_id TEXT,
        tool_call_id TEXT,
        script_path TEXT,
        script_text TEXT,
        script_hash TEXT,
        args_json TEXT NOT NULL DEFAULT '{}',
        caps_json TEXT NOT NULL,
        subagent_model TEXT,
        spent_tokens INTEGER NOT NULL DEFAULT 0,
        current_phase TEXT,
        resumed_from TEXT,
        result_json TEXT,
        failure_json TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS workflow_runs_workspace_updated
        ON workflow_runs(workspace_key, updated_at DESC);
      CREATE TABLE IF NOT EXISTS workflow_actors (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        site_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        name TEXT,
        persona_json TEXT,
        resolved_model TEXT,
        session_id TEXT,
        session_path TEXT,
        session_message_count INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, site_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS workflow_nodes (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        site_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor_site_id TEXT,
        actor_ordinal INTEGER,
        actor_seq INTEGER,
        input_hash TEXT NOT NULL,
        input_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
        result_json TEXT,
        error_json TEXT,
        stats_json TEXT,
        artifact_id TEXT,
        message_boundary INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, site_id, ordinal)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS workflow_nodes_actor_sequence
        ON workflow_nodes(run_id, actor_site_id, actor_ordinal, actor_seq)
        WHERE actor_site_id IS NOT NULL AND actor_ordinal IS NOT NULL AND actor_seq IS NOT NULL;
      CREATE TABLE IF NOT EXISTS workflow_journal (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS workflow_artifacts (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT,
        description TEXT,
        content_type TEXT,
        bytes INTEGER,
        sha256 TEXT,
        uri TEXT,
        source_path TEXT,
        spec_json TEXT,
        primary_artifact INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, artifact_id, version)
      );
      CREATE TABLE IF NOT EXISTS workflow_escalations (
        qid TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        actor_site_id TEXT,
        actor_ordinal INTEGER,
        question TEXT NOT NULL,
        context TEXT,
        asked_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','resolved','cancelled')),
        answer TEXT,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS workflow_escalations_run_status
        ON workflow_escalations(run_id, status);
      CREATE TABLE IF NOT EXISTS workflow_saved_workflows (
        scope TEXT NOT NULL CHECK (scope IN ('project','global')),
        name TEXT NOT NULL,
        source_text TEXT NOT NULL,
        script_hash TEXT NOT NULL,
        args_schema_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, name)
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_requests (
        request_id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        options_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'queued','generating','validating','repairing','ready','launching','running',
          'completed','failed','stopped'
        )),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        source_text TEXT,
        run_id TEXT UNIQUE REFERENCES workflow_runs(run_id) ON DELETE SET NULL,
        diagnostics_json TEXT NOT NULL DEFAULT '[]',
        assumptions_json TEXT NOT NULL DEFAULT '[]',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        notification_delivered INTEGER NOT NULL DEFAULT 0 CHECK (notification_delivered IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS workflow_requests_workspace_updated
        ON workflow_requests(workspace_key, updated_at DESC);
      CREATE TABLE IF NOT EXISTS workflow_request_attempts (
        request_id TEXT NOT NULL REFERENCES workflow_requests(request_id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        source_text TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (request_id, attempt)
      );
    `,
  },
];

export function applyMigrations(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const current = Number(db.pragma("user_version", { simple: true }) ?? 0);
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
