import Database from "better-sqlite3";
import type {
  ActorRecord,
  ArtifactVersionRecord,
  JournalStorePort,
  ListEventsOptions,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
} from "../zcode-core/engine/types.js";
import type { ArtifactInsert, SavedWorkflowRecord } from "./types.js";

type Row = Record<string, unknown>;
const encode = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));
const decode = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

function runFromRow(row: Row): RunRecord {
  return {
    runId: String(row.run_id),
    workspaceKey: String(row.workspace_key),
    cwd: String(row.cwd),
    ...(typeof row.name === "string" ? { name: row.name } : {}),
    ...(typeof row.parent_session_id === "string" ? { parentSessionId: row.parent_session_id } : {}),
    ...(typeof row.tool_call_id === "string" ? { toolCallId: row.tool_call_id } : {}),
    ...(typeof row.script_path === "string" ? { scriptPath: row.script_path } : {}),
    ...(typeof row.script_text === "string" ? { scriptText: row.script_text } : {}),
    ...(typeof row.script_hash === "string" ? { scriptHash: row.script_hash } : {}),
    args: decode(row.args_json, {}),
    caps: decode(row.caps_json, { maxConcurrency: 1 }),
    ...(typeof row.subagent_model === "string" ? { subagentModel: row.subagent_model } : {}),
    spentTokens: Number(row.spent_tokens ?? 0),
    ...(typeof row.current_phase === "string" ? { currentPhase: row.current_phase } : {}),
    ...(typeof row.resumed_from === "string" ? { resumedFrom: row.resumed_from } : {}),
    status: row.status as RunStatus,
    ...(typeof row.stop_reason === "string" ? { stopReason: row.stop_reason as RunRecord["stopReason"] } : {}),
    ...(typeof row.superseded_by === "string" ? { supersededBy: row.superseded_by } : {}),
    ...(row.failure_json === null ? {} : { failure: decode(row.failure_json, undefined) }),
    ...(row.result_json === null ? {} : { result: decode(row.result_json, undefined) }),
    createdAt: Number(row.created_at),
    ...(row.started_at === null ? {} : { startedAt: Number(row.started_at) }),
    updatedAt: Number(row.updated_at),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    schemaVersion: Number(row.schema_version ?? 1),
  };
}

