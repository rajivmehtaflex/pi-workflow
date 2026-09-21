import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  JournalStorePort,
  RunEvent,
  RunStatus,
  WorkflowHostApi,
} from "../src/zcode-core/engine/types.js";
import { analyzeWorkflowScript, lowerWorkflowScript } from "../src/zcode-core/index.js";

const fixture = (name: string): string =>
  new URL(`./fixtures/${name}`, import.meta.url).pathname;

describe("Pi workflow compatibility contract", () => {
  it("recognizes the pinned Pi JSON event fixture and authoritative message_end", async () => {
    const source = await readFile(fixture("pi-json-events.ndjson"), "utf8");
    const events = source
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events.map((event) => event.type)).toEqual([
      "session",
      "agent_start",
      "turn_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "agent_end",
    ]);
    expect(events[0]).toMatchObject({ type: "session", version: 1 });
    expect(events[4]).toMatchObject({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop" },
    });
  });

  it("compiles typed multi-actor source and exposes stable graph projections", async () => {
    const source = await readFile(fixture("workflows/typed-review.ts"), "utf8");
    const result = analyzeWorkflowScript(source);
    const lowered = lowerWorkflowScript(source);

    expect(result.ok).toBe(true);
    expect(result.graph?.actors.map((actor) => actor.name)).toEqual(["reviewer", "planner"]);
    expect(result.graph?.sites.some((site) => site.kind === "ask")).toBe(true);
    expect(result.causality?.phases.map((phase) => phase.name)).toEqual([
      "Review changed files",
      "Prepare findings",
    ]);
    expect(lowered.ok).toBe(true);
    expect(lowered.lowered?.code).toContain("__host.createActor");
  });

  it("compiles world, report, and artifact source without widening the facade", async () => {
    const source = await readFile(fixture("workflows/world-and-artifact.ts"), "utf8");
    const result = analyzeWorkflowScript(source);

    expect(result.ok).toBe(true);
    expect(result.graph?.sites.some((site) => site.kind === "world-read")).toBe(true);
    expect(result.declaredArtifacts.map((artifact) => artifact.id)).toEqual([
      "health",
      "summary",
    ]);
  });

  it("rejects the legacy createActor API and arbitrary imports", () => {
    const result = analyzeWorkflowScript(
      `import fs from "node:fs";\nconst actor = createActor("legacy");\nawait actor.ask("no");`,
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("keeps the current run and host contracts assignable", () => {
    const statuses = ["pending", "running", "completed", "errored", "stopped"] as const satisfies
      readonly RunStatus[];
    const started = {
      type: "run-started",
      runId: "run-compat",
      caps: { maxConcurrency: 2 },
    } satisfies RunEvent;
    const host = {
      createActor: () => "actor-1",
      ask: async () => null,
      worldRead: async () => null,
      report: () => undefined,
      enterPhase: () => undefined,
      publishArtifact: async () => ({ id: "summary", version: 1 }),
      declareArtifact: () => undefined,
      log: () => undefined,
    } satisfies WorkflowHostApi;
    const journal = {
      createRun: () => undefined,
      getRun: () => undefined,
      updateRunStatus: () => undefined,
      updateRunUsage: () => undefined,
      putActor: () => undefined,
      getActor: () => undefined,
      listActors: () => [],
      putNode: () => undefined,
      getNode: () => undefined,
      listNodes: () => [],
      appendEvent: () => ({ sequence: 1, event: started }),
      listEvents: () => [],
    } satisfies JournalStorePort;

    expect(statuses).toHaveLength(5);
    expect(host).toBeDefined();
    expect(journal).toBeDefined();
  });
});
