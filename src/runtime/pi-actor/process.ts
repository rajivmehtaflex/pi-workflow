import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Violation } from "../../zcode-core/engine/types.js";
import { resolvePiInvocation, type PiInvocationOptions } from "./invocation.js";
import { PiJsonProtocolError, type PiJsonEvent, type PiUsage } from "./json-events.js";
import { aggregatePiTurn, PiJsonStreamParser } from "./stream-parser.js";

export interface ActorTurnError {
  code: string;
  message: string;
  finalText?: string;
  violations?: Violation[];
}

export interface ActorTurnCompleted {
  status: "completed";
  sessionPath: string;
  text?: string;
  value?: unknown;
  stopReason?: string;
  usage?: PiUsage;
  model?: string;
  progressText: string;
  toolEvents: PiJsonEvent[];
}

export interface ActorTurnErrored {
  status: "errored";
  sessionPath: string;
  error: ActorTurnError;
  text?: string;
  usage?: PiUsage;
  model?: string;
  progressText: string;
  toolEvents: PiJsonEvent[];
}

export interface ActorTurnStopped {
  status: "stopped";
  sessionPath: string;
  stopReason: "interrupted" | "provider" | "user";
  error?: ActorTurnError;
  text?: string;
  usage?: PiUsage;
  model?: string;
  progressText: string;
  toolEvents: PiJsonEvent[];
}

export type ActorTurnSettlement = ActorTurnCompleted | ActorTurnErrored | ActorTurnStopped;

export interface ActorResultPolicy {
  parseJson?: boolean;
  validate?(value: unknown): Violation[];
}

export interface SpawnPiActorTurnOptions extends PiInvocationOptions {
  cwd: string;
  executable?: string;
  executableArgs?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  maxLineBytes?: number;
  maxStderrBytes?: number;
  maxEvents?: number;
  result?: ActorResultPolicy;
  onUpdate?(event: PiJsonEvent): void | Promise<void>;
  onEvent?(event: PiJsonEvent): void | Promise<void>;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const allowed =
    /^(PATH|HOME|USERPROFILE|APPDATA|XDG_CONFIG_HOME|XDG_DATA_HOME|TMPDIR|TEMP|TMP|LANG|LC_ALL|TERM|CI|PI_|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|AZURE_OPENAI_)/;
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.test(key)),
  );
}

function protocolError(error: unknown): ActorTurnError {
  if (error instanceof PiJsonProtocolError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "ActorDriverError", message: error.message };
  return { code: "ActorDriverError", message: String(error) };
}

function sendSignal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child may have exited between the status check and the signal.
    }
  }
}

