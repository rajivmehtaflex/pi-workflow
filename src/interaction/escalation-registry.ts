import { randomUUID } from "node:crypto";
import { WorkflowError } from "../zcode-core/engine/errors.js";
import type { InstanceRef, JournalStorePort, RunEvent } from "../zcode-core/engine/types.js";
import type { EscalationRecord } from "../storage/types.js";

export interface EscalationPersistence {
  putEscalation(record: EscalationRecord): void;
  getEscalation(qid: string): EscalationRecord | undefined;
  updateEscalation(qid: string, status: EscalationRecord["status"], answer?: string): EscalationRecord;
  listPendingEscalations(runId: string): EscalationRecord[];
}

export interface EscalationQuestion {
  qid: string;
  runId: string;
  instance?: InstanceRef;
  question: string;
  context?: string;
}

export interface EscalationRegistryOptions {
  persistence: EscalationPersistence;
  journal: JournalStorePort;
  hasUI?: boolean;
  askInteractive?(question: EscalationQuestion, signal?: AbortSignal): Promise<string | undefined>;
  headlessAnswer?: string | ((question: EscalationQuestion) => string | undefined | Promise<string | undefined>);
}

interface PendingQuestion {
  question: EscalationQuestion;
  resolve(answer: string): void;
  reject(error: unknown): void;
}

function emitEscalationEvent(journal: JournalStorePort, runId: string, event: RunEvent): void {
  journal.appendEvent(runId, event);
}

export class EscalationRegistry {
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(private readonly options: EscalationRegistryOptions) {}

  request(question: Omit<EscalationQuestion, "qid">, signal?: AbortSignal): Promise<string> {
    const qid = randomUUID();
    const full: EscalationQuestion = { ...question, qid };
    this.options.persistence.putEscalation({
      qid,
      runId: full.runId,
      ...(full.instance === undefined ? {} : { actorSiteId: full.instance.siteId, actorOrdinal: full.instance.ordinal }),
      question: full.question,
      ...(full.context === undefined ? {} : { context: full.context }),
      askedAt: Date.now(),
      status: "pending",
    });
    emitEscalationEvent(this.options.journal, full.runId, { type: "escalation-requested", qid, question: full.question, ...(full.context === undefined ? {} : { context: full.context }), askedAt: Date.now() });
    const promise = new Promise<string>((resolve, reject) => this.pending.set(qid, { question: full, resolve, reject }));
    if (signal !== undefined) {
      if (signal.aborted) this.cancel(qid, "Escalation was aborted");
      else signal.addEventListener("abort", () => this.cancel(qid, "Escalation was aborted"), { once: true });
    }
    void this.resolveFromConfiguredSource(full);
    return promise;
  }

  resolve(qid: string, answer: string): void {
    const record = this.options.persistence.getEscalation(qid);
    const pending = this.pending.get(qid);
    if (record === undefined || record.status !== "pending" || pending === undefined) throw new WorkflowError("DriverError", `Unknown or settled escalation: ${qid}`);
    const run = this.options.journal.getRun(record.runId);
    if (run === undefined || ["completed", "errored", "stopped"].includes(run.status)) {
      this.cancel(qid, "The workflow run is already settled");
      throw new WorkflowError("Cancelled", `Workflow run is already settled: ${record.runId}`);
    }
    this.options.persistence.updateEscalation(qid, "resolved", answer);
    this.pending.delete(qid);
    emitEscalationEvent(this.options.journal, record.runId, { type: "escalation-resolved", qid, answer });
    pending.resolve(answer);
  }

  cancel(qid: string, message = "Escalation was cancelled"): void {
    const pending = this.pending.get(qid);
    const record = this.options.persistence.getEscalation(qid);
    if (pending === undefined || record === undefined || record.status !== "pending") return;
    this.options.persistence.updateEscalation(qid, "cancelled");
    this.pending.delete(qid);
    pending.reject(new WorkflowError("Cancelled", message));
  }

  cancelRun(runId: string): void {
    for (const [qid, pending] of this.pending) if (pending.question.runId === runId) this.cancel(qid);
    for (const record of this.options.persistence.listPendingEscalations(runId)) this.options.persistence.updateEscalation(record.qid, "cancelled");
  }

  pendingForRun(runId: string): EscalationRecord[] {
    return this.options.persistence.listPendingEscalations(runId);
  }

  private async resolveFromConfiguredSource(question: EscalationQuestion): Promise<void> {
    try {
      let answer: string | undefined;
      if (this.options.headlessAnswer !== undefined) {
        answer = typeof this.options.headlessAnswer === "function" ? await this.options.headlessAnswer(question) : this.options.headlessAnswer;
      } else if (this.options.hasUI === true && this.options.askInteractive !== undefined) {
        answer = await this.options.askInteractive(question);
      } else {
        throw new WorkflowError("NoUserInterface", "Workflow escalation requires an interactive UI or configured headless answer");
      }
      if (answer === undefined) throw new WorkflowError("NoUserInterface", "Workflow escalation did not receive an answer");
      this.resolve(question.qid, answer);
    } catch (error) {
      this.cancel(question.qid, error instanceof Error ? error.message : "Workflow escalation failed");
    }
  }
}

export function createEscalationRegistry(options: EscalationRegistryOptions): EscalationRegistry {
  return new EscalationRegistry(options);
}
