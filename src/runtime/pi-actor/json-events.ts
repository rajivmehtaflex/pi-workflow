export interface PiSessionEvent {
  type: "session";
  version: number;
  id: string;
  cwd?: string;
  sessionFile?: string;
}

export interface PiAgentStartEvent {
  type: "agent_start";
  agentId?: string;
  model?: { provider?: string; id?: string } | string;
}

export interface PiTurnStartEvent {
  type: "turn_start";
  turnId?: string;
}

export interface PiTurnEndEvent {
  type: "turn_end";
  turnId?: string;
}

export interface PiMessageUpdateEvent {
  type: "message_update";
  messageId?: string;
  assistantMessageEvent: Record<string, unknown>;
}

export interface PiMessageEndEvent {
  type: "message_end";
  messageId?: string;
  message: {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
  };
}

export interface PiToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
}

export interface PiToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId?: string;
  update?: unknown;
}

export interface PiToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId?: string;
  isError?: boolean;
  result?: unknown;
}

export interface PiAgentEndEvent {
  type: "agent_end";
  reason?: string;
  errorMessage?: string;
  usage?: PiUsage;
}

export interface PiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
}

export type PiJsonEvent =
  | PiSessionEvent
  | PiAgentStartEvent
  | PiTurnStartEvent
  | PiTurnEndEvent
  | PiMessageUpdateEvent
  | PiMessageEndEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionUpdateEvent
  | PiToolExecutionEndEvent
  | PiAgentEndEvent;

export class PiJsonProtocolError extends Error {
  constructor(
    message: string,
    readonly code = "PiJsonProtocolError",
  ) {
    super(message);
    this.name = "PiJsonProtocolError";
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PiJsonProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== "string" || input[key].length === 0) {
    throw new PiJsonProtocolError(`Pi event field ${key} must be a non-empty string`);
  }
  return input[key] as string;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  if (input[key] === undefined) return undefined;
  if (typeof input[key] !== "string")
    throw new PiJsonProtocolError(`Pi event field ${key} must be a string`);
  return input[key] as string;
}

function optionalFiniteNumber(input: Record<string, unknown>, key: string): number | undefined {
  if (input[key] === undefined) return undefined;
  if (typeof input[key] !== "number" || !Number.isFinite(input[key])) {
    throw new PiJsonProtocolError(`Pi event field ${key} must be a finite number`);
  }
  return input[key] as number;
}

function usage(value: unknown): PiUsage | undefined {
  if (value === undefined) return undefined;
  const input = asRecord(value, "usage");
  return {
    ...(optionalFiniteNumber(input, "inputTokens") === undefined
      ? {}
      : { inputTokens: optionalFiniteNumber(input, "inputTokens") }),
    ...(optionalFiniteNumber(input, "outputTokens") === undefined
      ? {}
      : { outputTokens: optionalFiniteNumber(input, "outputTokens") }),
    ...(optionalFiniteNumber(input, "totalTokens") === undefined
      ? {}
      : { totalTokens: optionalFiniteNumber(input, "totalTokens") }),
    ...(optionalFiniteNumber(input, "cost") === undefined
      ? {}
      : { cost: optionalFiniteNumber(input, "cost") }),
  };
}

function model(value: unknown): PiAgentStartEvent["model"] {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  const input = asRecord(value, "model");
  return {
    ...(optionalString(input, "provider") === undefined
      ? {}
      : { provider: optionalString(input, "provider") }),
    ...(optionalString(input, "id") === undefined ? {} : { id: optionalString(input, "id") }),
  };
}

