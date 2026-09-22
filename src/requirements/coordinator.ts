import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LowerResult } from "../zcode-core/compiler/lower.js";
import { buildGenerationContext, MAX_GENERATION_CONTEXT_BYTES, truncateUtf8 } from "./prompt.js";
import {
  GenerationError,
  type GenerateCandidate,
  type GenerationCandidate,
  type GenerationInput,
} from "./generator.js";
import { RequirementsRepository, type RequirementsRepositoryError } from "./repository.js";
import type {
  RequirementsInput,
  RequirementsRequest,
  RequirementsRequestPatch,
  RequestState,
} from "./types.js";

export const MAX_GENERATION_ATTEMPTS = 3;
export const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;

export interface RequirementsLaunchInput {
  requestId: string;
  source: string;
  input: RequirementsInput;
}

export interface RequirementsLaunchResult {
  runId: string;
}

export interface RequirementsCoordinatorOptions {
  cwd: string;
  workspaceKey: string;
  repository: RequirementsRepository;
  generate: GenerateCandidate;
  validate(source: string): LowerResult;
  launch?(input: RequirementsLaunchInput, signal: AbortSignal): Promise<RequirementsLaunchResult>;
  stopRun?(runId: string): Promise<void> | void;
  resumeRun?(runId: string): Promise<RequirementsLaunchResult>;
  context?: string | (() => Promise<string> | string);
  now?: () => number;
  generationTimeoutMs?: number;
}

interface ActiveRequest {
  controller: AbortController;
  deadlineReached: boolean;
  deadlineAt: number;
  done: Promise<RequirementsRequest>;
  timer?: NodeJS.Timeout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error instanceof GenerationError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error)
    return typeof error.code === "string" ? error.code : "GenerationProcess";
  return "GenerationProcess";
}

function diagnosticText(diagnostic: { line: number; column: number; message: string }): string {
  return `${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`;
}

function safeRequestSegment(requestId: string): string {
  const segment = requestId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return segment.length === 0 ? "request" : segment.slice(0, 120);
}

function isGenerationState(state: RequestState): boolean {
  return state === "queued" || state === "stopped" || state === "failed" || state === "repairing";
}

export class RequirementsCoordinator {
  private readonly active = new Map<string, ActiveRequest>();
  private readonly now: () => number;
  private readonly generationTimeoutMs: number;
  private disposed = false;

  constructor(private readonly options: RequirementsCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.generationTimeoutMs = options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  }

  start(input: RequirementsInput): RequirementsRequest {
    if (this.disposed) throw new Error("Requirements coordinator is disposed");
    const request = this.options.repository.create(input, this.options.workspaceKey);
    if (request.state === "queued" && !this.active.has(request.requestId))
      this.begin(request.requestId);
    return request;
  }

  get(requestId: string): RequirementsRequest {
    return this.options.repository.get(requestId);
  }

  async waitFor(requestId: string): Promise<RequirementsRequest> {
    const active = this.active.get(requestId);
    if (active !== undefined) return active.done;
    return this.get(requestId);
  }

  async stop(requestId: string): Promise<void> {
    const request = this.get(requestId);
    const active = this.active.get(requestId);
    if (active !== undefined) {
      active.controller.abort();
      await active.done;
      return;
    }
    if (
      request.state === "running" &&
      request.runId !== undefined &&
      this.options.stopRun !== undefined
    ) {
      await this.options.stopRun(request.runId);
      this.transitionIfCurrent(requestId, "running", {
        state: "stopped",
        error: { code: "Cancelled", message: "Requirements request stopped" },
      });
      return;
    }
    if (
      ["queued", "generating", "validating", "repairing", "ready", "launching"].includes(
        request.state,
      )
    )
      this.transitionIfCurrent(requestId, request.state, {
        state: "stopped",
        error: { code: "Cancelled", message: "Requirements request stopped" },
      });
  }

