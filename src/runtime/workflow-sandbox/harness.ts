import { join } from "node:path";
import { writeWorkflowEntryFile } from "./entry-file.js";
import { spawnWorkflowChild, terminateWorkflowChild } from "./process.js";
import {
  NdjsonLineParser,
  WorkflowProtocolError,
  encodeParentMessage,
  type ChildCreateActorMessage,
  type ChildEventMessage,
  type ChildRequestMessage,
  type WireError,
} from "./protocol.js";
import type { WorkflowErrorJson } from "../../zcode-core/engine/types.js";

export interface RunSettlement {
  status: "completed" | "errored" | "stopped";
  value?: unknown;
  error?: WireError | WorkflowErrorJson;
  stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded";
}

export interface RunWorkflowScriptOptions {
  runId: string;
  cwd: string;
  code: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxLineBytes?: number;
  maxStderrBytes?: number;
  entrySource?: string;
  onCreateActor?(message: ChildCreateActorMessage): void | Promise<void>;
  onEvent?(message: ChildEventMessage): void | Promise<void>;
  onRequest?(message: ChildRequestMessage): unknown | Promise<unknown>;
}

function errorWire(error: unknown): WireError {
  if (
    typeof error === "object" &&
    error !== null &&
    "json" in error &&
    typeof error.json === "object" &&
    error.json !== null &&
    "code" in error.json &&
    "message" in error.json &&
    typeof error.json.code === "string" &&
    typeof error.json.message === "string"
  )
    return { code: error.json.code, message: error.json.message, details: error.json };
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    const record = error as Record<string, unknown>;
    const details =
      typeof record.details === "object" && record.details !== null ? record.details : error;
    return { code: error.code, message: error.message, details };
  }
  if (error instanceof Error) return { code: "DriverError", message: error.message };
  return { code: "DriverError", message: String(error) };
}

export async function runWorkflowScript(options: RunWorkflowScriptOptions): Promise<RunSettlement> {
  const runDir = join(options.cwd, ".pi", "workflow-runs", options.runId);
  let entryPath: string;
  try {
    entryPath = await writeWorkflowEntryFile({
      runDir,
      runId: options.runId,
      code: options.code,
      args: options.args,
      source: options.entrySource,
    });
  } catch (error) {
    return { status: "stopped", stopReason: "interrupted", error: errorWire(error) };
  }
  const child = spawnWorkflowChild({ entryPath, cwd: options.cwd });
  const parser = new NdjsonLineParser({ maxLineBytes: options.maxLineBytes ?? 256 * 1024 });
  const seenRequests = new Set<string>();
  let stderrBytes = 0;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveSettlement: (settlement: RunSettlement) => void = () => undefined;
  const result = new Promise<RunSettlement>((resolve) => {
    resolveSettlement = resolve;
  });
  const finish = (settlement: RunSettlement): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    child.stdin.end();
    resolveSettlement(settlement);
    void terminateWorkflowChild(child).catch(() => undefined);
  };
  const protocolFailure = (error: unknown): void =>
    finish({ status: "stopped", stopReason: "interrupted", error: errorWire(error) });
  const handle = (message: ReturnType<typeof parser.push>[number]): void => {
    if (settled) return;
    if (message.kind === "complete") {
      if (message.ok)
        finish({
          status: "completed",
          ...(message.value === undefined ? {} : { value: message.value }),
        });
      else finish({ status: "errored", ...(message.error ? { error: message.error } : {}) });
      return;
    }
    if (message.kind === "create-actor") {
      void Promise.resolve(options.onCreateActor?.(message)).catch(protocolFailure);
      return;
    }
    if (message.kind === "event") {
      void Promise.resolve(options.onEvent?.(message)).catch(protocolFailure);
      return;
    }
    if (seenRequests.has(message.id)) {
      protocolFailure(
        new WorkflowProtocolError(`Duplicate request id: ${message.id}`, "DuplicateRequest"),
      );
      return;
    }
    seenRequests.add(message.id);
    void Promise.resolve()
      .then(() => options.onRequest?.(message))
      .then(
        (value) => {
          if (!settled)
            child.stdin.write(
              encodeParentMessage({
                kind: "response",
                id: message.id,
                ok: true,
                ...(value === undefined ? {} : { value }),
              }),
            );
        },
        (error) => {
          if (!settled)
            child.stdin.write(
              encodeParentMessage({
                kind: "response",
                id: message.id,
                ok: false,
                error: errorWire(error),
              }),
            );
        },
      )
      .catch(protocolFailure);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const message of parser.push(chunk)) handle(message);
    } catch (error) {
      protocolFailure(error);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > (options.maxStderrBytes ?? 64 * 1024))
      protocolFailure(new WorkflowProtocolError("Child stderr exceeds limit", "StderrTooLarge"));
  });
  child.on("error", protocolFailure);
  child.on("close", (code) => {
    if (settled) return;
    try {
      parser.end();
      finish({
        status: "stopped",
        stopReason: "interrupted",
        error: {
          code: "ChildExit",
          message: `Workflow child exited before complete (code ${code ?? "unknown"})`,
        },
      });
    } catch (error) {
      protocolFailure(error);
    }
  });
  timer = setTimeout(
    () => protocolFailure(new WorkflowProtocolError("Workflow child timed out", "Timeout")),
    options.timeoutMs ?? 300_000,
  );
  if (options.signal !== undefined) {
    if (options.signal.aborted)
      protocolFailure(new WorkflowProtocolError("Workflow run aborted", "Aborted"));
    else
      options.signal.addEventListener(
        "abort",
        () => protocolFailure(new WorkflowProtocolError("Workflow run aborted", "Aborted")),
        { once: true },
      );
  }
  return result;
}
