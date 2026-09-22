import type {
  AcceptedWorkflowRun,
  CreateWorkflowInput,
  WorkflowRunService,
  WorkflowSourceInput,
} from "../service/run-service.js";
import type { LowerResult } from "../zcode-core/compiler/lower.js";
import type { RunRecord } from "../zcode-core/engine/types.js";
import type { RequirementsCoordinator } from "../requirements/coordinator.js";
import type { RequirementsRequest } from "../requirements/types.js";

export const WORKFLOW_USAGE = [
  "/workflow auto [--preview] [--model <provider/model[:thinking]>] [--thinking <level>] [--max-concurrency <n>] [--request-id <id>] [-- <requirements>]",
  "/workflow run <path|project:name|global:name> [--args <json>] [--model <provider/model[:thinking]>] [--max-concurrency <n>]",
  "/workflow validate <path|project:name|global:name>",
  "/workflow list [--limit <n>]",
  "/workflow status [<runId>|request:<requestId>]",
  "/workflow resume <runId>|request:<requestId>",
  "/workflow stop [<runId>|request:<requestId>]",
].join("\n");

export type WorkflowSourceReference =
  | { kind: "path"; value: string }
  | { kind: "saved"; scope: "project" | "global"; name: string };

export type ParsedWorkflowCommand =
  | {
      kind: "auto";
      requirements: string;
      preview?: boolean;
      model?: string;
      thinking?: string;
      maxConcurrency?: number;
      requestId?: string;
    }
  | {
      kind: "run";
      source: WorkflowSourceReference;
      args?: Record<string, unknown>;
      model?: string;
      thinking?: string;
      maxConcurrency?: number;
    }
  | { kind: "validate"; source: WorkflowSourceReference }
  | { kind: "list"; limit?: number }
  | { kind: "status"; runId?: string; requestId?: string }
  | { kind: "resume"; runId?: string; requestId?: string }
  | { kind: "stop"; runId?: string; requestId?: string; alias?: "cancel" };

export type WorkflowCommandParseResult =
  | { ok: true; command: ParsedWorkflowCommand }
  | { ok: false; error: string; usage: string };

export interface WorkflowCommandUi {
  notify?(message: string, level?: "info" | "warning" | "error"): void;
}

export interface WorkflowCommandContext {
  cwd?: string;
  hasUI?: boolean;
  ui?: WorkflowCommandUi;
}

export interface WorkflowCommandRegistration {
  description: string;
  handler(args: string, context: WorkflowCommandContext): Promise<void>;
}

export interface WorkflowCommandApi {
  registerCommand(name: string, registration: WorkflowCommandRegistration): void;
  sendMessage?(message: unknown, options?: { deliverAs?: "followUp"; triggerTurn?: boolean }): void;
}

function failure(error: string): WorkflowCommandParseResult {
  return { ok: false, error, usage: WORKFLOW_USAGE };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    while (/\s/.test(input[index] ?? "")) index += 1;
    if (index >= input.length) break;
    const start = index;
    const quote = input[index] === '"' || input[index] === "'" ? input[index] : undefined;
    if (quote !== undefined) {
      index += 1;
      let value = "";
      while (index < input.length && input[index] !== quote) {
        if (input[index] === "\\" && index + 1 < input.length) index += 1;
        value += input[index] ?? "";
        index += 1;
      }
      if (input[index] !== quote) throw new Error("unterminated quoted argument");
      index += 1;
      tokens.push(value);
      continue;
    }
    if (input[index] === "{" || input[index] === "[") {
      const opening = input[index];
      const closing = opening === "{" ? "}" : "]";
      let depth = 0;
      let stringQuote: string | undefined;
      let escaped = false;
      while (index < input.length) {
        const character = input[index] ?? "";
        if (stringQuote !== undefined) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === stringQuote) stringQuote = undefined;
        } else if (character === '"') stringQuote = character;
        else if (character === opening) depth += 1;
        else if (character === closing) {
          depth -= 1;
          if (depth === 0) {
            index += 1;
            break;
          }
        }
        index += 1;
      }
      if (depth !== 0 || stringQuote !== undefined) throw new Error("malformed JSON argument");
      tokens.push(input.slice(start, index).trim());
      continue;
    }
    while (index < input.length && !/\s/.test(input[index] ?? "")) index += 1;
    tokens.push(input.slice(start, index));
  }
  return tokens;
}

function parseSource(value: string | undefined): WorkflowSourceReference | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const separator = value.indexOf(":");
  if (separator > 0) {
    const scope = value.slice(0, separator);
    const name = value.slice(separator + 1);
    if ((scope === "project" || scope === "global") && name.length > 0)
      return { kind: "saved", scope, name };
  }
  return { kind: "path", value };
}

