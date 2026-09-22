import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RequirementsCoordinator } from "../src/requirements/coordinator.js";
import {
  GenerationError,
  type GenerationCandidate,
  type GenerateCandidate,
} from "../src/requirements/generator.js";
import { RequirementsRepository } from "../src/requirements/repository.js";
import { openWorkflowDatabase } from "../src/storage/db.js";
import { WorkflowRepository } from "../src/storage/repository.js";
import { lowerWorkflowScript } from "../src/zcode-core/index.js";

interface Context {
  cwd: string;
  close(): Promise<void>;
  coordinator: RequirementsCoordinator;
}

const contexts: Context[] = [];

const validCandidate: GenerationCandidate = {
  source: 'phase("Check"); return { ok: true };',
  assumptions: ["The repository is available"],
  acceptanceCriteria: ["The workflow compiles"],
};
const invalidSource = 'phase("Check"); const broken = ;';

async function makeContext(
  generate: GenerateCandidate,
  options: {
    launch?: (
      input: { requestId: string; source: string },
      repository: WorkflowRepository,
    ) => Promise<{ runId: string }>;
    generationTimeoutMs?: number;
  } = {},
): Promise<Context> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-coordinator-"));
  const database = await openWorkflowDatabase({ cwd, workspaceIdentity: "workspace-1" });
  const repository = new RequirementsRepository(database.db);
  const workflowRepository = new WorkflowRepository(database.db);
  const coordinator = new RequirementsCoordinator({
    cwd,
    workspaceKey: "workspace-1",
    repository,
    generate,
    validate: lowerWorkflowScript,
    ...(options.launch === undefined
      ? {}
      : {
          launch: (input: { requestId: string; source: string }) =>
            options.launch!(input, workflowRepository),
        }),
    ...(options.generationTimeoutMs === undefined
      ? {}
      : { generationTimeoutMs: options.generationTimeoutMs }),
  });
  const context = {
    cwd,
    coordinator,
    async close() {
      await coordinator.dispose();
      database.close();
      await rm(cwd, { recursive: true, force: true });
    },
  } satisfies Context;
  contexts.push(context);
  return context;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

