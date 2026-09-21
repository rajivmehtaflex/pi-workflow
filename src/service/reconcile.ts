import type { WorkflowRepository } from "../storage/repository.js";
import type { RunRecord } from "../zcode-core/engine/types.js";

export function reconcileNonTerminalRuns(repository: WorkflowRepository, workspaceKey: string): RunRecord[] {
  const recovered: RunRecord[] = [];
  for (const run of repository.listNonTerminalRuns(workspaceKey)) {
    repository.updateRunStatus(run.runId, "stopped", { stopReason: "interrupted" });
    repository.appendEvent(run.runId, { type: "run-settled", status: "stopped", stopReason: "interrupted" });
    const updated = repository.getRun(run.runId);
    if (updated !== undefined) recovered.push(updated);
  }
  return recovered;
}
