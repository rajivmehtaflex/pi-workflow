import type { ActorRecord, NodeRecord } from "../zcode-core/engine/types.js";

export interface CacheImportContext {
  actor: ActorRecord;
  node: NodeRecord;
  model?: string;
  expectedInputHash: string;
  sourceIsReadOnly: boolean;
}

export function isCacheImportEligible(context: CacheImportContext): boolean {
  if (!context.sourceIsReadOnly) return false;
  if (context.node.status !== "completed" || context.node.inputHash !== context.expectedInputHash) return false;
  if (context.model !== undefined && context.actor.resolvedModel !== undefined && context.model !== context.actor.resolvedModel) return false;
  return context.node.actorSiteId === context.actor.siteId && context.node.actorOrdinal === context.actor.ordinal;
}
