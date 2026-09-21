import { createHash } from "node:crypto";
import { WorkflowError, toWorkflowErrorJson } from "./errors.js";
import type {
  ActorId,
  ActorRecord,
  ActorRef,
  ArtifactContentOp,
  ArtifactPresetOp,
  ArtifactRef,
  ArtifactVersionRecord,
  Caps,
  InstanceRef,
  JournalStorePort,
  NodeRecord,
  PersonaSpec,
  RunEvent,
  RunStatus,
  SessionRef,
  WorkflowDriver,
  WorkflowHostApi,
  WorldReadOp,
} from "./types.js";

interface PendingAsk {
  instance: InstanceRef;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export interface WorkflowEngineOptions {
  runId: string;
  caps: Caps;
  journal: JournalStorePort;
  driver: WorkflowDriver;
  maxReports?: number;
}

const hashInput = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class WorkflowEngine implements WorkflowHostApi {
  private readonly actors = new Map<ActorId, ActorRecord>();
  private readonly actorOrdinals = new Map<string, number>();
  private readonly actorCursors = new Map<string, number>();
  private readonly actorSequences = new Map<ActorId, number>();
  private readonly actorSequenceCursors = new Map<ActorId, number>();
  private readonly nodeOrdinals = new Map<string, number>();
  private readonly nodeCursors = new Map<string, number>();
  private readonly cachedNodes = new Map<string, NodeRecord>();
  private readonly pending = new Map<string, PendingAsk>();
  private readonly artifacts = new Map<string, ArtifactVersionRecord>();
  private readonly phaseOrdinals = new Map<string, number>();
  private readonly maxReports: number;
  private reportCount = 0;
  private settled = false;
  private currentPhase: string | undefined;

  constructor(private readonly options: WorkflowEngineOptions) {
    this.maxReports = options.maxReports ?? 256;
    for (const actor of options.journal.listActors(options.runId)) {
      const id = `${actor.siteId}@${actor.ordinal}`;
      this.actors.set(id, actor);
      this.actorOrdinals.set(actor.siteId, Math.max(this.actorOrdinals.get(actor.siteId) ?? 0, actor.ordinal));
      this.actorSequences.set(id, Math.max(this.actorSequences.get(id) ?? 0, 0));
    }
    for (const node of options.journal.listNodes(options.runId)) {
      const key = this.key({ siteId: node.siteId, ordinal: node.ordinal });
      this.nodeOrdinals.set(node.siteId, Math.max(this.nodeOrdinals.get(node.siteId) ?? 0, node.ordinal));
      if (node.status === "completed") this.cachedNodes.set(key, node);
      if (node.actorSiteId !== undefined && node.actorOrdinal !== undefined && node.actorSeq !== undefined) {
        const actorId = `${node.actorSiteId}@${node.actorOrdinal}`;
        this.actorSequences.set(actorId, Math.max(this.actorSequences.get(actorId) ?? 0, node.actorSeq));
      }
    }
  }

  private emit(event: RunEvent): void {
    this.options.journal.appendEvent(this.options.runId, event);
    this.options.driver.emit(event);
  }

  private nextNode(siteId: string): InstanceRef {
    const ordinal = (this.nodeCursors.get(siteId) ?? 0) + 1;
    this.nodeCursors.set(siteId, ordinal);
    this.nodeOrdinals.set(siteId, Math.max(this.nodeOrdinals.get(siteId) ?? 0, ordinal));
    return { siteId, ordinal };
  }

  private recordNode(node: NodeRecord): void {
    const existing = this.options.journal.getNode(this.options.runId, node.siteId, node.ordinal);
    if (existing === undefined) this.options.journal.putNode(node);
    else if (this.options.journal.updateNode !== undefined) this.options.journal.updateNode(node);
  }

  private replaceActor(actor: ActorRecord): void {
    if (this.options.journal.updateActor !== undefined) this.options.journal.updateActor(actor);
  }

  private replaceNode(node: NodeRecord): void {
    if (this.options.journal.updateNode !== undefined) this.options.journal.updateNode(node);
  }

  createActor(siteId: string, name?: string, persona?: string | PersonaSpec): ActorId {
    const normalizedName = typeof name === "string" && name.trim() ? name.trim() : undefined;
    if (normalizedName !== undefined && [...this.actors.values()].some((actor) => actor.name === normalizedName)) {
      throw new WorkflowError("DuplicateActorName", `Duplicate actor name: ${normalizedName}`);
    }
    const ordinal = (this.actorCursors.get(siteId) ?? 0) + 1;
    this.actorCursors.set(siteId, ordinal);
    this.actorOrdinals.set(siteId, Math.max(this.actorOrdinals.get(siteId) ?? 0, ordinal));
    const actor: ActorRecord = {
      runId: this.options.runId,
      siteId,
      ordinal,
      ...(normalizedName === undefined ? {} : { name: normalizedName }),
      ...(persona === undefined ? {} : { persona: typeof persona === "string" ? { system: persona } : persona }),
      createdAt: Date.now(),
    };
    const id = `${siteId}@${ordinal}`;
    const existing = this.actors.get(id);
    if (existing !== undefined) {
      if (normalizedName !== undefined && existing.name !== undefined && normalizedName !== existing.name) {
        throw new WorkflowError("DuplicateActorName", `Actor ${siteId} changed its name during resume`);
      }
      return id;
    }
    this.actors.set(id, actor);
    this.actorSequences.set(id, 0);
    this.options.journal.putActor(actor);
    this.emit({ type: "actor-created", actor: { siteId, ordinal }, ...(actor.name ? { name: actor.name } : {}), ...(actor.persona ? { persona: actor.persona } : {}) });
    return id;
  }

  async ask(siteId: string, actor: ActorId, instructions: string): Promise<unknown> {
    const actorRecord = this.actors.get(actor);
    if (actorRecord === undefined) throw new WorkflowError("UnknownActor", `Unknown actor: ${actor}`);
    const instance = this.nextNode(siteId);
    const actorRef: ActorRef = { siteId: actorRecord.siteId, ordinal: actorRecord.ordinal };
    const actorSeq = (this.actorSequenceCursors.get(actor) ?? 0) + 1;
    this.actorSequenceCursors.set(actor, actorSeq);
    this.actorSequences.set(actor, Math.max(this.actorSequences.get(actor) ?? 0, actorSeq));
    const node: NodeRecord = {
      runId: this.options.runId,
      siteId: instance.siteId,
      ordinal: instance.ordinal,
      kind: "ask",
      actorSiteId: actorRecord.siteId,
      actorOrdinal: actorRecord.ordinal,
      actorSeq,
      inputHash: hashInput({ actor, instructions }),
      input: { instructions },
      status: "running",
      createdAt: Date.now(),
    };
    this.recordNode(node);
    this.emit({ type: "node-queued", instance, kind: "ask", actor: actorRef, actorSeq });
    const cached = this.cachedNodes.get(this.key(instance));
    if (cached !== undefined && cached.inputHash === node.inputHash) {
      this.emit({ type: "node-settled", instance, outcome: "ok", cached: true });
      return cached.result;
    }
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(this.key(instance), { instance, resolve, reject }));
    void this.startAsk(actor, actorRecord, instance, instructions, actorRef, actorSeq);
    return result;
  }