export function parsePiJsonLine(line: string): PiJsonEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new PiJsonProtocolError("Malformed Pi JSON line", "MalformedJson");
  }
  const input = asRecord(value, "Pi event");
  const type = requiredString(input, "type");
  switch (type) {
    case "session": {
      if (typeof input.version !== "number" || !Number.isInteger(input.version)) {
        throw new PiJsonProtocolError("Pi session version must be an integer");
      }
      return {
        type,
        version: input.version,
        id: requiredString(input, "id"),
        ...(optionalString(input, "cwd") === undefined
          ? {}
          : { cwd: optionalString(input, "cwd") }),
        ...(optionalString(input, "sessionFile") === undefined
          ? {}
          : { sessionFile: optionalString(input, "sessionFile") }),
      };
    }
    case "agent_start": {
      return {
        type,
        ...(optionalString(input, "agentId") === undefined
          ? {}
          : { agentId: optionalString(input, "agentId") }),
        ...(model(input.model) === undefined ? {} : { model: model(input.model) }),
      };
    }
    case "turn_start":
      return {
        type,
        ...(optionalString(input, "turnId") === undefined
          ? {}
          : { turnId: optionalString(input, "turnId") }),
      };
    case "turn_end":
      return {
        type,
        ...(optionalString(input, "turnId") === undefined
          ? {}
          : { turnId: optionalString(input, "turnId") }),
      };
    case "message_update": {
      const event = asRecord(input.assistantMessageEvent, "assistantMessageEvent");
      requiredString(event, "type");
      return {
        type,
        ...(optionalString(input, "messageId") === undefined
          ? {}
          : { messageId: optionalString(input, "messageId") }),
        assistantMessageEvent: event,
      };
    }
    case "message_end": {
      const message = asRecord(input.message, "message");
      if (message.role !== undefined && typeof message.role !== "string")
        throw new PiJsonProtocolError("Pi message role must be a string");
      if (
        message.content !== undefined &&
        typeof message.content !== "string" &&
        !Array.isArray(message.content)
      ) {
        throw new PiJsonProtocolError("Pi message content must be a string or array");
      }
      return {
        type,
        ...(optionalString(input, "messageId") === undefined
          ? {}
          : { messageId: optionalString(input, "messageId") }),
        message: {
          ...(optionalString(message, "role") === undefined
            ? {}
            : { role: optionalString(message, "role") }),
          ...(message.content === undefined ? {} : { content: message.content }),
          ...(optionalString(message, "stopReason") === undefined
            ? {}
            : { stopReason: optionalString(message, "stopReason") }),
          ...(optionalString(message, "errorMessage") === undefined
            ? {}
            : { errorMessage: optionalString(message, "errorMessage") }),
        },
      };
    }
    case "tool_execution_start":
      return {
        type,
        ...(optionalString(input, "toolCallId") === undefined
          ? {}
          : { toolCallId: optionalString(input, "toolCallId") }),
        ...(optionalString(input, "toolName") === undefined
          ? {}
          : { toolName: optionalString(input, "toolName") }),
        ...(input.args === undefined ? {} : { args: input.args }),
      };
    case "tool_execution_update":
      return {
        type,
        ...(optionalString(input, "toolCallId") === undefined
          ? {}
          : { toolCallId: optionalString(input, "toolCallId") }),
        ...(input.update === undefined ? {} : { update: input.update }),
      };
    case "tool_execution_end":
      return {
        type,
        ...(optionalString(input, "toolCallId") === undefined
          ? {}
          : { toolCallId: optionalString(input, "toolCallId") }),
        ...(input.isError === undefined ? {} : { isError: Boolean(input.isError) }),
        ...(input.result === undefined ? {} : { result: input.result }),
      };
    case "agent_end":
      return {
        type,
        ...(optionalString(input, "reason") === undefined
          ? {}
          : { reason: optionalString(input, "reason") }),
        ...(optionalString(input, "errorMessage") === undefined
          ? {}
          : { errorMessage: optionalString(input, "errorMessage") }),
        ...(usage(input.usage) === undefined ? {} : { usage: usage(input.usage) }),
      };
    default:
      throw new PiJsonProtocolError(`Unknown Pi event type: ${type}`, "UnknownEvent");
  }
}

export function assistantMessageText(message: PiMessageEndEvent["message"]): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(
      (part): part is Record<string, unknown> =>
        typeof part === "object" && part !== null && !Array.isArray(part),
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
  return text.length === 0 ? undefined : text;
}