async function terminatePiChild(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  sendSignal(child, "SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      sendSignal(child, "SIGKILL");
      resolve();
    }, graceMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function emptyAggregate() {
  return { progressText: "", toolEvents: [] as PiJsonEvent[] };
}

function makeStopped(
  sessionPath: string,
  reason: ActorTurnStopped["stopReason"],
  error?: ActorTurnError,
): ActorTurnStopped {
  return {
    status: "stopped",
    sessionPath,
    stopReason: reason,
    ...(error === undefined ? {} : { error }),
    ...emptyAggregate(),
  };
}

function parseResult(
  text: string | undefined,
  policy: ActorResultPolicy | undefined,
): { value?: unknown; error?: ActorTurnError } {
  if (policy?.parseJson !== true && policy?.validate === undefined) return {};
  if (text === undefined)
    return {
      error: {
        code: "ValidationFailed",
        message: "Pi actor did not submit a text result",
        finalText: text,
      },
    };
  let value: unknown = text;
  if (policy.parseJson === true) {
    try {
      value = JSON.parse(text);
    } catch {
      return {
        error: {
          code: "ValidationFailed",
          message: "Pi actor result is not valid JSON",
          finalText: text,
        },
      };
    }
  }
  const violations = policy.validate?.(value) ?? [];
  return violations.length === 0
    ? { value }
    : {
        error: {
          code: "ValidationFailed",
          message: "Pi actor result failed schema validation",
          finalText: text,
          violations,
        },
      };
}

export async function spawnPiActorTurn(
  options: SpawnPiActorTurnOptions,
): Promise<ActorTurnSettlement> {
  if (options.signal?.aborted)
    return makeStopped(options.sessionPath, "interrupted", {
      code: "Aborted",
      message: "Pi actor turn was aborted before launch",
    });
  try {
    await mkdir(dirname(options.sessionPath), { recursive: true });
  } catch (error) {
    return {
      status: "errored",
      sessionPath: options.sessionPath,
      error: protocolError(error),
      ...emptyAggregate(),
    };
  }

  const invocation =
    options.executableArgs === undefined
      ? resolvePiInvocation(options)
      : { executable: options.executable ?? process.execPath, args: options.executableArgs };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(invocation.executable, invocation.args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: childEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      status: "errored",
      sessionPath: options.sessionPath,
      error: protocolError(error),
      ...emptyAggregate(),
    };
  }

  const parser = new PiJsonStreamParser({ maxLineBytes: options.maxLineBytes ?? 256 * 1024 });
  const events: PiJsonEvent[] = [];
  const maxEvents = options.maxEvents ?? 4096;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  const killGraceMs = options.killGraceMs ?? 100;
  let stderrBytes = 0;
  let settled = false;
  let finalMessageTimer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let resolveSettlement: (settlement: ActorTurnSettlement) => void = () => undefined;
  const result = new Promise<ActorTurnSettlement>((resolve) => {
    resolveSettlement = resolve;
  });

  const currentAggregate = () => aggregatePiTurn(events);
  const finish = (settlement: ActorTurnSettlement): void => {
    if (settled) return;
    settled = true;
    if (finalMessageTimer !== undefined) clearTimeout(finalMessageTimer);
    if (timeout !== undefined) clearTimeout(timeout);
    resolveSettlement(settlement);
    void terminatePiChild(child, killGraceMs).catch(() => undefined);
  };
  const stop = (reason: ActorTurnStopped["stopReason"], error?: ActorTurnError): void => {
    const aggregate = currentAggregate();
    finish({
      status: "stopped",
      sessionPath: options.sessionPath,
      stopReason: reason,
      ...(error === undefined ? {} : { error }),
      ...(aggregate.text === undefined ? {} : { text: aggregate.text }),
      ...(aggregate.usage === undefined ? {} : { usage: aggregate.usage }),
      ...(aggregate.model === undefined ? {} : { model: aggregate.model }),
      progressText: aggregate.progressText,
      toolEvents: aggregate.toolEvents,
    });
  };
  const complete = (): void => {
    const aggregate = currentAggregate();
    const parsed = parseResult(aggregate.text, options.result);
    if (parsed.error !== undefined) {
      finish({
        status: "errored",
        sessionPath: options.sessionPath,
        error: parsed.error,
        ...(aggregate.text === undefined ? {} : { text: aggregate.text }),
        ...(aggregate.usage === undefined ? {} : { usage: aggregate.usage }),
        ...(aggregate.model === undefined ? {} : { model: aggregate.model }),
        progressText: aggregate.progressText,
        toolEvents: aggregate.toolEvents,
      });
      return;
    }
    finish({
      status: "completed",
      sessionPath: options.sessionPath,
      ...(aggregate.text === undefined ? {} : { text: aggregate.text }),
      ...(parsed.value === undefined ? {} : { value: parsed.value }),
      ...(aggregate.stopReason === undefined ? {} : { stopReason: aggregate.stopReason }),
      ...(aggregate.usage === undefined ? {} : { usage: aggregate.usage }),
      ...(aggregate.model === undefined ? {} : { model: aggregate.model }),
      progressText: aggregate.progressText,
      toolEvents: aggregate.toolEvents,
    });
  };
  const handleEvent = (event: PiJsonEvent): void => {
    if (settled) return;
    events.push(event);
    if (events.length > maxEvents) {
      finish({
        status: "errored",
        sessionPath: options.sessionPath,
        error: { code: "EventLimitExceeded", message: "Pi actor emitted too many JSON events" },
        ...emptyAggregate(),
      });
      return;
    }
    const callbacks = [options.onUpdate, options.onEvent].filter(
      (callback): callback is NonNullable<typeof callback> => callback !== undefined,
    );
    for (const callback of callbacks) {
      void Promise.resolve(callback(event)).catch((error) => {
        if (!settled)
          finish({
            status: "errored",
            sessionPath: options.sessionPath,
            error: protocolError(error),
            ...emptyAggregate(),
          });
      });
    }
    if (event.type === "message_end") {
      if (finalMessageTimer !== undefined) clearTimeout(finalMessageTimer);
      finalMessageTimer = setTimeout(() => {
        if (!settled) complete();
      }, 25);
    }
    if (event.type === "agent_end" && currentAggregate().finalMessage !== undefined) complete();
  };
  const protocolFailure = (error: unknown): void => {
    if (settled) return;
    const aggregate = currentAggregate();
    finish({
      status: "errored",
      sessionPath: options.sessionPath,
      error: protocolError(error),
      ...(aggregate.text === undefined ? {} : { text: aggregate.text }),
      ...(aggregate.usage === undefined ? {} : { usage: aggregate.usage }),
      ...(aggregate.model === undefined ? {} : { model: aggregate.model }),
      progressText: aggregate.progressText,
      toolEvents: aggregate.toolEvents,
    });
  };

  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const event of parser.push(chunk)) handleEvent(event);
    } catch (error) {
      protocolFailure(error);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > maxStderrBytes)
      protocolFailure(new PiJsonProtocolError("Pi actor stderr exceeds limit", "StderrTooLarge"));
  });
  child.on("error", (error) => protocolFailure(error));
  child.on("close", (code) => {
    if (settled) return;
    try {
      for (const event of parser.end()) handleEvent(event);
    } catch (error) {
      protocolFailure(error);
      return;
    }
    if (settled) return;
    const aggregate = currentAggregate();
    if (aggregate.finalMessage !== undefined) {
      complete();
      return;
    }
    finish({
      status: "errored",
      sessionPath: options.sessionPath,
      error: {
        code: code === 0 ? "ResultNotSubmitted" : "ChildExit",
        message:
          code === 0
            ? "Pi actor ended without an authoritative message"
            : `Pi actor exited before completing (code ${code ?? "unknown"})`,
      },
      ...(aggregate.usage === undefined ? {} : { usage: aggregate.usage }),
      ...(aggregate.model === undefined ? {} : { model: aggregate.model }),
      progressText: aggregate.progressText,
      toolEvents: aggregate.toolEvents,
    });
  });
  timeout = setTimeout(
    () => stop("interrupted", { code: "Timeout", message: "Pi actor turn timed out" }),
    options.timeoutMs ?? 300_000,
  );
  if (options.signal !== undefined) {
    options.signal.addEventListener(
      "abort",
      () => stop("interrupted", { code: "Aborted", message: "Pi actor turn was aborted" }),
      { once: true },
    );
  }
  return result;
}