  private async startAsk(
    actor: ActorId,
    record: ActorRecord,
    instance: InstanceRef,
    instructions: string,
    actorRef: ActorRef,
    actorSeq: number,
  ): Promise<void> {
    try {
      const session = record.sessionId === undefined
        ? await this.options.driver.createActorSession(actorRef, record.persona ?? {})
        : ({ id: record.sessionId } satisfies SessionRef);
      if (record.sessionId === undefined) {
        record.sessionId = session.id;
        this.replaceActor(record);
      }
      this.emit({ type: "node-dispatched", instance });
      this.options.driver.startAsk(session, instance, { instructions, typed: false });
      void actor;
      void actorSeq;
    } catch (error) {
      this.rejectAsk(instance, error);
    }
  }

  resolveAsk(instance: InstanceRef, value: unknown, stats?: { totalTokens?: number; messageBoundary?: number }): void {
    const pending = this.pending.get(this.key(instance));
    if (pending === undefined) return;
    this.pending.delete(this.key(instance));
    this.replaceNode({
      ...(this.options.journal.getNode(this.options.runId, instance.siteId, instance.ordinal) as NodeRecord),
      status: "completed",
      result: value,
      ...(stats?.messageBoundary === undefined ? {} : { messageBoundary: stats.messageBoundary }),
      updatedAt: Date.now(),
    });
    this.emit({ type: "node-settled", instance, outcome: "ok" });
    if (stats?.totalTokens !== undefined) this.updateUsage(stats.totalTokens);
    pending.resolve(value);
  }

