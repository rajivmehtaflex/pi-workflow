import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface WorkflowChildProcessOptions {
  entryPath: string;
  cwd: string;
}

export function spawnWorkflowChild(options: WorkflowChildProcessOptions): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [options.entryPath], {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: {
      PATH: process.env.PATH ?? "",
      NODE_NO_WARNINGS: "1",
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function terminateWorkflowChild(child: ChildProcessWithoutNullStreams, graceMs = 100): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      resolve();
    }, graceMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
