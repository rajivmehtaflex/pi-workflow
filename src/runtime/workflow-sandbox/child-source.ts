export interface WorkflowChildSourceOptions {
  code: string;
  args: Record<string, unknown>;
}

export function createWorkflowChildSource(options: WorkflowChildSourceOptions): string {
  const args = JSON.stringify(options.args);
  return `
import readline from "node:readline";
const frozenArgs = Object.freeze(${args});
const pending = new Map();
let requestOrdinal = 0;
let actorOrdinal = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const readError = (error) => ({ code: typeof error?.code === "string" ? error.code : "DriverError", message: error instanceof Error ? error.message : String(error), ...(error?.details === undefined ? {} : { details: error.details }) });
const request = (type, siteId, payload = {}) => {
  const id = "request-" + (++requestOrdinal);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ kind: "request", id, type, siteId, ...payload });
  });
};
const host = {
  createActor(siteId, name, persona) {
    const localId = siteId + "@" + (++actorOrdinal);
    send({ kind: "create-actor", localId, siteId, ...(name === undefined ? {} : { name }), ...(persona === undefined ? {} : { persona }) });
    return localId;
  },
  ask(siteId, actor, instructions) { return request("ask", siteId, { actor, instructions }); },
  worldRead(siteId, op, args) { return request(op === "world.run" ? "world-run" : "world-read", siteId, { op, args }); },
  report(siteId, item, artifactId) { send({ kind: "event", type: "report", siteId, item, ...(artifactId === undefined ? {} : { artifactId }) }); },
  enterPhase(name) { send({ kind: "event", type: "phase-entered", name }); },
  publishArtifact(siteId, op, args) { return request("publish-artifact", siteId, { op, args }); },
  declareArtifact(siteId, op, args) { send({ kind: "event", type: "declare-artifact", siteId, op, args }); },
  log(message) { send({ kind: "event", type: "log", message: String(message) }); },
};
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.kind !== "response" || typeof message.id !== "string") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.value);
  else {
    const error = new Error(message.error?.message ?? "Boundary-A request failed");
    error.code = message.error?.code ?? "DriverError";
    if (message.error?.details !== undefined) error.details = message.error.details;
    waiter.reject(error);
  }
});
Object.defineProperty(globalThis, "__host", { value: host, enumerable: false });
Object.defineProperty(globalThis, "args", { value: frozenArgs, enumerable: false });
try {
  const value = await (async () => {
${options.code}
  })();
  send({ kind: "complete", ok: true, ...(value === undefined ? {} : { value }) });
} catch (error) {
  send({ kind: "complete", ok: false, error: readError(error) });
}
`;
}