  rejectAsk(instance: InstanceRef, error: unknown): void {
    const pending = this.pending.get(this.key(instance));
    if (pending === undefined) return;
    this.pending.delete(this.key(instance));
    const failure = toWorkflowErrorJson(error);
    const existing = this.options.journal.getNode(this.options.runId, instance.siteId, instance.ordinal);
    if (existing !== undefined) this.replaceNode({ ...existing, status: "failed", error: failure, updatedAt: Date.now() });
    this.emit({ type: "node-settled", instance, outcome: "failed", error: failure });
    pending.reject(error);
  }

  async worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown> {
    const instance = this.nextNode(siteId);
    const inputHash = hashInput({ op, args });
    const nodeKind = op === "world.run" ? "world-run" : "world-read";
    this.recordNode({ runId: this.options.runId, siteId, ordinal: instance.ordinal, kind: nodeKind, inputHash, input: { op, args }, status: "running", createdAt: Date.now() });
    this.emit({ type: "node-queued", instance, kind: op === "world.run" ? "world-run" : "world-read" });
    const cached = this.cachedNodes.get(this.key(instance));
    if (cached !== undefined && cached.inputHash === inputHash) {
      this.emit({ type: "node-settled", instance, outcome: "ok", cached: true });
      return cached.result;
    }
    try {
      const value = await this.options.driver.executeWorldRead(op, args);
      const existing = this.options.journal.getNode(this.options.runId, siteId, instance.ordinal);
      if (existing !== undefined) this.replaceNode({ ...existing, status: "completed", result: value, updatedAt: Date.now() });
      this.emit({ type: "node-settled", instance, outcome: "ok" });
      return value;
    } catch (error) {
      const failure = toWorkflowErrorJson(error);
      const existing = this.options.journal.getNode(this.options.runId, siteId, instance.ordinal);
      if (existing !== undefined) this.replaceNode({ ...existing, status: "failed", error: failure, updatedAt: Date.now() });
      this.emit({ type: "node-settled", instance, outcome: "failed", error: failure });
      throw error;
    }
  }

  report(siteId: string, item: unknown, artifactId?: string): void {
    if (++this.reportCount > this.maxReports) throw new WorkflowError("ReportCapExceeded", "Report count exceeded");
    let encoded: string;
    try {
      encoded = JSON.stringify(item);
    } catch {
      throw new WorkflowError("ReportCapExceeded", "Report item is not JSON serializable");
    }
    if (Buffer.byteLength(encoded, "utf8") > 32 * 1024) throw new WorkflowError("ReportCapExceeded", "Report item is too large");
    const instance = this.nextNode(siteId);
    this.recordNode({ runId: this.options.runId, siteId, ordinal: instance.ordinal, kind: "report", inputHash: hashInput(item), status: "completed", result: item, artifactId, createdAt: Date.now(), updatedAt: Date.now() });
    this.emit({ type: "report", instance, item, ...(artifactId ? { artifactId } : {}) });
  }

