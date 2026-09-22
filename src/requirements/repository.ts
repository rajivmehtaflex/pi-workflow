import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  RequirementsAttempt,
  RequirementsInput,
  RequirementsRequest,
  RequirementsRequestError,
  RequirementsRequestPatch,
  RequestState,
} from "./types.js";

export const MAX_REQUIREMENTS_BYTES = 32 * 1024;
export const DEFAULT_MAX_CONCURRENCY = 2;
export const MIN_MAX_CONCURRENCY = 1;
export const MAX_MAX_CONCURRENCY = 16;

export type RequirementsRepositoryErrorCode =
  | "InvalidRequirements"
  | "InvalidConcurrency"
  | "DuplicateRequest"
  | "WorkspaceMismatch"
  | "RequestNotFound"
  | "StaleRequest"
  | "InvalidAttempt";

export class RequirementsRepositoryError extends Error {
  constructor(
    readonly code: RequirementsRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RequirementsRepositoryError";
  }
}

interface RequirementsRepositoryOptions {
  now?: () => number;
  id?: () => string;
}

type Row = Record<string, unknown>;

const decode = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalError(value: unknown): RequirementsRequestError | undefined {
  if (value === null || typeof value !== "string") return undefined;
  const parsed = decode<unknown>(value, undefined);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  return typeof record.code === "string" && typeof record.message === "string"
    ? { code: record.code, message: record.message }
    : undefined;
}