function sequence(...steps: Array<GenerationCandidate | Error>): {
  generate: GenerateCandidate;
  inputs: Array<{ previousSource?: string; diagnostics: string[] }>;
} {
  let index = 0;
  const inputs: Array<{ previousSource?: string; diagnostics: string[] }> = [];
  return {
    inputs,
    generate: async (input) => {
      inputs.push({ previousSource: input.previousSource, diagnostics: input.diagnostics });
      const step = steps[Math.min(index++, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

async function waitForState(
  coordinator: RequirementsCoordinator,
  requestId: string,
  states: string[],
): Promise<ReturnType<RequirementsCoordinator["get"]>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const request = coordinator.get(requestId);
    if (states.includes(request.state)) return request;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`request did not reach ${states.join(" or ")}: ${requestId}`);
}

describe("requirements coordinator", () => {
  it("validates a first candidate, exports it, and launches it once", async () => {
    let launches = 0;
    const context = await makeContext(sequence(validCandidate).generate, {
      launch: async ({ requestId, source }, workflowRepository) => {
        launches += 1;
        expect(requestId).toBe("valid");
        expect(source).toBe(validCandidate.source);
        workflowRepository.createRun({
          runId: "run-valid",
          workspaceKey: "workspace-1",
          cwd: "/workspace",
          scriptText: source,
          caps: { maxConcurrency: 2 },
          spentTokens: 0,
          status: "pending",
        });
        return { runId: "run-valid" };
      },
    });
    const initial = context.coordinator.start({ requestId: "valid", requirements: "Review files" });
    expect(initial.state).toBe("queued");
    const result = await context.coordinator.waitFor("valid");
    expect(result).toMatchObject({
      state: "running",
      source: validCandidate.source,
      runId: "run-valid",
      assumptions: validCandidate.assumptions,
      acceptanceCriteria: validCandidate.acceptanceCriteria,
      attempts: 1,
    });
    expect(
      await readFile(join(context.cwd, ".pi", "workflow-requests", "valid", "workflow.ts"), "utf8"),
    ).toBe(validCandidate.source);
    expect(launches).toBe(1);
  });

  it("repairs a compiler-invalid candidate within the three-attempt budget", async () => {
    const scripted = sequence(
      { ...validCandidate, source: invalidSource },
      { ...validCandidate, assumptions: ["Repaired"] },
    );
    let launches = 0;
    const context = await makeContext(scripted.generate, {
      launch: async ({ source }, workflowRepository) => {
        launches += 1;
        workflowRepository.createRun({
          runId: "run-repaired",
          workspaceKey: "workspace-1",
          cwd: "/workspace",
          scriptText: source,
          caps: { maxConcurrency: 2 },
          spentTokens: 0,
          status: "pending",
        });
        return { runId: "run-repaired" };
      },
    });
    context.coordinator.start({ requestId: "repair", requirements: "Repair the workflow" });
    const result = await context.coordinator.waitFor("repair");
    expect(result.state).toBe("running");
    expect(result.attempts).toBe(2);
    expect(result.source).toBe(validCandidate.source);
    expect(scripted.inputs[1]).toMatchObject({
      previousSource: invalidSource,
      diagnostics: [expect.stringContaining("Expression expected")],
    });
    expect(result.diagnostics).toEqual([]);
    expect(launches).toBe(1);
  });

  it("fails after three invalid candidates without admitting a run", async () => {
    let launches = 0;
    const context = await makeContext(
      sequence(
        { ...validCandidate, source: invalidSource },
        { ...validCandidate, source: invalidSource },
        { ...validCandidate, source: invalidSource },
      ).generate,
      {
        launch: async () => {
          launches += 1;
          return { runId: "must-not-run" };
        },
      },
    );
    context.coordinator.start({
      requestId: "exhausted",
      requirements: "Never accept invalid source",
    });
    const result = await context.coordinator.waitFor("exhausted");
    expect(result).toMatchObject({ state: "failed", attempts: 3, source: invalidSource });
    expect(result.error?.code).toBe("ValidationFailed");
    expect(launches).toBe(0);
  });

  it("makes preview requests ready and never launches them", async () => {
    let launches = 0;
    const context = await makeContext(sequence(validCandidate).generate, {
      launch: async () => {
        launches += 1;
        return { runId: "must-not-run" };
      },
    });
    context.coordinator.start({
      requestId: "preview",
      requirements: "Preview this",
      preview: true,
    });
    const result = await context.coordinator.waitFor("preview");
    expect(result.state).toBe("ready");
    expect(result.runId).toBeUndefined();
    expect(launches).toBe(0);
  });

  it("persists a generator rejection as a failed request", async () => {
    const context = await makeContext(
      sequence(new GenerationError("GenerationProcess", "provider unavailable")).generate,
    );
    context.coordinator.start({ requestId: "provider-error", requirements: "Use the provider" });
    const result = await context.coordinator.waitFor("provider-error");
    expect(result).toMatchObject({
      state: "failed",
      attempts: 1,
      error: { code: "GenerationProcess", message: "provider unavailable" },
    });
    expect(result.diagnostics).toEqual(["provider unavailable"]);
  });

  it("stops generation before launch and resumes with the remaining budget", async () => {
    let calls = 0;
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<GenerationCandidate>((resolve) => {
      resolveFirst = () => resolve(validCandidate);
    });
    const generate: GenerateCandidate = async (_input, signal) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new GenerationError("GenerationAborted", "stopped")),
            {
              once: true,
            },
          );
          void first.then(() => resolve());
        });
      }
      return validCandidate;
    };
    let launches = 0;
    const context = await makeContext(generate, {
      launch: async ({ source }, workflowRepository) => {
        launches += 1;
        workflowRepository.createRun({
          runId: "run-after-resume",
          workspaceKey: "workspace-1",
          cwd: "/workspace",
          scriptText: source,
          caps: { maxConcurrency: 2 },
          spentTokens: 0,
          status: "pending",
        });
        return { runId: "run-after-resume" };
      },
    });
    context.coordinator.start({ requestId: "stop-resume", requirements: "Stop then resume" });
    await waitForState(context.coordinator, "stop-resume", ["generating"]);
    await context.coordinator.stop("stop-resume");
    expect(context.coordinator.get("stop-resume").state).toBe("stopped");
    resolveFirst?.();
    const resumed = await context.coordinator.resume("stop-resume");
    expect(resumed).toMatchObject({ state: "running", attempts: 2, runId: "run-after-resume" });
    expect(calls).toBe(2);
    expect(launches).toBe(1);
  });

  it("does not launch when the generation deadline expires", async () => {
    let launches = 0;
    const generate: GenerateCandidate = async (_input, signal) =>
      new Promise<GenerationCandidate>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new GenerationError("GenerationAborted", "deadline")),
          { once: true },
        );
      });
    const context = await makeContext(generate, {
      generationTimeoutMs: 20,
      launch: async () => {
        launches += 1;
        return { runId: "must-not-run" };
      },
    });
    context.coordinator.start({ requestId: "timeout", requirements: "Time out" });
    const result = await context.coordinator.waitFor("timeout");
    expect(result).toMatchObject({ state: "failed", error: { code: "GenerationTimeout" } });
    expect(launches).toBe(0);
  });

  it("returns one request for duplicate starts and enforces input limits", async () => {
    let calls = 0;
    const generate: GenerateCandidate = async () => {
      calls += 1;
      return validCandidate;
    };
    const context = await makeContext(generate);
    const first = context.coordinator.start({ requestId: "duplicate", requirements: "same" });
    const second = context.coordinator.start({ requestId: "duplicate", requirements: "same" });
    expect(second.requestId).toBe(first.requestId);
    await context.coordinator.waitFor("duplicate");
    expect(calls).toBe(1);
    expect(() =>
      context.coordinator.start({ requestId: "unicode-limit", requirements: "😀".repeat(8193) }),
    ).toThrow("32 KiB");
  });
});
