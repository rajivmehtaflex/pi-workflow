import { join } from "node:path";

export interface ActorSessionPathOptions {
  cwd: string;
  workspaceKey: string;
  runId: string;
  actor: { siteId: string; ordinal: number };
}

function safeSegment(value: string, fallback: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+$/, "_").slice(0, 100);
  return segment.length === 0 ? fallback : segment;
}

export function actorSessionPath(options: ActorSessionPathOptions): string {
  // The workspace key is intentionally a logical identity. The cwd already scopes
  // the on-disk state, so secrets or user-provided identity strings never become path segments.
  void options.workspaceKey;
  const runSegment = safeSegment(options.runId, "run");
  const actorSegment = `${safeSegment(options.actor.siteId, "actor")}-${options.actor.ordinal}`;
  return join(options.cwd, ".pi", "workflow-runs", runSegment, "actors", actorSegment, "session.jsonl");
}