  enterPhase(name: string): void {
    const normalized = name.trim();
    this.currentPhase = normalized;
    const ordinal = (this.phaseOrdinals.get(normalized) ?? 0) + 1;
    this.phaseOrdinals.set(normalized, ordinal);
    this.emit({ type: "phase-entered", name: normalized, ordinal });
  }

  async publishArtifact(siteId: string, op: ArtifactContentOp, args: unknown[]): Promise<ArtifactRef> {
    if (this.options.driver.executeArtifactPublish === undefined) throw new WorkflowError("ArtifactStoreUnavailable", "Artifact store is unavailable");
    const instance = this.nextNode(siteId);
    const artifact = await this.options.driver.executeArtifactPublish({ runId: this.options.runId, siteId, ordinal: instance.ordinal, op, args });
    this.artifacts.set(artifact.id, artifact);
    this.recordNode({ runId: this.options.runId, siteId, ordinal: instance.ordinal, kind: "artifact", inputHash: hashInput({ op, args }), status: "completed", result: artifact, artifactId: artifact.id, createdAt: Date.now(), updatedAt: Date.now() });
    this.emit({ type: "artifact-published", instance, artifact });
    return { id: artifact.id, version: artifact.version };
  }

  declareArtifact(siteId: string, op: ArtifactPresetOp, args: unknown[]): void {
    const id = typeof args[0] === "string" ? args[0] : undefined;
    if (id === undefined) throw new WorkflowError("ArtifactSpecInvalid", "Artifact id is required");
    const previous = this.artifacts.get(id);
    const artifact: ArtifactVersionRecord = { id, version: 1, kind: op, spec: args[1] };
    if (previous !== undefined && JSON.stringify(previous.spec) !== JSON.stringify(artifact.spec)) throw new WorkflowError("ArtifactRedeclared", `Artifact ${id} was redeclared with a different spec`);
    this.artifacts.set(id, artifact);
    const instance = this.nextNode(siteId);
    this.recordNode({ runId: this.options.runId, siteId, ordinal: instance.ordinal, kind: "artifact", inputHash: hashInput({ op, args }), status: "completed", result: artifact, artifactId: id, createdAt: Date.now(), updatedAt: Date.now() });
    this.emit({ type: "artifact-published", instance, artifact });
  }

  log(message: string): void {
    this.emit({ type: "log", message: message.slice(0, 4000) });
  }

  updateUsage(spentTokens: number): void {
    this.options.journal.updateRunUsage(this.options.runId, spentTokens);
    this.emit({ type: "usage-updated", spentTokens });
  }

  complete(result?: unknown): void {
    this.settle("completed", { result });
  }

  fail(error: unknown): void {
    this.settle("errored", { failure: toWorkflowErrorJson(error) });
  }

  stop(reason: "user" | "model" | "provider" | "interrupted" | "superseded", error?: unknown, supersededBy?: string): void {
    this.settle("stopped", { stopReason: reason, ...(error ? { failure: toWorkflowErrorJson(error) } : {}), ...(supersededBy ? { supersededBy } : {}) });
    for (const pending of this.pending.values()) this.options.driver.cancelAsk(pending.instance);
  }

  private settle(status: RunStatus, settlement: { result?: unknown; failure?: ReturnType<typeof toWorkflowErrorJson>; stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded"; supersededBy?: string }): void {
    if (this.settled) return;
    this.settled = true;
    this.options.journal.updateRunStatus(this.options.runId, status, settlement);
    this.emit({ type: "run-settled", status, ...(settlement.stopReason ? { stopReason: settlement.stopReason } : {}), ...(settlement.supersededBy ? { supersededBy: settlement.supersededBy } : {}), ...(settlement.failure ? { error: settlement.failure } : {}) });
    this.options.driver.dispose?.();
  }

  private key(instance: InstanceRef): string {
    return `${instance.siteId}@${instance.ordinal}`;
  }
}
