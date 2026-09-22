import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPiGenerator,
  GenerationError,
  parseGenerationCandidate,
} from "../src/requirements/generator.js";
import {
  buildGenerationContext,
  buildGenerationPrompt,
  truncateUtf8,
} from "../src/requirements/prompt.js";
import { resolvePiInvocation } from "../src/runtime/pi-actor/invocation.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi-generator.mjs", import.meta.url));
const roots: string[] = [];
const originalMarker = process.env.PI_GENERATOR_MARKER;

async function root(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-generator-"));
  roots.push(cwd);
  return cwd;
}

afterEach(async () => {
  if (originalMarker === undefined) delete process.env.PI_GENERATOR_MARKER;
  else process.env.PI_GENERATOR_MARKER = originalMarker;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function generator(cwd: string) {
  return createPiGenerator({
    cwd,
    runningScript: fixture,
    sessionPath: join(cwd, "generation.jsonl"),
    timeoutMs: 500,
  });
}

describe("requirements candidate generation", () => {
  it("parses a plain JSON candidate and one surrounding JSON fence", () => {
    const candidate = {
      source: 'phase("Check"); return { ok: true };',
      assumptions: ["The repository is available"],
      acceptanceCriteria: ["The workflow compiles"],
    };
    expect(parseGenerationCandidate(JSON.stringify(candidate))).toEqual(candidate);
    expect(parseGenerationCandidate(`\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``)).toEqual(
      candidate,
    );
  });

  it("rejects malformed, mixed, oversized, and structurally invalid output", () => {
    expect(() => parseGenerationCandidate("not JSON")).toThrow(GenerationError);
    expect(() =>
      parseGenerationCandidate(
        'Here is the workflow: {"source":"x","assumptions":[],"acceptanceCriteria":[]}',
      ),
    ).toThrow("plain JSON");
    expect(() => parseGenerationCandidate("x".repeat(256 * 1024 + 1))).toThrow("256 KiB");
    expect(() =>
      parseGenerationCandidate(JSON.stringify({ assumptions: [], acceptanceCriteria: [] })),
    ).toThrow("source");
    expect(() =>
      parseGenerationCandidate(
        JSON.stringify({
          source: 'phase("Check"); return { ok: true };',
          assumptions: [],
          acceptanceCriteria: [],
          unexpected: true,
        }),
      ),
    ).toThrow("additional");
  });

  it("runs the active Pi host with a bounded generation profile", async () => {
    const cwd = await root();
    const candidate = await generator(cwd)(
      {
        requirements: "fixture: valid",
        context: "status: clean",
        diagnostics: [],
      },
      new AbortController().signal,
    );
    expect(candidate).toEqual({
      source: 'phase("Check"); return { ok: true };',
      assumptions: ["fixture assumption"],
      acceptanceCriteria: ["fixture criterion"],
    });
  });

  it("reports provider and output failures as generation errors", async () => {
    const cwd = await root();
    const run = generator(cwd);
    await expect(
      run(
        { requirements: "fixture: malformed", context: "", diagnostics: [] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "GenerationOutputInvalid" });
    await expect(
      run(
        { requirements: "fixture: missing-source", context: "", diagnostics: [] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "GenerationOutputInvalid" });
    await expect(
      run(
        { requirements: "fixture: oversized", context: "", diagnostics: [] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "GenerationOutputTooLarge" });
    await expect(
      run(
        { requirements: "fixture: provider-error", context: "", diagnostics: [] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "GenerationProcess" });
  });

  it("terminates a hanging generation child when cancelled", async () => {
    const cwd = await root();
    const marker = join(cwd, "terminated.txt");
    const pidMarker = `${marker}.pid`;
    process.env.PI_GENERATOR_MARKER = marker;
    const controller = new AbortController();
    const pending = generator(cwd)(
      { requirements: "fixture: hanging", context: "", diagnostics: [] },
      controller.signal,
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(pidMarker, "utf8");
        break;
      } catch {
        if (attempt === 99) throw new Error("generation child did not start");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: "GenerationAborted" });
    const pid = Number(await readFile(pidMarker, "utf8"));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        expect(await readFile(marker, "utf8")).toBe("terminated");
        return;
      }
    }
    throw new Error("generation child was not terminated");
  });

  it("keeps ordinary actors unchanged while generation disables tools and discovery", () => {
    const actor = resolvePiInvocation({
      sessionPath: "/tmp/actor.jsonl",
      prompt: "inspect",
    });
    expect(actor.args).toContain("--no-extensions");
    expect(actor.args).not.toContain("--no-tools");
    expect(actor.args).not.toContain("--no-skills");

    const generation = resolvePiInvocation({
      sessionPath: "/tmp/generator.jsonl",
      prompt: "generate",
      profile: "generation",
      fallbackExecutable: "/custom/pi",
    });
    expect(generation.executable).toBe("/custom/pi");
    expect(generation.args).toEqual(
      expect.arrayContaining([
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
      ]),
    );
  });

  it("builds bounded, context-only prompts and an empty context outside Git", async () => {
    const context = await buildGenerationContext("/tmp");
    expect(context).toBe("");
    expect(
      Buffer.byteLength(truncateUtf8("😀".repeat(20_000), 16 * 1024), "utf8"),
    ).toBeLessThanOrEqual(16 * 1024);
    const prompt = buildGenerationPrompt({
      requirements: "Review the changed files",
      context: "git status: clean",
      diagnostics: ["previous candidate did not compile"],
    });
    expect(prompt).toContain("phase");
    expect(prompt).toContain("Promise.all");
    expect(prompt).toContain("previous candidate did not compile");
    expect(prompt).toContain("Review the changed files");
  });
});
