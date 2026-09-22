import type { RequirementsRepository } from "./repository.js";
import type { RequirementsRequest } from "./types.js";
import type { RunRecord } from "../zcode-core/engine/types.js";

export const MAX_REQUIREMENTS_NOTIFICATION_BYTES = 8 * 1024;

export interface RequirementsNotificationMessage {
  customType: "pi-workflow";
  requestId: string;
  status: RequirementsRequest["state"];
  runId?: string;
  text: string;
  result?: string;
  error?: RequirementsRequest["error"];
  assumptions: string[];
  acceptanceCriteria: string[];
  verificationLimitations: string[];
}

export interface RequirementsNotificationsOptions {
  workspaceKey: string;
  repository: RequirementsRepository;
  getRun(runId: string): RunRecord | undefined;
  send(message: RequirementsNotificationMessage): void;
  onChange?(): void;
  intervalMs?: number;
}

function boundedJson(value: unknown, maxBytes: number): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "\n…";
  let end = text.length;
  while (end > 0 && Buffer.byteLength(`${text.slice(0, end)}${suffix}`, "utf8") > maxBytes)
    end -= 1;
  return `${text.slice(0, end)}${suffix}`;
}

function boundedItems(items: string[]): string[] {
  return items.slice(0, 8).map((item) => boundedJson(item, 512));
}

function terminalRunPatch(run: RunRecord):
  | {
      state: "completed" | "failed" | "stopped";
      error?: { code: string; message: string } | null;
    }
  | undefined {
  if (run.status === "completed") return { state: "completed", error: null };
  if (run.status === "errored")
    return {
      state: "failed",
      error: {
        code: run.failure?.code ?? "ExecutionFailed",
        message: run.failure?.message ?? "The workflow run failed",
      },
    };
  if (run.status === "stopped")
    return {
      state: "stopped",
      error: {
        code: run.stopReason === "user" ? "Cancelled" : "Interrupted",
        message:
          run.stopReason === "user"
            ? "The workflow run was stopped"
            : "The workflow run was interrupted; resume explicitly to retry",
      },
    };
  return undefined;
}

function notificationFor(
  request: RequirementsRequest,
  run: RunRecord | undefined,
): RequirementsNotificationMessage {
  const result = run?.result === undefined ? undefined : boundedJson(run.result, 3000);
  const error = request.error;
  const body = {
    requestId: request.requestId,
    status: request.state,
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
    assumptions: boundedItems(request.assumptions),
    acceptanceCriteria: boundedItems(request.acceptanceCriteria),
    verificationLimitations: [
      "Compilation and workflow execution do not independently verify business acceptance criteria.",
    ],
  };
  return {
    customType: "pi-workflow",
    requestId: request.requestId,
    status: request.state,
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    text: boundedJson(body, MAX_REQUIREMENTS_NOTIFICATION_BYTES),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
    assumptions: body.assumptions,
    acceptanceCriteria: body.acceptanceCriteria,
    verificationLimitations: body.verificationLimitations,
  };
}

export class RequirementsNotifications {
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private polling = false;

  constructor(private readonly options: RequirementsNotificationsOptions) {
    this.intervalMs = Math.max(25, options.intervalMs ?? 250);
  }

  start(): void {
    if (this.disposed || this.timer !== undefined) return;
    void this.poll().finally(() => this.schedule());
  }

  async poll(): Promise<void> {
    if (this.disposed || this.polling) return;
    this.polling = true;
    try {
      for (const request of this.options.repository.list(this.options.workspaceKey)) {
        let current = request;
        if (
          current.runId !== undefined &&
          (current.state === "launching" || current.state === "running")
        ) {
          const run = this.options.getRun(current.runId);
          const patch = run === undefined ? undefined : terminalRunPatch(run);
          if (patch !== undefined) {
            try {
              current = this.options.repository.transition(current.requestId, current.state, patch);
              this.options.onChange?.();
            } catch {
              continue;
            }
          }
        }
        if (!isTerminal(current.state) || current.notificationDelivered) continue;
        const run = current.runId === undefined ? undefined : this.options.getRun(current.runId);
        try {
          this.options.send(notificationFor(current, run));
          this.options.repository.transition(current.requestId, current.state, {
            notificationDelivered: true,
          });
          this.options.onChange?.();
        } catch {
          // Leave the durable delivery bit unset so the next poll can retry.
        }
      }
      this.options.onChange?.();
    } finally {
      this.polling = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref?.();
  }
}

function isTerminal(state: RequirementsRequest["state"]): boolean {
  return state === "completed" || state === "failed" || state === "stopped";
}
