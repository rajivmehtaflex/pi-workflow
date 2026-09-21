import { actorSessionPath } from "../runtime/pi-actor/session-path.js";
import { spawnPiActorTurn, type ActorTurnSettlement, type SpawnPiActorTurnOptions } from "../runtime/pi-actor/process.js";
import { WorkflowError } from "../zcode-core/engine/errors.js";
import type {
  ActorRef,
  ActorSessionSeed,
  ArtifactPublishRequest,
  ArtifactVersionRecord,
  AskMessage,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  SessionRef,
  SubmitVerdict,
  WorldReadOp,
  WorkflowDriver,
} from "../zcode-core/engine/types.js";

interface ActorSessionState {
  id: string;
  actor: ActorRef;
  persona: PersonaSpec;
  path: string;
  messageCount: number;
  queue: ActorTask[];
  active?: ActorTask;
}

interface ActorTask {
  session: ActorSessionState;
  instance: InstanceRef;
  message: AskMessage;
  controller: AbortController;
}

export interface PiWorkflowDriverOptions {
  runId: string;
  cwd: string;
  workspaceKey: string;
  journal: JournalStorePort;
  maxConcurrency: number;
  model?: string;
  thinking?: string;
  runningScript?: string;
  fallbackExecutable?: string;
  actorExecutable?: string;
  actorExecutableArgs?: string[] | ((context: { actor: ActorRef; instance: InstanceRef; prompt: string }) => string[]);
  actorTimeoutMs?: number;
  spawnActorTurn?: (options: SpawnPiActorTurnOptions) => Promise<ActorTurnSettlement>;
  executeWorldRead?(op: WorldReadOp, args: unknown[]): Promise<unknown>;
  executeArtifactPublish?(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord>;
  onResolveAsk?(instance: InstanceRef, value: unknown, stats: { totalTokens?: number; messageBoundary?: number }): void;
  onRejectAsk?(instance: InstanceRef, error: unknown): void;
  onEvent?(event: RunEvent): void;
}

function taskKey(instance: InstanceRef): string {
  return `${instance.siteId}@${instance.ordinal}`;
}

function actorSessionId(runId: string, actor: ActorRef): string {
  return `${runId}:${actor.siteId}@${actor.ordinal}`;
}

function settlementError(result: Extract<ActorTurnSettlement, { status: "errored" | "stopped" }>): WorkflowError {
  const failure = result.error ?? { code: result.status === "stopped" ? "Interrupted" : "DriverError", message: "Pi actor did not complete" };
  return new WorkflowError(result.status === "stopped" ? "Interrupted" : "DriverError", failure.message, {
    ...(failure.finalText === undefined ? {} : { finalText: failure.finalText }),
    ...(failure.violations === undefined ? {} : { violations: failure.violations }),
  });
}

export class PiWorkflowDriver implements WorkflowDriver {
  readonly journal: JournalStorePort;
  private readonly sessions = new Map<string, ActorSessionState>();
  private readonly active = new Map<string, ActorTask>();
  private readonly maxConcurrency: number;
  private closed = false;

  constructor(private readonly options: PiWorkflowDriverOptions) {
    this.journal = options.journal;
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
  }

  async createActorSession(actor: ActorRef, persona: PersonaSpec, seed?: ActorSessionSeed): Promise<SessionRef> {
    const id = actorSessionId(this.options.runId, actor);
    const existing = this.sessions.get(id);
    if (existing !== undefined) return { id };
    const path = actorSessionPath({ cwd: this.options.cwd, workspaceKey: this.options.workspaceKey, runId: this.options.runId, actor });
    const state: ActorSessionState = {
      id,
      actor,
      persona,
      path,
      messageCount: seed?.messageCount ?? 0,
      queue: [],
    };
    this.sessions.set(id, state);
    const stored = this.options.journal.getActor(this.options.runId, actor.siteId, actor.ordinal);
    if (stored !== undefined && this.options.journal.updateActor !== undefined) {
      this.options.journal.updateActor({
        ...stored,
        sessionId: id,
        sessionPath: path,
        resolvedModel: this.options.model,
        sessionMessageCount: state.messageCount,
      });
    }
    return { id };
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    const state = this.sessions.get(session.id);
    if (state === undefined) {
      this.options.onRejectAsk?.(instance, new WorkflowError("UnknownActor", `Unknown actor session: ${session.id}`));
      return;
    }
    if (this.closed) {
      this.options.onRejectAsk?.(instance, new WorkflowError("Cancelled", "Workflow driver is stopped"));
      return;
    }
    const task: ActorTask = { session: state, instance, message, controller: new AbortController() };
    state.queue.push(task);
    this.pump();
  }