function requestFromRow(row: Row): RequirementsRequest {
  const input = decode<RequirementsInput>(row.options_json, {
    requirements: "",
  });
  return {
    requestId: String(row.request_id),
    workspaceKey: String(row.workspace_key),
    input,
    state: row.state as RequestState,
    attempts: Number(row.attempts ?? 0),
    ...(optionalString(row.source_text) === undefined
      ? {}
      : { source: optionalString(row.source_text) }),
    ...(optionalString(row.run_id) === undefined ? {} : { runId: optionalString(row.run_id) }),
    diagnostics: decode<string[]>(row.diagnostics_json, []),
    assumptions: decode<string[]>(row.assumptions_json, []),
    acceptanceCriteria: decode<string[]>(row.acceptance_criteria_json, []),
    ...(optionalError(row.error_json) === undefined
      ? {}
      : { error: optionalError(row.error_json) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    notificationDelivered: Number(row.notification_delivered ?? 0) === 1,
  };
}

function attemptFromRow(row: Row): RequirementsAttempt {
  return {
    requestId: String(row.request_id),
    attempt: Number(row.attempt),
    source: String(row.source_text),
    diagnostics: decode<string[]>(row.diagnostics_json, []),
    createdAt: Number(row.created_at),
  };
}

function sameInput(left: RequirementsInput, right: RequirementsInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeInput(input: RequirementsInput, requestId: string): RequirementsInput {
  if (input.requirements.trim().length === 0)
    throw new RequirementsRepositoryError(
      "InvalidRequirements",
      "Requirements must contain at least one non-whitespace character",
    );
  if (Buffer.byteLength(input.requirements, "utf8") > MAX_REQUIREMENTS_BYTES)
    throw new RequirementsRepositoryError(
      "InvalidRequirements",
      `Requirements must be at most ${MAX_REQUIREMENTS_BYTES / 1024} KiB in UTF-8`,
    );
  const maxConcurrency = input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  if (
    !Number.isInteger(maxConcurrency) ||
    maxConcurrency < MIN_MAX_CONCURRENCY ||
    maxConcurrency > MAX_MAX_CONCURRENCY
  )
    throw new RequirementsRepositoryError(
      "InvalidConcurrency",
      `maxConcurrency must be between ${MIN_MAX_CONCURRENCY} and ${MAX_MAX_CONCURRENCY}`,
    );
  return {
    requestId,
    requirements: input.requirements,
    preview: input.preview ?? false,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
    maxConcurrency,
  };
}

export class RequirementsRepository {
  private transactionDepth = 0;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    private readonly db: Database.Database,
    options: RequirementsRepositoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0 || this.db.inTransaction) return operation();
    this.transactionDepth += 1;
    try {
      return this.db.transaction(operation)();
    } finally {
      this.transactionDepth -= 1;
    }
  }

  create(input: RequirementsInput, workspaceKey: string): RequirementsRequest {
    if (workspaceKey.trim().length === 0)
      throw new RequirementsRepositoryError("WorkspaceMismatch", "Workspace key is required");
    const requestId = input.requestId?.trim() || this.id();
    const normalized = normalizeInput(input, requestId);
    const existing = this.find(requestId);
    if (existing !== undefined) {
      if (existing.workspaceKey !== workspaceKey)
        throw new RequirementsRepositoryError(
          "WorkspaceMismatch",
          `Request ${requestId} belongs to another workspace`,
        );
      if (!sameInput(existing.input, normalized))
        throw new RequirementsRepositoryError(
          "DuplicateRequest",
          `Request ${requestId} already exists with different input`,
        );
      return existing;
    }

    const now = this.now();
    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO workflow_requests
            (request_id, workspace_key, options_json, state, attempts, source_text, run_id,
             diagnostics_json, assumptions_json, acceptance_criteria_json, error_json,
             created_at, updated_at, notification_delivered)
          VALUES (?, ?, ?, 'queued', 0, NULL, NULL, '[]', '[]', '[]', NULL, ?, ?, 0)
        `)
        .run(requestId, workspaceKey, JSON.stringify(normalized), now, now);
    });
    return this.get(requestId);
  }

  get(requestId: string): RequirementsRequest {
    const request = this.find(requestId);
    if (request === undefined)
      throw new RequirementsRepositoryError(
        "RequestNotFound",
        `Unknown requirements request ${requestId}`,
      );
    return request;
  }

  transition(
    requestId: string,
    expectedState: RequestState,
    patch: RequirementsRequestPatch,
  ): RequirementsRequest {
    const current = this.get(requestId);
    if (current.state !== expectedState)
      throw new RequirementsRepositoryError(
        "StaleRequest",
        `Request ${requestId} is stale: expected ${expectedState}, found ${current.state}`,
      );
    const updatedAt = this.now();
    const result = this.transaction(() =>
      this.db
        .prepare(`
          UPDATE workflow_requests
          SET state = ?, attempts = ?, source_text = ?, run_id = ?, diagnostics_json = ?,
              assumptions_json = ?, acceptance_criteria_json = ?, error_json = ?,
              updated_at = ?, notification_delivered = ?
          WHERE request_id = ? AND state = ?
        `)
        .run(
          patch.state ?? current.state,
          patch.attempts ?? current.attempts,
          patch.source === undefined ? (current.source ?? null) : patch.source,
          patch.runId === undefined ? (current.runId ?? null) : patch.runId,
          JSON.stringify(patch.diagnostics ?? current.diagnostics),
          JSON.stringify(patch.assumptions ?? current.assumptions),
          JSON.stringify(patch.acceptanceCriteria ?? current.acceptanceCriteria),
          patch.error === undefined
            ? current.error === undefined
              ? null
              : JSON.stringify(current.error)
            : patch.error === null
              ? null
              : JSON.stringify(patch.error),
          updatedAt,
          (patch.notificationDelivered ?? current.notificationDelivered) ? 1 : 0,
          requestId,
          expectedState,
        ),
    );
    if (result.changes !== 1)
      throw new RequirementsRepositoryError(
        "StaleRequest",
        `Request ${requestId} changed before transition from ${expectedState}`,
      );
    return this.get(requestId);
  }

  recordAttempt(requestId: string, attempt: number, source: string, diagnostics: string[]): void {
    this.get(requestId);
    if (!Number.isInteger(attempt) || attempt < 1)
      throw new RequirementsRepositoryError("InvalidAttempt", "Attempt must be a positive integer");
    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO workflow_request_attempts
            (request_id, attempt, source_text, diagnostics_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(requestId, attempt, source, JSON.stringify(diagnostics), this.now());
    });
  }

  listAttempts(requestId: string): RequirementsAttempt[] {
    this.get(requestId);
    return (
      this.db
        .prepare(
          `SELECT request_id, attempt, source_text, diagnostics_json, created_at
           FROM workflow_request_attempts WHERE request_id = ? ORDER BY attempt`,
        )
        .all(requestId) as Row[]
    ).map(attemptFromRow);
  }

  list(workspaceKey: string): RequirementsRequest[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM workflow_requests
           WHERE workspace_key = ? ORDER BY updated_at DESC, request_id`,
        )
        .all(workspaceKey) as Row[]
    ).map(requestFromRow);
  }

  private find(requestId: string): RequirementsRequest | undefined {
    const row = this.db
      .prepare("SELECT * FROM workflow_requests WHERE request_id = ?")
      .get(requestId) as Row | undefined;
    return row === undefined ? undefined : requestFromRow(row);
  }
}
