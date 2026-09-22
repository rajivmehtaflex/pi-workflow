import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePiInvocation } from "../src/runtime/pi-actor/invocation.js";
import { spawnPiActorTurn } from "../src/runtime/pi-actor/process.js";
import { actorSessionPath } from "../src/runtime/pi-actor/session-path.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-actor-"));
  roots.push(cwd);
  return cwd;
}

async function fakePi(cwd: string, body: string): Promise<string> {
  const path = join(cwd, "fake-pi.mjs");
  await writeFile(path, body, { encoding: "utf8", mode: 0o700 });
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Boundary-B Pi actor process", () => {
  it("resolves a running-script invocation with a no-recursion policy", async () => {
    const invocation = resolvePiInvocation({
      runningScript: "/tmp/pi-entry.mjs",
      sessionPath: "/tmp/actor.jsonl",
      prompt: "inspect",
      model: "fixture/model",
      thinking: "low",
      systemPromptPath: "/tmp/prompt.txt",
    });
    expect(invocation.executable).toBe(process.execPath);
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "/tmp/pi-entry.mjs",
        "--mode",
        "json",
        "-p",
        "--session",
        "/tmp/actor.jsonl",
        "--no-extensions",
        "--model",
        "fixture/model",
        "--thinking",
        "low",
        "--append-system-prompt",
        "/tmp/prompt.txt",
        "inspect",
      ]),
    );
  });

  it("derives a run-scoped actor session path", async () => {
    const cwd = await root();
    const first = actorSessionPath({
      cwd,
      workspaceKey: "workspace-1",
      runId: "run/1",
      actor: { siteId: "actor#1", ordinal: 1 },
    });
    const second = actorSessionPath({
      cwd,
      workspaceKey: "workspace-1",
      runId: "run/1",
      actor: { siteId: "actor#2", ordinal: 1 },
    });
    expect(first).toContain(join(".pi", "workflow-runs", "run_1", "actors"));
    expect(first).not.toBe(second);
    expect(first).not.toContain("workspace-1");
  });

  it("runs a fake Pi child, captures final JSON, usage, and progress", async () => {
    const cwd = await root();
    const fake = await fakePi(
      cwd,
      `
      process.stdout.write(JSON.stringify({ type: "session", version: 1, id: "s" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_update", messageId: "m", assistantMessageEvent: { type: "text_delta", delta: "partial" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "{\\"ok\\":true}" }], stopReason: "stop" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", reason: "stop", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }) + "\\n");
    `,
    );
    const progress: string[] = [];
    const result = await spawnPiActorTurn({
      cwd,
      executable: process.execPath,
      executableArgs: [fake],
      sessionPath: actorSessionPath({
        cwd,
        workspaceKey: "workspace-1",
        runId: "run-1",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      prompt: "inspect",
      onUpdate: (event) => progress.push(event.type),
    });
    expect(result).toMatchObject({ status: "completed", text: '{"ok":true}', stopReason: "stop" });
    expect(result.usage?.totalTokens).toBe(3);
    expect(progress).toContain("message_update");
  });

  it("stops malformed or hanging children and ignores late events", async () => {
    const cwd = await root();
    const malformed = await fakePi(cwd, 'process.stdout.write("not-json\\n");');
    await expect(
      spawnPiActorTurn({
        cwd,
        executable: process.execPath,
        executableArgs: [malformed],
        sessionPath: join(cwd, "a.jsonl"),
        prompt: "x",
      }),
    ).resolves.toMatchObject({ status: "errored" });

    const hanging = await fakePi(
      cwd,
      `
      process.stdout.write(JSON.stringify({ type: "message_end", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" } }) + "\\n");
      setTimeout(() => process.stdout.write(JSON.stringify({ type: "message_end", messageId: "m2", message: { role: "assistant", content: [{ type: "text", text: "late" }], stopReason: "stop" } }) + "\\n"), 100);
      setTimeout(() => undefined, 1000);
    `,
    );
    const result = await spawnPiActorTurn({
      cwd,
      executable: process.execPath,
      executableArgs: [hanging],
      sessionPath: join(cwd, "b.jsonl"),
      prompt: "x",
      timeoutMs: 200,
    });
    expect(result).toMatchObject({ status: "completed", text: "first" });
  });

  it("returns a structured validation failure for a typed ask with invalid JSON", async () => {
    const cwd = await root();
    const fake = await fakePi(
      cwd,
      'process.stdout.write(JSON.stringify({ type: "message_end", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "not-json" }], stopReason: "stop" } }) + "\\n");',
    );
    const result = await spawnPiActorTurn({
      cwd,
      executable: process.execPath,
      executableArgs: [fake],
      sessionPath: join(cwd, "typed.jsonl"),
      prompt: "return JSON",
      result: { parseJson: true },
    });
    expect(result).toMatchObject({
      status: "errored",
      error: { code: "ValidationFailed", finalText: "not-json" },
    });
  });
});