  respondToSubmit(_instance: InstanceRef, _verdict: SubmitVerdict): void {
    // Typed repair/nudge admission is owned by the engine. The Pi actor process
    // is one turn at a time and receives the resulting prompt through startAsk.
  }

  cancelAsk(instance: InstanceRef): void {
    const key = taskKey(instance);
    const active = this.active.get(key);
    if (active !== undefined) {
      active.controller.abort();
      return;
    }
    for (const session of this.sessions.values()) {
      const index = session.queue.findIndex((task) => taskKey(task.instance) === key);
      if (index < 0) continue;
      session.queue.splice(index, 1);
      this.options.onRejectAsk?.(instance, new WorkflowError("Cancelled", "Pi actor ask was cancelled"));
      return;
    }
  }

  async executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    if (this.options.executeWorldRead === undefined) throw new WorkflowError("DriverError", `World operation is unavailable: ${op}`);
    return this.options.executeWorldRead(op, args);
  }

  executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    if (this.options.executeArtifactPublish === undefined) return Promise.reject(new WorkflowError("ArtifactStoreUnavailable", "Artifact store is unavailable"));
    return this.options.executeArtifactPublish(request);
  }

  emit(event: RunEvent): void {
    this.options.onEvent?.(event);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.active.values()) task.controller.abort();
    for (const session of this.sessions.values()) {
      for (const task of session.queue) this.options.onRejectAsk?.(task.instance, new WorkflowError("Cancelled", "Pi actor driver disposed"));
      session.queue.length = 0;
    }
  }

  private pump(): void {
    if (this.closed) return;
    while (this.active.size < this.maxConcurrency) {
      const session = [...this.sessions.values()].find((candidate) => candidate.active === undefined && candidate.queue.length > 0);
      if (session === undefined) return;
      const task = session.queue.shift()!;
      session.active = task;
      this.active.set(taskKey(task.instance), task);
      void this.runTask(task).finally(() => {
        if (session.active === task) session.active = undefined;
        this.active.delete(taskKey(task.instance));
        this.pump();
      });
    }
  }

  private async runTask(task: ActorTask): Promise<void> {
    const directArgs = typeof this.options.actorExecutableArgs === "function"
      ? this.options.actorExecutableArgs({ actor: task.session.actor, instance: task.instance, prompt: task.message.instructions })
      : this.options.actorExecutableArgs;
    const result = await (this.options.spawnActorTurn ?? spawnPiActorTurn)({
      cwd: this.options.cwd,
      sessionPath: task.session.path,
      prompt: task.message.instructions,
      model: this.options.model,
      thinking: this.options.thinking,
      runningScript: this.options.runningScript,
      fallbackExecutable: this.options.fallbackExecutable,
      executable: this.options.actorExecutable,
      ...(directArgs === undefined ? {} : { executableArgs: directArgs }),
      signal: task.controller.signal,
      timeoutMs: this.options.actorTimeoutMs,
      result: task.message.typed ? { parseJson: true } : undefined,
    });
    if (result.status === "completed") {
      task.session.messageCount += 1;
      const stored = this.options.journal.getActor(this.options.runId, task.session.actor.siteId, task.session.actor.ordinal);
      if (stored !== undefined && this.options.journal.updateActor !== undefined) {
        this.options.journal.updateActor({ ...stored, sessionPath: task.session.path, resolvedModel: result.model ?? this.options.model, sessionMessageCount: task.session.messageCount });
      }
      this.options.onResolveAsk?.(task.instance, result.value ?? result.text, { totalTokens: result.usage?.totalTokens, messageBoundary: task.session.messageCount });
      return;
    }
    this.options.onRejectAsk?.(task.instance, settlementError(result));
  }
}

export function createPiWorkflowDriver(options: PiWorkflowDriverOptions): PiWorkflowDriver {
  return new PiWorkflowDriver(options);
}
