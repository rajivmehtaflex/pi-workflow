import { describe, expect, it } from "vitest";
import { analyzeWorkflowScript, lowerWorkflowScript } from "../src/zcode-core/index.js";

describe("workflow compiler and analysis", () => {
  it("projects typed asks, same-actor FIFO, parallel actors, world operations, reports, artifacts, and phases", () => {
    const result = analyzeWorkflowScript(`
      interface Answer { ok: boolean }
      phase("parallel review");
      const reviewer = agent("reviewer");
      const first = reviewer.ask<Answer>("first");
      const second = reviewer.ask<Answer>("second");
      const planner = agent("planner");
      const plan = planner.ask("plan");
      await Promise.all([first, second, plan]);
      const status = await git.status();
      report({ status });
      artifact.chart("scores", { x: { field: "name" }, y: { field: "score" } });
      await artifact.markdown("report", "# report");
      phase("close out");
      return status;
    `);

    expect(result.ok).toBe(true);
    expect(result.graph?.actors.map((actor) => actor.name)).toEqual(["reviewer", "planner"]);
    expect(result.graph?.sites.filter((site) => site.kind === "ask")).toHaveLength(3);
    expect(result.graph?.sites.some((site) => site.kind === "world-read")).toBe(true);
    expect(result.graph?.sites.some((site) => site.kind === "report")).toBe(true);
    expect(result.declaredArtifacts.map((artifact) => artifact.id)).toEqual(["report", "scores"]);
    expect(result.causality?.phases.map((phase) => phase.name)).toEqual([
      "parallel review",
      "close out",
    ]);
  });

  it("lowers supported facade calls to the host contract", () => {
    const lowered = lowerWorkflowScript(`
      phase("review");
      const reviewer = agent("reviewer");
      const answer = await reviewer.ask("inspect");
      const status = await git.status();
      report({ answer, status });
      return answer;
    `);

    expect(lowered.ok).toBe(true);
    expect(lowered.lowered?.code).toContain('__host.enterPhase("review")');
    expect(lowered.lowered?.code).toContain('__host.createActor("actor#1"');
    expect(lowered.lowered?.code).toContain('__host.ask("ask#1", reviewer, "inspect")');
    expect(lowered.lowered?.code).toContain('__host.worldRead("world#1", "git.status", [])');
    expect(lowered.lowered?.code).toContain('__host.report("report#1", { answer, status })');
  });

  it.each([
    ["dynamic phase name", `const name = "review"; phase(name);`],
    ["dynamic artifact id", `const id = "report"; artifact.markdown(id, "body");`],
    ["arbitrary import", `import fs from "node:fs"; log(fs.readFileSync("x"));`],
    ["non-serializable report", `report(() => "not serializable");`],
    ["duplicate named actors", `agent("same"); agent("same");`],
    ["missing ask instructions", `const reviewer = agent("reviewer"); reviewer.ask();`],
    ["unsafe graph cycle", `while (true) { await agent().ask("loop"); }`],
  ])("rejects %s", (_name, source) => {
    const result = analyzeWorkflowScript(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
