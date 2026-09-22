import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkflowScript } from "../src/runtime/workflow-sandbox/harness.js";
import {
  NdjsonLineParser,
  WorkflowProtocolError,
  parseChildMessage,
} from "../src/runtime/workflow-sandbox/protocol.js";

const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-sandbox-"));
  workspaces.push(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

describe("Boundary-A NDJSON protocol", () => {
  it("buffers partial lines and preserves UTF-8 boundaries", () => {
    const parser = new NdjsonLineParser({ maxLineBytes: 1024 });
    expect(parser.push(Buffer.from('{"kind":"event","type":"log","message":"'))).toEqual([]);
    expect(parser.push(Buffer.from("你好"))).toEqual([]);
    expect(parser.push(Buffer.from('"}\n'))).toEqual([
      { kind: "event", type: "log", message: "你好" },
    ]);
  });

  it("rejects malformed, unknown, and oversized messages", () => {
    expect(() => parseChildMessage("not-json")).toThrow(WorkflowProtocolError);
    expect(() => parseChildMessage(JSON.stringify({ kind: "unknown" }))).toThrow(
      WorkflowProtocolError,
    );
    const parser = new NdjsonLineParser({ maxLineBytes: 8 });
    expect(() => parser.push(Buffer.from('{"kind":"event"}\n'))).toThrow(WorkflowProtocolError);
  });

  it("runs lowered code through the child and preserves event-before-complete ordering", async () => {
    const events: string[] = [];
    const result = await runWorkflowScript({
      runId: "run-events",
      cwd: await workspace(),
      code: '__host.log("first"); return { ok: true };',
      args: {},
      onEvent: (event) => events.push(event.type),
    });

    expect(result).toMatchObject({ status: "completed", value: { ok: true } });
    expect(events).toEqual(["log"]);
  });

  it("correlates requests and lets a rejected request be caught by the workflow", async () => {
    const requests: string[] = [];
    const result = await runWorkflowScript({
      runId: "run-request",
      cwd: await workspace(),
      code: `
        try {
          await __host.ask("ask#1", "actor#1@1", "question");
          return false;
        } catch (error) {
          __host.log(error.code);
          return true;
        }
      `,
      args: {},
      onRequest: async (request) => {
        requests.push(request.id);
        throw { code: "DriverError", message: "rejected" };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.value).toBe(true);
    expect(requests).toEqual(["request-1"]);
  });

  it("maps child crashes, timeouts, and aborts to one stopped settlement", async () => {
    const crashed = await runWorkflowScript({
      runId: "run-crash",
      cwd: await workspace(),
      code: "",
      args: {},
      entrySource: "process.exit(7);",
    });
    expect(crashed).toMatchObject({ status: "stopped", stopReason: "interrupted" });

    const timedOut = await runWorkflowScript({
      runId: "run-timeout",
      cwd: await workspace(),
      code: "await new Promise(() => undefined);",
      args: {},
      timeoutMs: 20,
    });
    expect(timedOut).toMatchObject({ status: "stopped", stopReason: "interrupted" });

    const controller = new AbortController();
    const aborted = runWorkflowScript({
      runId: "run-abort",
      cwd: await workspace(),
      code: "await new Promise(() => undefined);",
      args: {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ status: "stopped", stopReason: "interrupted" });
  });

  it("uses first-wins completion and ignores a duplicate late completion", async () => {
    const result = await runWorkflowScript({
      runId: "run-first-wins",
      cwd: await workspace(),
      code: "",
      args: {},
      entrySource: `
        process.stdout.write(JSON.stringify({ kind: "complete", ok: true, value: "first" }) + "\\n");
        setTimeout(() => process.stdout.write(JSON.stringify({ kind: "complete", ok: true, value: "late" }) + "\\n"), 10);
      `,
    });
    expect(result).toMatchObject({ status: "completed", value: "first" });
  });
});