function sourceFromReference(source: WorkflowSourceReference): WorkflowSourceInput {
  return source.kind === "path"
    ? { path: source.value }
    : { saved: { scope: source.scope, name: source.name } };
}

function parseBoundedInteger(
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number | string {
  if (value === undefined || !/^\d+$/.test(value)) return `--${label} requires an integer`;
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum
    ? parsed
    : `--${label} must be between ${minimum} and ${maximum}`;
}

function parseModel(value: string): { model: string; thinking?: string } | string {
  const separator = value.lastIndexOf(":");
  const model = separator <= 0 ? value : value.slice(0, separator);
  if (!/^[^/\s]+\/[^:\s]+$/.test(model)) return "--model must use provider/model[:thinking]";
  return {
    model,
    ...(separator > 0 ? { thinking: value.slice(separator + 1) } : {}),
  };
}

function consumeRawToken(input: string, start: number): { value: string; next: number } | string {
  let index = start;
  while (/\s/.test(input[index] ?? "")) index += 1;
  if (index >= input.length) return "option requires a value";
  const quote = input[index] === '"' || input[index] === "'" ? input[index] : undefined;
  if (quote === undefined) {
    const valueStart = index;
    while (index < input.length && !/\s/.test(input[index] ?? "")) index += 1;
    return { value: input.slice(valueStart, index), next: index };
  }
  index += 1;
  let value = "";
  while (index < input.length && input[index] !== quote) {
    if (input[index] === "\\" && index + 1 < input.length) index += 1;
    value += input[index] ?? "";
    index += 1;
  }
  if (input[index] !== quote) return "unterminated quoted option value";
  return { value, next: index + 1 };
}

function isLeadingOption(input: string, index: number, option: string): boolean {
  if (!input.startsWith(option, index)) return false;
  const next = input[index + option.length];
  return next === undefined || /\s/.test(next);
}

function parseAutoCommand(input: string): WorkflowCommandParseResult | undefined {
  const leading = input.trimStart();
  if (!/^auto(?:\s|$)/.test(leading)) return undefined;
  let index = 4;
  const command: Extract<ParsedWorkflowCommand, { kind: "auto" }> = {
    kind: "auto",
    requirements: "",
  };
  while (index < leading.length) {
    while (/\s/.test(leading[index] ?? "")) index += 1;
    if (index >= leading.length) break;
    if (isLeadingOption(leading, index, "--")) {
      index += 2;
      command.requirements = leading.slice(index).trim();
      break;
    }
    if (isLeadingOption(leading, index, "--preview")) {
      command.preview = true;
      index += "--preview".length;
      continue;
    }
    const option = ["--model", "--thinking", "--max-concurrency", "--request-id"].find((item) =>
      isLeadingOption(leading, index, item),
    );
    if (option === undefined) {
      command.requirements = leading.slice(index).trim();
      break;
    }
    index += option.length;
    const raw = consumeRawToken(leading, index);
    if (typeof raw === "string") return failure(`${option} requires a value`);
    index = raw.next;
    if (option === "--model") {
      const parsed = parseModel(raw.value);
      if (typeof parsed === "string") return failure(parsed);
      command.model = parsed.model;
      if (parsed.thinking !== undefined) command.thinking = parsed.thinking;
    } else if (option === "--thinking") {
      if (raw.value.length === 0) return failure("--thinking requires a value");
      command.thinking = raw.value;
    } else if (option === "--max-concurrency") {
      const parsed = parseBoundedInteger(raw.value, "max-concurrency", 1, 16);
      if (typeof parsed === "string") return failure(parsed);
      command.maxConcurrency = parsed;
    } else {
      if (raw.value.length === 0 || raw.value.length > 256)
        return failure("--request-id requires a non-empty id of at most 256 characters");
      command.requestId = raw.value;
    }
  }
  if (command.requirements.length === 0) return failure("auto requires requirements text");
  return { ok: true, command };
}

function parseRequestTarget(value: string): { runId: string } | { requestId: string } | string {
  if (value.startsWith("request:")) {
    const requestId = value.slice("request:".length);
    return requestId.length === 0 ? "request: requires a request id" : { requestId };
  }
  return { runId: value };
}

export function parseWorkflowCommand(input: string): WorkflowCommandParseResult {
  const auto = parseAutoCommand(input);
  if (auto !== undefined) return auto;
  let tokens: string[];
  try {
    tokens = tokenize(input.trim());
  } catch (error) {
    return failure(error instanceof Error ? error.message : "invalid command arguments");
  }
  const action = tokens.shift();
  if (action === undefined) return failure("A workflow action is required");

  if (action === "run" || action === "validate") {
    const source = parseSource(tokens.shift());
    if (source === undefined) return failure(`${action} requires a workflow source`);
    if (action === "validate")
      return tokens.length === 0
        ? { ok: true, command: { kind: "validate", source } }
        : failure("validate does not accept options");
    const command: Extract<ParsedWorkflowCommand, { kind: "run" }> = { kind: "run", source };
    while (tokens.length > 0) {
      const option = tokens.shift();
      if (option === "--args") {
        const raw = tokens.shift();
        if (raw === undefined) return failure("--args requires JSON");
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            return failure("--args must be a JSON object");
          command.args = parsed as Record<string, unknown>;
        } catch {
          return failure("--args must contain valid JSON");
        }
      } else if (option === "--model") {
        const raw = tokens.shift();
        if (raw === undefined || raw.length === 0) return failure("--model requires a value");
        const separator = raw.lastIndexOf(":");
        const model = separator <= 0 ? raw : raw.slice(0, separator);
        if (!/^[^/\s]+\/[^:\s]+$/.test(model))
          return failure("--model must use provider/model[:thinking]");
        command.model = model;
        if (separator > 0) command.thinking = raw.slice(separator + 1);
      } else if (option === "--max-concurrency") {
        const parsed = parseBoundedInteger(tokens.shift(), "max-concurrency", 1, 16);
        if (typeof parsed === "string") return failure(parsed);
        command.maxConcurrency = parsed;
      } else return failure(`Unknown run option: ${option ?? ""}`);
    }
    return { ok: true, command };
  }

  if (action === "list") {
    if (tokens.length === 0) return { ok: true, command: { kind: "list" } };
    if (tokens.shift() !== "--limit") return failure("list only accepts --limit");
    const parsed = parseBoundedInteger(tokens.shift(), "limit", 1, 100);
    if (typeof parsed === "string" || tokens.length > 0) return failure(String(parsed));
    return { ok: true, command: { kind: "list", limit: parsed } };
  }
  if (action === "status") {
    if (tokens.length > 1) return failure("status accepts at most one run id");
    if (tokens[0] === undefined) return { ok: true, command: { kind: "status" } };
    const target = parseRequestTarget(tokens[0]);
    return typeof target === "string"
      ? failure(target)
      : { ok: true, command: { kind: "status", ...target } };
  }
  if (action === "resume") {
    if (tokens.length !== 1 || tokens[0] === "") return failure("resume requires a run id");
    const target = parseRequestTarget(tokens[0]!);
    return typeof target === "string"
      ? failure(target)
      : { ok: true, command: { kind: "resume", ...target } };
  }
  if (action === "stop" || action === "cancel") {
    if (tokens.length > 1) return failure(`${action} accepts at most one run id`);
    if (tokens[0] === undefined)
      return {
        ok: true,
        command: { kind: "stop", ...(action === "cancel" ? { alias: "cancel" as const } : {}) },
      };
    const target = parseRequestTarget(tokens[0]);
    if (typeof target === "string") return failure(target);
    return {
      ok: true,
      command: {
        kind: "stop",
        ...target,
        ...(action === "cancel" ? { alias: "cancel" as const } : {}),
      },
    };
  }
  return failure(`Unknown workflow action: ${action}`);
}

