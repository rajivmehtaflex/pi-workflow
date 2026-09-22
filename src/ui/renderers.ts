import type { RunRecord, StoredEvent } from "../zcode-core/engine/types.js";

export const MAX_RENDERED_TEXT = 4000;

export interface WorkflowRenderOptions {
  maxLength?: number;
  colorize?(text: string, tone: "muted" | "accent" | "error"): string;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatWorkflowRun(run: RunRecord, options: WorkflowRenderOptions = {}): string {
  const maxLength = options.maxLength ?? MAX_RENDERED_TEXT;
  const identity = run.name === undefined ? run.runId : `${run.name} (${run.runId})`;
  const detail = [
    `${identity}: ${run.status}`,
    run.currentPhase === undefined ? undefined : `phase=${run.currentPhase}`,
    run.stopReason === undefined ? undefined : `reason=${run.stopReason}`,
    run.spentTokens > 0 ? `tokens=${run.spentTokens}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  const tone = run.status === "errored" ? "error" : run.status === "running" ? "accent" : "muted";
  return truncate(options.colorize?.(detail, tone) ?? detail, maxLength);
}

export function formatWorkflowRuns(runs: RunRecord[], options: WorkflowRenderOptions = {}): string {
  if (runs.length === 0) return "No workflow runs.";
  const maxLength = options.maxLength ?? MAX_RENDERED_TEXT;
  return truncate(
    runs.map((run) => formatWorkflowRun(run, { ...options, maxLength: maxLength })).join("\n"),
    maxLength,
  );
}

export function formatWorkflowEvents(
  events: StoredEvent[],
  options: WorkflowRenderOptions = {},
): string {
  const maxLength = options.maxLength ?? MAX_RENDERED_TEXT;
  if (events.length === 0) return "No workflow events.";
  const lines = events.map((stored) => {
    const payload = safeJson(stored.event);
    return `#${stored.sequence} ${stored.event.type} ${payload}`;
  });
  return truncate(lines.join("\n"), maxLength);
}

export interface WorkflowToolCallDisplay {
  name?: string;
  arguments?: unknown;
}

export interface WorkflowToolResultDisplay {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
}

export function renderWorkflowToolCall(call: WorkflowToolCallDisplay): string {
  const name = call.name ?? "workflow";
  return truncate(`${name} ${safeJson(call.arguments ?? {})}`, 600);
}

export function renderWorkflowToolResult(result: WorkflowToolResultDisplay): string {
  const text = result.content?.find((item) => item.type === "text")?.text;
  return truncate(text ?? safeJson(result.details ?? {}), MAX_RENDERED_TEXT);
}

export interface WorkflowTranscriptEntry {
  customType?: string;
  text?: string;
  runId?: string;
  status?: string;
  [key: string]: unknown;
}

export function renderWorkflowTranscriptEntry(entry: WorkflowTranscriptEntry): string {
  const prefix = entry.runId === undefined ? "pi-workflow" : `pi-workflow ${entry.runId}`;
  const status = entry.status === undefined ? "" : ` · ${entry.status}`;
  return truncate(`${prefix}${status}\n${entry.text ?? safeJson(entry)}`, MAX_RENDERED_TEXT);
}

export function boundedWorkflowText(value: unknown, maxLength = MAX_RENDERED_TEXT): string {
  return truncate(typeof value === "string" ? value : safeJson(value), maxLength);
}