function actorFromRow(row: Row): ActorRecord {
  return {
    runId: String(row.run_id),
    siteId: String(row.site_id),
    ordinal: Number(row.ordinal),
    ...(typeof row.name === "string" ? { name: row.name } : {}),
    ...(row.persona_json === null ? {} : { persona: decode(row.persona_json, {}) }),
    ...(typeof row.session_id === "string" ? { sessionId: row.session_id } : {}),
    ...(typeof row.session_path === "string" ? { sessionPath: row.session_path } : {}),
    ...(typeof row.resolved_model === "string" ? { resolvedModel: row.resolved_model } : {}),
    ...(row.session_message_count === null ? {} : { sessionMessageCount: Number(row.session_message_count) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function nodeFromRow(row: Row): NodeRecord {
  return {
    runId: String(row.run_id),
    siteId: String(row.site_id),
    ordinal: Number(row.ordinal),
    kind: row.kind as NodeRecord["kind"],
    ...(typeof row.actor_site_id === "string" ? { actorSiteId: row.actor_site_id } : {}),
    ...(row.actor_ordinal === null ? {} : { actorOrdinal: Number(row.actor_ordinal) }),
    ...(row.actor_seq === null ? {} : { actorSeq: Number(row.actor_seq) }),
    inputHash: String(row.input_hash),
    ...(row.input_json === null ? {} : { input: decode(row.input_json, undefined) }),
    status: row.status as NodeRecord["status"],
    ...(row.result_json === null ? {} : { result: decode(row.result_json, undefined) }),
    ...(row.error_json === null ? {} : { error: decode(row.error_json, undefined) }),
    ...(row.stats_json === null ? {} : { stats: decode(row.stats_json, undefined) }),
    ...(typeof row.artifact_id === "string" ? { artifactId: row.artifact_id } : {}),
    ...(row.message_boundary === null ? {} : { messageBoundary: Number(row.message_boundary) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class WorkflowRepository implements JournalStorePort {
  private transactionDepth = 0;

  constructor(protected readonly db: Database.Database) {}

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.transactionDepth += 1;
    try {
      return this.db.transaction(operation)();
    } finally {
      this.transactionDepth -= 1;
    }
  }

  createRun(record: RunRecord): void {
    const now = record.updatedAt ?? Date.now();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO workflow_runs
        (run_id, workspace_key, cwd, name, status, parent_session_id, tool_call_id, script_path, script_text,
         script_hash, args_json, caps_json, subagent_model, spent_tokens, current_phase, resumed_from,
         created_at, started_at, updated_at, schema_version)
        VALUES (@runId, @workspaceKey, @cwd, @name, @status, @parentSessionId, @toolCallId, @scriptPath,
          @scriptText, @scriptHash, @argsJson, @capsJson, @subagentModel, @spentTokens, @currentPhase,
          @resumedFrom, @createdAt, @startedAt, @updatedAt, @schemaVersion)
      `).run({
        runId: record.runId,
        workspaceKey: record.workspaceKey ?? record.cwd ?? "",
        cwd: record.cwd ?? "",
        name: record.name ?? null,
        status: record.status,
        parentSessionId: record.parentSessionId ?? null,
        toolCallId: record.toolCallId ?? null,
        scriptPath: record.scriptPath ?? null,
        scriptText: record.scriptText ?? null,
        scriptHash: record.scriptHash ?? null,
        argsJson: JSON.stringify(record.args ?? {}),
        capsJson: JSON.stringify(record.caps),
        subagentModel: record.subagentModel ?? null,
        spentTokens: record.spentTokens,
        currentPhase: record.currentPhase ?? null,
        resumedFrom: record.resumedFrom ?? null,
        createdAt: record.createdAt ?? now,
        startedAt: record.startedAt ?? (record.status === "running" ? now : null),
        updatedAt: now,
        schemaVersion: record.schemaVersion ?? 1,
      });
    });
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId) as Row | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    this.transaction(() => {
      const now = Date.now();
      const resultJson = settlement?.result === undefined ? null : encode(settlement.result);
      const result = this.db.prepare(`
        UPDATE workflow_runs SET status = @status, stop_reason = @stopReason, superseded_by = @supersededBy,
          failure_json = @failureJson, result_json = COALESCE(@resultJson, result_json),
          updated_at = @updatedAt, completed_at = CASE WHEN @terminal = 1 THEN @updatedAt ELSE completed_at END,
          started_at = CASE WHEN @status = 'running' AND started_at IS NULL THEN @updatedAt ELSE started_at END
        WHERE run_id = @runId
      `).run({
        runId,
        status,
        stopReason: settlement?.stopReason ?? null,
        supersededBy: settlement?.supersededBy ?? null,
        failureJson: encode(settlement?.failure),
        resultJson,
        updatedAt: now,
        terminal: status === "completed" || status === "errored" || status === "stopped" ? 1 : 0,
      });
      if (result.changes !== 1) throw new Error(`workflow journal: unknown run ${runId}`);
      if (status === "pending" || status === "running") {
        this.db.prepare("UPDATE workflow_runs SET failure_json = NULL, result_json = NULL, stop_reason = NULL, superseded_by = NULL WHERE run_id = ?").run(runId);
      }
    });
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    const result = this.db.prepare("UPDATE workflow_runs SET spent_tokens = ?, updated_at = ? WHERE run_id = ?").run(spentTokens, Date.now(), runId);
    if (result.changes !== 1) throw new Error(`workflow journal: unknown run ${runId}`);
  }

  putActor(record: ActorRecord): void {
    const now = record.updatedAt ?? Date.now();
    this.db.prepare(`
      INSERT INTO workflow_actors
      (run_id, site_id, ordinal, name, persona_json, resolved_model, session_id, session_path,
       session_message_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.runId, record.siteId, record.ordinal, record.name ?? null, encode(record.persona), record.resolvedModel ?? null, record.sessionId ?? null, record.sessionPath ?? null, record.sessionMessageCount ?? null, record.createdAt ?? now, now);
  }

  updateActor(record: ActorRecord): void {
    const result = this.db.prepare(`
      UPDATE workflow_actors SET name = ?, persona_json = ?, resolved_model = ?, session_id = ?, session_path = ?,
        session_message_count = ?, updated_at = ? WHERE run_id = ? AND site_id = ? AND ordinal = ?
    `).run(record.name ?? null, encode(record.persona), record.resolvedModel ?? null, record.sessionId ?? null, record.sessionPath ?? null, record.sessionMessageCount ?? null, Date.now(), record.runId, record.siteId, record.ordinal);
    if (result.changes !== 1) throw new Error("workflow journal: unknown actor");
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const row = this.db.prepare("SELECT * FROM workflow_actors WHERE run_id = ? AND site_id = ? AND ordinal = ?").get(runId, siteId, ordinal) as Row | undefined;
    return row === undefined ? undefined : actorFromRow(row);
  }

  listActors(runId: string): ActorRecord[] {
    return (this.db.prepare("SELECT * FROM workflow_actors WHERE run_id = ? ORDER BY site_id, ordinal").all(runId) as Row[]).map(actorFromRow);
  }

  putNode(record: NodeRecord): void {
    const now = record.updatedAt ?? Date.now();
    this.db.prepare(`
      INSERT INTO workflow_nodes
      (run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq, input_hash, input_json,
       status, result_json, error_json, stats_json, artifact_id, message_boundary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.runId, record.siteId, record.ordinal, record.kind, record.actorSiteId ?? null, record.actorOrdinal ?? null, record.actorSeq ?? null, record.inputHash, encode(record.input), record.status, encode(record.result), encode(record.error), encode(record.stats), record.artifactId ?? null, record.messageBoundary ?? null, record.createdAt ?? now, now);
  }

  updateNode(record: NodeRecord): void {
    const result = this.db.prepare(`
      UPDATE workflow_nodes SET status = ?, input_hash = ?, input_json = ?, result_json = ?, error_json = ?,
        stats_json = ?, artifact_id = ?, message_boundary = ?, updated_at = ?
      WHERE run_id = ? AND site_id = ? AND ordinal = ?
    `).run(record.status, record.inputHash, encode(record.input), encode(record.result), encode(record.error), encode(record.stats), record.artifactId ?? null, record.messageBoundary ?? null, Date.now(), record.runId, record.siteId, record.ordinal);
    if (result.changes !== 1) throw new Error("workflow journal: unknown node");
  }

  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined {
    const row = this.db.prepare("SELECT * FROM workflow_nodes WHERE run_id = ? AND site_id = ? AND ordinal = ?").get(runId, siteId, ordinal) as Row | undefined;
    return row === undefined ? undefined : nodeFromRow(row);
  }

  listNodes(runId: string): NodeRecord[] {
    return (this.db.prepare("SELECT * FROM workflow_nodes WHERE run_id = ? ORDER BY site_id, ordinal").all(runId) as Row[]).map(nodeFromRow);
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
    return this.transaction(() => {
      if (this.getRun(runId) === undefined) throw new Error(`workflow journal: unknown run ${runId}`);
      const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM workflow_journal WHERE run_id = ?").get(runId) as Row;
      const sequence = Number(row.sequence);
      const timeCreated = Date.now();
      this.db.prepare("INSERT INTO workflow_journal (run_id, sequence, event_type, payload_json, time_created) VALUES (?, ?, ?, ?, ?)").run(runId, sequence, event.type, JSON.stringify(event), timeCreated);
      return { sequence, event, timeCreated };
    });
  }

  listEvents(runId: string, options: ListEventsOptions = {}): StoredEvent[] {
    const after = options.afterSequence ?? 0;
    const limit = options.limit === undefined ? undefined : Math.max(0, Math.min(1000, Math.floor(options.limit)));
    const rows = limit === undefined
      ? this.db.prepare("SELECT sequence, payload_json, time_created FROM workflow_journal WHERE run_id = ? AND sequence > ? ORDER BY sequence").all(runId, after)
      : this.db.prepare("SELECT sequence, payload_json, time_created FROM workflow_journal WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?").all(runId, after, limit);
    return (rows as Row[]).map((row) => ({ sequence: Number(row.sequence), event: decode(row.payload_json, {} as RunEvent), timeCreated: Number(row.time_created) }));
  }

  insertArtifactVersion(runId: string, artifact: ArtifactInsert): ArtifactVersionRecord {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM workflow_artifacts WHERE run_id = ? AND artifact_id = ?").get(runId, artifact.id) as Row;
      const version = Number(row.version);
      const createdAt = Date.now();
      this.db.prepare(`
        INSERT INTO workflow_artifacts
        (run_id, artifact_id, version, kind, title, description, content_type, bytes, sha256, uri, source_path, spec_json, primary_artifact, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(runId, artifact.id, version, artifact.kind, artifact.title ?? null, artifact.description ?? null, artifact.contentType ?? null, artifact.bytes ?? null, artifact.sha256 ?? null, artifact.uri ?? null, artifact.sourcePath ?? null, encode(artifact.spec), artifact.primary ? 1 : 0, createdAt);
      return { id: artifact.id, version, kind: artifact.kind as ArtifactVersionRecord["kind"], ...(artifact.title ? { title: artifact.title } : {}), ...(artifact.description ? { description: artifact.description } : {}), ...(artifact.contentType ? { contentType: artifact.contentType } : {}), ...(artifact.bytes === undefined ? {} : { bytes: artifact.bytes }), ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}), ...(artifact.uri ? { uri: artifact.uri } : {}), ...(artifact.sourcePath ? { sourcePath: artifact.sourcePath } : {}), ...(artifact.spec === undefined ? {} : { spec: artifact.spec }), ...(artifact.primary ? { primary: true as const } : {}), createdAt };
    });
  }

  listArtifactVersions(runId: string, artifactId: string): ArtifactVersionRecord[] {
    return (this.db.prepare("SELECT * FROM workflow_artifacts WHERE run_id = ? AND artifact_id = ? ORDER BY version").all(runId, artifactId) as Row[]).map((row) => ({ id: String(row.artifact_id), version: Number(row.version), kind: row.kind as ArtifactVersionRecord["kind"], ...(typeof row.title === "string" ? { title: row.title } : {}), ...(typeof row.description === "string" ? { description: row.description } : {}), ...(typeof row.content_type === "string" ? { contentType: row.content_type } : {}), ...(row.bytes === null ? {} : { bytes: Number(row.bytes) }), ...(typeof row.sha256 === "string" ? { sha256: row.sha256 } : {}), ...(typeof row.uri === "string" ? { uri: row.uri } : {}), ...(typeof row.source_path === "string" ? { sourcePath: row.source_path } : {}), ...(row.spec_json === null ? {} : { spec: decode(row.spec_json, undefined) }), ...(row.primary_artifact ? { primary: true as const } : {}), createdAt: Number(row.created_at) }));
  }

  listRuns(workspaceKey: string, limit = 20): RunRecord[] {
    return (this.db.prepare("SELECT * FROM workflow_runs WHERE workspace_key = ? ORDER BY updated_at DESC LIMIT ?").all(workspaceKey, Math.max(1, Math.min(100, Math.floor(limit)))) as Row[]).map(runFromRow);
  }

  listNonTerminalRuns(workspaceKey: string): RunRecord[] {
    return (this.db.prepare("SELECT * FROM workflow_runs WHERE workspace_key = ? AND status IN ('pending','running') ORDER BY updated_at DESC").all(workspaceKey) as Row[]).map(runFromRow);
  }

  saveWorkflow(record: SavedWorkflowRecord): void {
    this.db.prepare(`INSERT INTO workflow_saved_workflows (scope, name, source_text, script_hash, args_schema_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope, name) DO UPDATE SET source_text = excluded.source_text,
      script_hash = excluded.script_hash, args_schema_json = excluded.args_schema_json, updated_at = excluded.updated_at`).run(record.scope, record.name, record.sourceText, record.scriptHash, encode(record.argsSchema), record.updatedAt);
  }

  listSavedWorkflows(scope?: SavedWorkflowRecord["scope"]): SavedWorkflowRecord[] {
    const rows = scope === undefined
      ? this.db.prepare("SELECT * FROM workflow_saved_workflows ORDER BY scope, name").all()
      : this.db.prepare("SELECT * FROM workflow_saved_workflows WHERE scope = ? ORDER BY name").all(scope);
    return (rows as Row[]).map((row) => ({ scope: row.scope as SavedWorkflowRecord["scope"], name: String(row.name), sourceText: String(row.source_text), scriptHash: String(row.script_hash), ...(row.args_schema_json === null ? {} : { argsSchema: decode(row.args_schema_json, undefined) }), updatedAt: Number(row.updated_at) }));
  }
}

export function createWorkflowRepository(db: Database.Database): WorkflowRepository {
  return new WorkflowRepository(db);
}