  async resume(requestId: string): Promise<RequirementsRequest> {
    const request = this.get(requestId);
    if (request.state === "running" && request.runId !== undefined) return request;
    if (request.state === "stopped" && request.runId !== undefined) {
      if (this.options.resumeRun === undefined) return request;
      const accepted = await this.options.resumeRun(request.runId);
      this.transitionIfCurrent(requestId, "stopped", {
        state: "running",
        runId: accepted.runId,
        error: null,
      });
      return this.get(requestId);
    }
    if (request.state === "failed" && request.attempts >= MAX_GENERATION_ATTEMPTS) return request;
    if (request.state === "ready" && request.input.preview === true) return request;
    if (!this.active.has(requestId)) this.begin(requestId);
    return this.waitFor(requestId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const active = [...this.active.values()];
    for (const request of active) request.controller.abort();
    await Promise.all(active.map((request) => request.done));
  }

  private begin(requestId: string): void {
    if (this.disposed || this.active.has(requestId)) return;
    const controller = new AbortController();
    const active: ActiveRequest = {
      controller,
      deadlineReached: false,
      deadlineAt: this.now() + Math.max(0, this.generationTimeoutMs),
      done: Promise.resolve(this.get(requestId)),
    };
    active.timer = setTimeout(
      () => {
        active.deadlineReached = true;
        controller.abort();
      },
      Math.max(0, active.deadlineAt - this.now()),
    );
    this.active.set(requestId, active);
    active.done = this.execute(requestId, active)
      .catch((error) => this.failUnexpected(requestId, error))
      .finally(() => {
        if (active.timer !== undefined) clearTimeout(active.timer);
        this.active.delete(requestId);
      });
  }

  private async execute(requestId: string, active: ActiveRequest): Promise<RequirementsRequest> {
    let request = this.get(requestId);
    if (request.state === "ready") {
      await this.admitIfNeeded(request, active);
      return this.get(requestId);
    }
    if (!isGenerationState(request.state)) return request;
    if (request.attempts >= MAX_GENERATION_ATTEMPTS) return request;

    const context = await this.resolveContext();
    while (request.attempts < MAX_GENERATION_ATTEMPTS) {
      if (active.controller.signal.aborted) {
        await this.abortCurrent(requestId, active);
        return this.get(requestId);
      }
      const attempt = request.attempts + 1;
      request = this.options.repository.transition(requestId, request.state, {
        state: "generating",
        attempts: attempt,
        error: null,
      });
      let candidate: GenerationCandidate;
      try {
        const input: GenerationInput = {
          requirements: request.input.requirements,
          context,
          ...(request.source === undefined ? {} : { previousSource: request.source }),
          diagnostics: request.diagnostics,
          ...(request.input.model === undefined ? {} : { model: request.input.model }),
          ...(request.input.thinking === undefined ? {} : { thinking: request.input.thinking }),
        };
        candidate = await this.options.generate(input, active.controller.signal);
      } catch (error) {
        if (active.controller.signal.aborted) {
          if (active.deadlineReached) {
            await this.failCurrent(
              requestId,
              "GenerationTimeout",
              "Requirements generation timed out",
            );
          } else {
            await this.stopCurrent(requestId, "Cancelled");
          }
        } else {
          const message = errorMessage(error);
          this.options.repository.recordAttempt(requestId, attempt, request.source ?? "", [
            message,
          ]);
          this.transitionIfCurrent(requestId, "generating", {
            state: "failed",
            diagnostics: [message],
            error: { code: errorCode(error), message },
          });
        }
        return this.get(requestId);
      }
      if (active.controller.signal.aborted) {
        await this.abortCurrent(requestId, active);
        return this.get(requestId);
      }

      request = this.options.repository.transition(requestId, "generating", {
        state: "validating",
        source: candidate.source,
        diagnostics: [],
        assumptions: candidate.assumptions,
        acceptanceCriteria: candidate.acceptanceCriteria,
        error: null,
      });
      let validation: LowerResult;
      try {
        validation = this.options.validate(candidate.source);
      } catch (error) {
        validation = {
          ok: false,
          diagnostics: [{ code: 0, line: 1, column: 1, message: errorMessage(error) }],
        };
      }
      const diagnostics = validation.ok ? [] : validation.diagnostics.map(diagnosticText);
      this.options.repository.recordAttempt(requestId, attempt, candidate.source, diagnostics);
      if (!validation.ok) {
        request = this.options.repository.transition(requestId, "validating", {
          state: attempt >= MAX_GENERATION_ATTEMPTS ? "failed" : "repairing",
          diagnostics,
          error:
            attempt >= MAX_GENERATION_ATTEMPTS
              ? { code: "ValidationFailed", message: "Workflow source failed compilation" }
              : { code: "ValidationFailed", message: diagnostics.join("; ") },
        });
        if (attempt >= MAX_GENERATION_ATTEMPTS) return request;
        continue;
      }

      await this.exportSource(requestId, candidate.source);
      request = this.options.repository.transition(requestId, "validating", {
        state: "ready",
        source: candidate.source,
        diagnostics: [],
        assumptions: candidate.assumptions,
        acceptanceCriteria: candidate.acceptanceCriteria,
        error: null,
      });
      if (active.controller.signal.aborted) {
        await this.abortCurrent(requestId, active);
        return this.get(requestId);
      }
      await this.admitIfNeeded(request, active);
      return this.get(requestId);
    }
    return this.get(requestId);
  }

  private async admitIfNeeded(request: RequirementsRequest, active: ActiveRequest): Promise<void> {
    if (request.input.preview === true || this.options.launch === undefined) return;
    if (active.controller.signal.aborted) {
      await this.abortCurrent(request.requestId, active);
      return;
    }
    const launching = this.options.repository.transition(request.requestId, "ready", {
      state: "launching",
    });
    if (active.controller.signal.aborted) {
      await this.abortCurrent(request.requestId, active);
      return;
    }
    try {
      const accepted = await this.options.launch(
        {
          requestId: launching.requestId,
          source: launching.source ?? "",
          input: launching.input,
        },
        active.controller.signal,
      );
      if (active.controller.signal.aborted) {
        await this.options.stopRun?.(accepted.runId);
        this.transitionIfCurrent(request.requestId, "launching", {
          state: "stopped",
          runId: accepted.runId,
          error: {
            code: active.deadlineReached ? "GenerationTimeout" : "Cancelled",
            message: active.deadlineReached
              ? "Requirements generation timed out"
              : "Requirements request stopped",
          },
        });
        return;
      }
      const afterLaunch = this.options.repository.get(request.requestId);
      if (afterLaunch.state === "running" && afterLaunch.runId === accepted.runId) return;
      this.options.repository.transition(request.requestId, "launching", {
        state: "running",
        runId: accepted.runId,
      });
    } catch (error) {
      const message = errorMessage(error);
      this.transitionIfCurrent(request.requestId, "launching", {
        state: "failed",
        diagnostics: [message],
        error: { code: errorCode(error), message },
      });
    }
  }

  private async resolveContext(): Promise<string> {
    if (typeof this.options.context === "string")
      return truncateUtf8(this.options.context, MAX_GENERATION_CONTEXT_BYTES);
    if (typeof this.options.context === "function") {
      const context = await this.options.context();
      return truncateUtf8(context, MAX_GENERATION_CONTEXT_BYTES);
    }
    return buildGenerationContext(this.options.cwd);
  }

  private async exportSource(requestId: string, source: string): Promise<void> {
    const directory = join(
      this.options.cwd,
      ".pi",
      "workflow-requests",
      safeRequestSegment(requestId),
    );
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "workflow.ts"), source, { encoding: "utf8", mode: 0o600 });
  }

  private async stopCurrent(requestId: string, reason: string | undefined): Promise<void> {
    const current = this.get(requestId);
    if (
      !["queued", "generating", "validating", "repairing", "ready", "launching"].includes(
        current.state,
      )
    )
      return;
    this.transitionIfCurrent(requestId, current.state, {
      state: "stopped",
      error:
        reason === undefined
          ? { code: "GenerationTimeout", message: "Requirements generation timed out" }
          : { code: "Cancelled", message: "Requirements request stopped" },
    });
  }

  private async abortCurrent(requestId: string, active: ActiveRequest): Promise<void> {
    if (active.deadlineReached) {
      await this.failCurrent(requestId, "GenerationTimeout", "Requirements generation timed out");
      return;
    }
    await this.stopCurrent(requestId, "Cancelled");
  }

  private async failCurrent(requestId: string, code: string, message: string): Promise<void> {
    const current = this.get(requestId);
    if (
      ["queued", "generating", "validating", "repairing", "ready", "launching"].includes(
        current.state,
      )
    )
      this.transitionIfCurrent(requestId, current.state, {
        state: "failed",
        diagnostics: [message],
        error: { code, message },
      });
  }

  private transitionIfCurrent(
    requestId: string,
    state: RequestState,
    patch: RequirementsRequestPatch,
  ): RequirementsRequest | undefined {
    try {
      return this.options.repository.transition(requestId, state, patch);
    } catch (error) {
      const code = (error as RequirementsRepositoryError).code;
      if (code === "StaleRequest") return undefined;
      throw error;
    }
  }

  private async failUnexpected(requestId: string, error: unknown): Promise<RequirementsRequest> {
    const message = errorMessage(error);
    const current = this.get(requestId);
    if (!["completed", "failed", "stopped", "running"].includes(current.state))
      this.transitionIfCurrent(requestId, current.state, {
        state: "failed",
        diagnostics: [message],
        error: { code: "CoordinatorError", message },
      });
    return this.get(requestId);
  }
}
