import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkflowChildSource } from "./child-source.js";

export interface WriteWorkflowEntryOptions {
  runDir: string;
  runId: string;
  code: string;
  args: Record<string, unknown>;
  source?: string;
}

export async function writeWorkflowEntryFile(options: WriteWorkflowEntryOptions): Promise<string> {
  await mkdir(options.runDir, { recursive: true });
  const safeRunId = options.runId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const entryPath = join(options.runDir, `${safeRunId}-entry.mjs`);
  const source = options.source ?? createWorkflowChildSource({ code: options.code, args: options.args });
  await writeFile(entryPath, source, { encoding: "utf8", mode: 0o600 });
  return entryPath;
}
