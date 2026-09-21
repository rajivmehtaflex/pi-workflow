import { StringDecoder } from "node:string_decoder";

export interface WireError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ChildCreateActorMessage {
  kind: "create-actor";
  localId: string;
  siteId: string;
  name?: string;
  persona?: unknown;
}

export interface ChildRequestMessage {
  kind: "request";
  id: string;
  type: "ask" | "world-read" | "world-run" | "publish-artifact" | "escalate";
  siteId: string;
  actor?: string;
  instructions?: string;
  op?: string;
  args?: unknown[];
}

export interface ChildEventMessage {
  kind: "event";
  type: "phase-entered" | "log" | "report" | "declare-artifact" | "artifact-published";
  [key: string]: unknown;
}

export interface ChildCompleteMessage {
  kind: "complete";
  ok: boolean;
  value?: unknown;
  error?: WireError;
}

export type ChildMessage =
  | ChildCreateActorMessage
  | ChildRequestMessage
  | ChildEventMessage
  | ChildCompleteMessage;

export interface ParentResponseMessage {
  kind: "response";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: WireError;
}

export type ParentMessage = ParentResponseMessage;

export class WorkflowProtocolError extends Error {
  constructor(message: string, readonly code = "ProtocolError") {
    super(message);
    this.name = "WorkflowProtocolError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorkflowProtocolError("Message must be a JSON object");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, required = true): string | undefined {
  if (typeof value[key] === "string") return value[key] as string;
  if (!required && value[key] === undefined) return undefined;
  throw new WorkflowProtocolError(`Message field ${key} must be a string`);
}

export function parseChildMessage(line: string): ChildMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new WorkflowProtocolError("Malformed JSON line", "MalformedJson");
  }
  const input = record(value);
  const kind = stringField(input, "kind");
  if (kind === "create-actor") {
    return {
      kind,
      localId: stringField(input, "localId")!,
      siteId: stringField(input, "siteId")!,
      ...(stringField(input, "name", false) === undefined ? {} : { name: stringField(input, "name", false) }),
      ...(input.persona === undefined ? {} : { persona: input.persona }),
    };
  }
  if (kind === "request") {
    const type = stringField(input, "type");
    if (!["ask", "world-read", "world-run", "publish-artifact", "escalate"].includes(type!)) throw new WorkflowProtocolError(`Unknown request type: ${type}`, "UnknownRequest");
    return {
      kind,
      id: stringField(input, "id")!,
      type: type as ChildRequestMessage["type"],
      siteId: stringField(input, "siteId")!,
      ...(stringField(input, "actor", false) === undefined ? {} : { actor: stringField(input, "actor", false) }),
      ...(stringField(input, "instructions", false) === undefined ? {} : { instructions: stringField(input, "instructions", false) }),
      ...(stringField(input, "op", false) === undefined ? {} : { op: stringField(input, "op", false) }),
      ...(Array.isArray(input.args) ? { args: input.args } : {}),
    };
  }
  if (kind === "event") {
    const type = stringField(input, "type");
    if (!["phase-entered", "log", "report", "declare-artifact", "artifact-published"].includes(type!)) throw new WorkflowProtocolError(`Unknown event type: ${type}`, "UnknownEvent");
    return { ...input, kind, type: type as ChildEventMessage["type"] } as ChildEventMessage;
  }
  if (kind === "complete") {
    if (typeof input.ok !== "boolean") throw new WorkflowProtocolError("Complete message requires boolean ok");
    if (input.error !== undefined) {
      const error = record(input.error);
      if (typeof error.code !== "string" || typeof error.message !== "string") throw new WorkflowProtocolError("Complete error is malformed");
    }
    return { kind, ok: input.ok, ...(input.value === undefined ? {} : { value: input.value }), ...(input.error === undefined ? {} : { error: input.error as WireError }) };
  }
  throw new WorkflowProtocolError(`Unknown message kind: ${kind}`, "UnknownKind");
}

export function encodeParentMessage(message: ParentMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export class NdjsonLineParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly options: { maxLineBytes: number }) {}

  push(chunk: Uint8Array | string): ChildMessage[] {
    this.buffer += this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    const messages: ChildMessage[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.options.maxLineBytes) throw new WorkflowProtocolError("NDJSON line exceeds limit", "LineTooLarge");
      if (line.trim() !== "") messages.push(parseChildMessage(line));
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.options.maxLineBytes) throw new WorkflowProtocolError("NDJSON line exceeds limit", "LineTooLarge");
    return messages;
  }

  end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim() !== "") throw new WorkflowProtocolError("Child ended with a partial NDJSON line", "PartialLine");
  }
}