function boundedJson(value: unknown, max = 3500): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function renderRun(run: RunRecord | undefined): string {
  return run === undefined ? "Workflow run not found" : boundedJson(run);
}

function renderRequest(request: RequirementsRequest, service: WorkflowRunService): string {
  let run: RunRecord | undefined;
  if (request.runId !== undefined) {
    try {
      run = service.getRun(request.runId);
    } catch {
      run = undefined;
    }
  }
  return boundedJson({ request, ...(run === undefined ? {} : { run }) });
}

function notify(
  pi: WorkflowCommandApi,
  context: WorkflowCommandContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (context.ui?.notify !== undefined) context.ui.notify(message, level);
  else
    pi.sendMessage?.(
      { customType: "pi-workflow", text: message, level },
      { deliverAs: "followUp", triggerTurn: false },
    );
}

async function validateSource(
  service: WorkflowRunService,
  source: WorkflowSourceInput,
): Promise<LowerResult> {
  return service.validateSource(source);
}

export function registerWorkflowCommand(
  pi: WorkflowCommandApi,
  service: WorkflowRunService,
  getRequirements?: () => RequirementsCoordinator | undefined,
): void {
  pi.registerCommand("workflow", {
    description: "Run, inspect, resume, or stop a Pi workflow",
    async handler(args, context) {
      const parsed = parseWorkflowCommand(args);
      if (!parsed.ok) {
        notify(pi, context, `${parsed.error}\n\n${parsed.usage}`, "warning");
        return;
      }
      try {
        if (parsed.command.kind === "auto") {
          const coordinator = getRequirements?.();
          if (coordinator === undefined)
            throw new Error("Requirements workflow is not initialized");
          const request = coordinator.start({
            requirements: parsed.command.requirements,
            ...(parsed.command.preview === undefined ? {} : { preview: parsed.command.preview }),
            ...(parsed.command.model === undefined ? {} : { model: parsed.command.model }),
            ...(parsed.command.thinking === undefined ? {} : { thinking: parsed.command.thinking }),
            ...(parsed.command.maxConcurrency === undefined
              ? {}
              : { maxConcurrency: parsed.command.maxConcurrency }),
            ...(parsed.command.requestId === undefined
              ? {}
              : { requestId: parsed.command.requestId }),
          });
          notify(
            pi,
            context,
            `Requirements request accepted: ${request.requestId} (${request.state})`,
          );
        } else if (parsed.command.kind === "run") {
          const input: CreateWorkflowInput = {
            source: sourceFromReference(parsed.command.source),
            ...(parsed.command.args === undefined ? {} : { args: parsed.command.args }),
            ...(parsed.command.model === undefined ? {} : { model: parsed.command.model }),
            ...(parsed.command.thinking === undefined ? {} : { thinking: parsed.command.thinking }),
            ...(parsed.command.maxConcurrency === undefined
              ? {}
              : { caps: { maxConcurrency: parsed.command.maxConcurrency } }),
          };
          const accepted = await service.createWorkflow(input);
          notify(pi, context, `Workflow accepted: ${accepted.runId} (${accepted.status})`);
        } else if (parsed.command.kind === "validate") {
          const result = await validateSource(service, sourceFromReference(parsed.command.source));
          notify(
            pi,
            context,
            result.ok
              ? `Workflow is valid\n${boundedJson(result.lowered?.graph ?? {})}`
              : `Workflow is invalid\n${boundedJson(result.diagnostics)}`,
            result.ok ? "info" : "warning",
          );
        } else if (parsed.command.kind === "list") {
          notify(pi, context, boundedJson(service.listRuns(parsed.command.limit)));
        } else if (parsed.command.kind === "status") {
          if (parsed.command.requestId !== undefined) {
            const coordinator = getRequirements?.();
            if (coordinator === undefined)
              throw new Error("Requirements workflow is not initialized");
            notify(pi, context, renderRequest(coordinator.get(parsed.command.requestId), service));
          } else {
            const run =
              parsed.command.runId === undefined
                ? service.listRuns(1)[0]
                : service.getRun(parsed.command.runId);
            notify(pi, context, renderRun(run));
          }
        } else if (parsed.command.kind === "resume") {
          if (parsed.command.requestId !== undefined) {
            const coordinator = getRequirements?.();
            if (coordinator === undefined)
              throw new Error("Requirements workflow is not initialized");
            const request = await coordinator.resume(parsed.command.requestId);
            notify(
              pi,
              context,
              `Requirements request resumed: ${request.requestId} (${request.state})`,
            );
          } else {
            const accepted = await service.resumeRun(parsed.command.runId!);
            notify(pi, context, `Workflow resumed: ${accepted.runId} (${accepted.status})`);
          }
        } else {
          if (parsed.command.requestId !== undefined) {
            const coordinator = getRequirements?.();
            if (coordinator === undefined)
              throw new Error("Requirements workflow is not initialized");
            await coordinator.stop(parsed.command.requestId);
            notify(
              pi,
              context,
              `Requirements request stopped: ${coordinator.get(parsed.command.requestId).requestId}`,
            );
            return;
          }
          const activeRunIds = service
            .listRuns(100)
            .filter((run) => run.status === "pending" || run.status === "running")
            .map((run) => run.runId);
          const target =
            parsed.command.runId ?? (activeRunIds.length === 1 ? activeRunIds[0] : undefined);
          if (target === undefined)
            notify(
              pi,
              context,
              parsed.command.runId === undefined
                ? "Provide a run id when more than one workflow is active"
                : "A run id is required to stop a workflow",
              "warning",
            );
          else notify(pi, context, `Workflow stopped: ${service.stopRun(target).runId}`);
        }
      } catch (error) {
        notify(pi, context, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

export type { AcceptedWorkflowRun };
