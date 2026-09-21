import { StringDecoder } from "node:string_decoder";
import {
  assistantMessageText,
  parsePiJsonLine,
  PiJsonProtocolError,
  type PiAgentEndEvent,
  type PiJsonEvent,
  type PiMessageEndEvent,
  type PiMessageUpdateEvent,
  type PiUsage,
} from "./json-events.js";

export interface PiJsonStreamParserOptions {
  maxLineBytes?: number;
}

export class PiJsonStreamParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private readonly maxLineBytes: number;

  constructor(options: PiJsonStreamParserOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? 256 * 1024;
  }

  push(chunk: Uint8Array | string): PiJsonEvent[] {
    this.buffer += this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    return this.takeLines();
  }

  end(): PiJsonEvent[] {
    this.buffer += this.decoder.end();
    const events = this.takeLines();
    if (this.buffer.trim() !== "") throw new PiJsonProtocolError("Pi child ended with a partial NDJSON line", "PartialLine");
    return events;
  }

  private takeLines(): PiJsonEvent[] {
    const events: PiJsonEvent[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        throw new PiJsonProtocolError("Pi JSON line exceeds limit", "LineTooLarge");
      }
      if (line.trim() !== "") events.push(parsePiJsonLine(line));
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
      throw new PiJsonProtocolError("Pi JSON line exceeds limit", "LineTooLarge");
    }
    return events;
  }
}

export interface PiTurnAggregate {
  text?: string;
  progressText: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: PiUsage;
  model?: string;
  toolEvents: PiJsonEvent[];
  finalMessage?: PiMessageEndEvent;
  agentEnd?: PiAgentEndEvent;
}

function modelName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const model = value as { provider?: unknown; id?: unknown };
  if (typeof model.provider === "string" && typeof model.id === "string") return `${model.provider}/${model.id}`;
  return typeof model.id === "string" ? model.id : undefined;
}

function mergeUsage(current: PiUsage | undefined, next: PiUsage | undefined): PiUsage | undefined {
  if (next === undefined) return current;
  return { ...current, ...next };
}

export function aggregatePiTurn(events: readonly PiJsonEvent[]): PiTurnAggregate {
  let finalMessage: PiMessageEndEvent | undefined;
  let progressText = "";
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let usage: PiUsage | undefined;
  let model: string | undefined;
  let agentEnd: PiAgentEndEvent | undefined;
  const toolEvents: PiJsonEvent[] = [];

  for (const event of events) {
    if (event.type === "agent_start") model = modelName(event.model) ?? model;
    if (event.type === "message_update") {
      const update = event as PiMessageUpdateEvent;
      const delta = update.assistantMessageEvent.delta;
      if (typeof delta === "string") progressText += delta;
    }
    if (event.type === "message_end") {
      finalMessage = event;
      stopReason = event.message.stopReason ?? stopReason;
      errorMessage = event.message.errorMessage ?? errorMessage;
    }
    if (event.type === "agent_end") {
      agentEnd = event;
      usage = mergeUsage(usage, event.usage);
      stopReason = event.reason ?? stopReason;
      errorMessage = event.errorMessage ?? errorMessage;
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      toolEvents.push(event);
    }
  }

  return {
    ...(finalMessage === undefined ? {} : { finalMessage, text: assistantMessageText(finalMessage.message) }),
    progressText,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(usage === undefined ? {} : { usage }),
    ...(model === undefined ? {} : { model }),
    toolEvents,
    ...(agentEnd === undefined ? {} : { agentEnd }),
  };
}
