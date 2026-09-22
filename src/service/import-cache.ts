import type {
  ActorRecord,
  ActorSessionSeed,
  ImportedRuntimeCachePort,
  NodeKind,
  NodeRecord,
  PersonaSpec,
  RunRecord,
} from "../zcode-core/engine/types.js";

export interface ImportedAskEntry {
  inputHash: string;
  result: unknown;
  messageBoundary?: number;
}

export interface ImportedActorCandidate {
  actor: ActorRecord;
  entries: Map<number, ImportedAskEntry>;
  sourceSessionId: string;
  resolvedModel?: string;
}

export interface ImportedWorldEntry {
  inputHash: string;
  kind: NodeKind;
  result: unknown;
}

export interface ImportedRunCache {
  actors: ReadonlyMap<string, ImportedActorCandidate>;
  world: ImportedWorldEntry[];
  predecessorRunId: string;
}

export interface ImportedRuntimeCache extends ImportedRuntimeCachePort {}

export class ImportedActorState {
  private diverged = false;
  private consumed = 0;

  constructor(private readonly candidate: ImportedActorCandidate) {}

  matches(persona: PersonaSpec): boolean {
    return canonical(persona) === canonical(this.candidate.actor.persona ?? {});
  }

  take(actorSeq: number, inputHash: string): ImportedAskEntry | undefined {
    if (this.diverged) return undefined;
    const entry = this.candidate.entries.get(actorSeq);
    if (entry === undefined || entry.inputHash !== inputHash) {
      this.diverged = true;
      return undefined;
    }
    this.consumed = Math.max(this.consumed, actorSeq);
    return entry;
  }

  seed(): ActorSessionSeed | undefined {
    if (this.consumed === 0) return undefined;
    const entry = this.candidate.entries.get(this.consumed);
    if (entry?.messageBoundary === undefined) return undefined;
    return {
      sourceSessionId: this.candidate.sourceSessionId,
      messageCount: entry.messageBoundary,
      resolvedModel: this.candidate.resolvedModel,
    };
  }
}

export class ImportedWorldState {
  private cursor = 0;

  constructor(private readonly entries: ImportedWorldEntry[]) {}

  take(inputHash: string, kind: NodeKind): ImportedWorldEntry | undefined {
    const entry = this.entries[this.cursor];
    if (entry === undefined || entry.inputHash !== inputHash || entry.kind !== kind)
      return undefined;
    this.cursor += 1;
    return entry;
  }
}

export interface CacheImportContext {
  actor: ActorRecord;
  node: NodeRecord;
  model?: string;
  expectedInputHash: string;
  sourceIsReadOnly: boolean;
}

export function isCacheImportEligible(context: CacheImportContext): boolean {
  if (!context.sourceIsReadOnly) return false;
  if (context.node.status !== "completed" || context.node.inputHash !== context.expectedInputHash)
    return false;
  if (
    context.model !== undefined &&
    context.actor.resolvedModel !== undefined &&
    context.model !== context.actor.resolvedModel
  )
    return false;
  return (
    context.node.actorSiteId === context.actor.siteId &&
    context.node.actorOrdinal === context.actor.ordinal
  );
}

function canonical(value: unknown): string {
  return JSON.stringify(value, Object.keys((value ?? {}) as object).sort());
}

function uniqueNamedActors(actors: ActorRecord[]): ActorRecord[] {
  const grouped = new Map<string, ActorRecord[]>();
  for (const actor of actors) {
    if (actor.name === undefined || actor.name.trim() === "") continue;
    const bucket = grouped.get(actor.name) ?? [];
    bucket.push(actor);
    grouped.set(actor.name, bucket);
  }
  return [...grouped.values()].flatMap((bucket) => (bucket.length === 1 ? bucket : []));
}

export function buildImportedCache(
  journal: {
    getRun(runId: string): RunRecord | undefined;
    listActors(runId: string): ActorRecord[];
    listNodes(runId: string): NodeRecord[];
  },
  predecessorRunId: string,
): ImportedRunCache | undefined {
  const run = journal.getRun(predecessorRunId);
  if (run === undefined || !["completed", "errored", "stopped"].includes(run.status))
    return undefined;
  const nodes = journal.listNodes(predecessorRunId);
  const actors = new Map<string, ImportedActorCandidate>();
  for (const actor of uniqueNamedActors(journal.listActors(predecessorRunId))) {
    if (actor.sessionId === undefined) continue;
    const entries = new Map<number, ImportedAskEntry>();
    const askNodes = nodes
      .filter(
        (node) =>
          node.kind === "ask" &&
          node.status === "completed" &&
          node.actorSiteId === actor.siteId &&
          node.actorOrdinal === actor.ordinal &&
          node.actorSeq !== undefined,
      )
      .sort((left, right) => (left.actorSeq ?? 0) - (right.actorSeq ?? 0));
    let expectedSeq = 1;
    for (const node of askNodes) {
      if (node.actorSeq !== expectedSeq) break;
      entries.set(expectedSeq, {
        inputHash: node.inputHash,
        result: node.result,
        messageBoundary: node.messageBoundary,
      });
      expectedSeq += 1;
    }
    if (entries.size > 0)
      actors.set(actor.name!, {
        actor,
        entries,
        sourceSessionId: actor.sessionId,
        ...(actor.resolvedModel === undefined ? {} : { resolvedModel: actor.resolvedModel }),
      });
  }
  const world = nodes
    .filter(
      (node) =>
        node.status === "completed" && (node.kind === "world-read" || node.kind === "world-run"),
    )
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
    .map((node) => ({ inputHash: node.inputHash, kind: node.kind, result: node.result }));
  return { actors, world, predecessorRunId };
}

export function matchImportedActor(
  cache: ImportedRunCache | undefined,
  persona: PersonaSpec & { name?: string },
): ImportedActorState | undefined {
  if (cache === undefined || persona.name === undefined) return undefined;
  const candidate = cache.actors.get(persona.name);
  if (candidate === undefined) return undefined;
  const currentPersona: PersonaSpec =
    persona.system === undefined ? {} : { system: persona.system };
  if (canonical(currentPersona) !== canonical(candidate.actor.persona ?? {})) return undefined;
  return new ImportedActorState(candidate);
}

export function toImportedRuntimeCache(cache: ImportedRunCache): ImportedRuntimeCache {
  return {
    actors: new Map(
      [...cache.actors].map(([name, candidate]) => [name, new ImportedActorState(candidate)]),
    ),
    world: new ImportedWorldState(cache.world),
  };
}
