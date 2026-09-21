import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve } from "node:path";
import { openWorkflowDatabase } from "../storage/db.js";
import { WorkflowRepository } from "../storage/repository.js";
import type { WorkflowDatabaseHandle, SavedWorkflowRecord } from "../storage/types.js";
import { EscalationRegistry, type EscalationQuestion } from "../interaction/escalation-registry.js";
import { runWorkflowScript, type RunSettlement, type RunWorkflowScriptOptions } from "../runtime/workflow-sandbox/harness.js";
import { createPiWorkflowDriver, type PiWorkflowDriverOptions } from "./pi-workflow-driver.js";
import { reconcileNonTerminalRuns } from "./reconcile.js";
import { lowerWorkflowScript, type LoweredWorkflow } from "../zcode-core/compiler/lower.js";
import { WorkflowEngine } from "../zcode-core/engine/engine.js";
import { WorkflowError } from "../zcode-core/engine/errors.js";
import type {
  Caps,
  RunRecord,
  WorkflowDriver,
  WorldReadOp,
} from "../zcode-core/engine/types.js";
import type { ChildCreateActorMessage, ChildEventMessage, ChildRequestMessage } from "../runtime/workflow-sandbox/protocol.js";

const execFileAsync = promisify(execFile);

export type WorkflowSourceInput =
  | { script: string }
  | { path: string }
  | { saved: { scope: "project" | "global"; name: string } | string };

export interface CreateWorkflowInput {
  source: WorkflowSourceInput;
  args?: Record<string, unknown>;
  name?: string;
  model?: string;
  thinking?: string;
  caps?: Partial<Caps>;
  parentSessionId?: string;
  toolCallId?: string;
}

export interface AcceptedWorkflowRun {
  runId: string;
  status: "running";
  scriptHash: string;
  graph: LoweredWorkflow["graph"];
}

export interface WorkflowRunServiceDependencies {
  cwd: string;
  workspaceIdentity?: string;
  database?: WorkflowDatabaseHandle;
  repository?: WorkflowRepository;
  driverFactory?(options: PiWorkflowDriverOptions): WorkflowDriver;
  runWorkflow?(options: RunWorkflowScriptOptions): Promise<RunSettlement>;
  actorRunningScript?: string;
  actorFallbackExecutable?: string;
  actorExecutable?: string;
  actorExecutableArgs?: PiWorkflowDriverOptions["actorExecutableArgs"];
  actorTimeoutMs?: number;
  hasUI?: boolean;
  askInteractive?(question: EscalationQuestion, signal?: AbortSignal): Promise<string | undefined>;
  headlessAnswer?: string | ((question: EscalationQuestion) => string | undefined | Promise<string | undefined>);
  executeWorldRead?(op: WorldReadOp, args: unknown[]): Promise<unknown>;
  executeArtifactPublish?: PiWorkflowDriverOptions["executeArtifactPublish"];
  reconcile?: boolean;
}

interface ActiveRun {
  record: RunRecord;
  engine: WorkflowEngine;
  driver: WorkflowDriver;
  controller: AbortController;
}

function defaultCaps(overrides: Partial<Caps> = {}): Caps {
  return {
    maxConcurrency: Math.max(1, Math.min(16, Math.floor(overrides.maxConcurrency ?? 4))),
    maxScriptBytes: Math.max(1024, Math.min(1024 * 1024, Math.floor(overrides.maxScriptBytes ?? 256 * 1024))),
    maxEventBytes: Math.max(1024, Math.min(1024 * 1024, Math.floor(overrides.maxEventBytes ?? 256 * 1024))),
  };
}

function isInside(cwd: string, target: string): boolean {
  const relativePath = relative(cwd, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function runId(): string {
  return `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function errorForSettlement(settlement: RunSettlement): WorkflowError {
  if (settlement.error !== undefined) return new WorkflowError("DriverError", settlement.error.message, { finalText: undefined });
  return new WorkflowError("DriverError", "Workflow child stopped without a structured error");
}

export class WorkflowRunService {
  readonly repository: WorkflowRepository;
  readonly workspaceKey: string;
  readonly escalation: EscalationRegistry;
  private readonly active = new Map<string, ActiveRun>();
  private readonly runWorkflowImpl: (options: RunWorkflowScriptOptions) => Promise<RunSettlement>;
  private readonly dependencies: WorkflowRunServiceDependencies;
  private readonly ownedDatabase?: WorkflowDatabaseHandle;

  constructor(repository: WorkflowRepository, database: WorkflowDatabaseHandle | undefined, dependencies: WorkflowRunServiceDependencies) {
    this.repository = repository;
    this.ownedDatabase = database;
    this.dependencies = dependencies;
    this.workspaceKey = database?.workspaceKey ?? (dependencies.workspaceIdentity?.trim() || resolve(dependencies.cwd));
    this.runWorkflowImpl = dependencies.runWorkflow ?? runWorkflowScript;
    this.escalation = new EscalationRegistry({
      persistence: repository,
      journal: repository,
      hasUI: dependencies.hasUI,
      askInteractive: dependencies.askInteractive,
      headlessAnswer: dependencies.headlessAnswer,
    });
  }

  validate(source: string): ReturnType<typeof lowerWorkflowScript> {
    return lowerWorkflowScript(source);
  }

  async createWorkflow(input: CreateWorkflowInput): Promise<AcceptedWorkflowRun> {
    const source = await this.resolveSource(input.source);
    const lowered = this.compileSource(source.text, input.caps);
    const record: RunRecord = {
      runId: runId(),
      workspaceKey: this.workspaceKey,
      cwd: resolve(this.dependencies.cwd),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      ...(source.path === undefined ? {} : { scriptPath: source.path }),
      scriptText: source.text,
      scriptHash: lowered.scriptHash,
      args: input.args ?? {},
      caps: defaultCaps(input.caps),
      ...(input.model === undefined ? {} : { subagentModel: input.model }),
      spentTokens: 0,
      status: "pending",
      createdAt: Date.now(),
    };
    this.persistLaunch(record, input.model, lowered);
    this.launch(record, lowered, input.model, input.thinking);
    return { runId: record.runId, status: "running", scriptHash: lowered.scriptHash, graph: lowered.graph };
  }

  async resumeRun(existingRunId: string, source?: WorkflowSourceInput): Promise<AcceptedWorkflowRun> {
    const existing = this.requireRun(existingRunId);
    if (existing.status !== "stopped") throw new WorkflowError("Cancelled", `Only stopped runs can resume: ${existingRunId}`);
    const sourceData = source === undefined ? { text: existing.scriptText ?? "", path: existing.scriptPath } : await this.resolveSource(source);
    if (sourceData.text.length === 0) throw new WorkflowError("DriverError", "The stopped run has no saved script");
    const lowered = this.compileSource(sourceData.text, existing.caps);
    if (existing.scriptHash !== undefined && existing.scriptHash !== lowered.scriptHash) throw new WorkflowError("ScriptHashMismatch", "The workflow source changed since the run was stopped");
    const record: RunRecord = { ...existing, scriptText: sourceData.text, ...(sourceData.path === undefined ? {} : { scriptPath: sourceData.path }), status: "running", stopReason: undefined, failure: undefined, result: undefined, updatedAt: Date.now() };
    this.repository.updateRunStatus(existingRunId, "running");
    this.repository.appendEvent(existingRunId, { type: "run-launched", scriptPath: record.scriptPath, subagentModel: record.subagentModel });
    this.launch(record, lowered, record.subagentModel);
    return { runId: existingRunId, status: "running", scriptHash: lowered.scriptHash, graph: lowered.graph };
  }

  async amendRun(existingRunId: string, input: CreateWorkflowInput): Promise<AcceptedWorkflowRun> {
    const previous = this.requireRun(existingRunId);
    const source = await this.resolveSource(input.source);
    const lowered = this.compileSource(source.text, input.caps);
    const nextId = runId();
    this.repository.updateRunStatus(existingRunId, "stopped", { stopReason: "superseded", supersededBy: nextId });
    this.repository.appendEvent(existingRunId, { type: "run-settled", status: "stopped", stopReason: "superseded", supersededBy: nextId });
    const record: RunRecord = {
      runId: nextId,
      workspaceKey: this.workspaceKey,
      cwd: resolve(this.dependencies.cwd),
      ...(input.name === undefined ? {} : { name: input.name }),
      scriptText: source.text,
      ...(source.path === undefined ? {} : { scriptPath: source.path }),
      scriptHash: lowered.scriptHash,
      args: input.args ?? previous.args ?? {},
      caps: defaultCaps(input.caps ?? previous.caps),
      ...(input.model === undefined ? previous.subagentModel === undefined ? {} : { subagentModel: previous.subagentModel } : { subagentModel: input.model }),
      spentTokens: 0,
      status: "pending",
      resumedFrom: existingRunId,
      createdAt: Date.now(),
    };
    this.persistLaunch(record, record.subagentModel, lowered);
    this.launch(record, lowered, record.subagentModel, input.thinking);
    return { runId: nextId, status: "running", scriptHash: lowered.scriptHash, graph: lowered.graph };
  }

  stopRun(existingRunId: string): RunRecord {
    const active = this.active.get(existingRunId);
    if (active !== undefined) {
      active.engine.stop("user", new WorkflowError("Cancelled", "Workflow run stopped by the user"));
      active.controller.abort();
      this.escalation.cancelRun(existingRunId);
    } else {
      const run = this.requireRun(existingRunId);
      if (run.status === "pending" || run.status === "running") this.repository.updateRunStatus(existingRunId, "stopped", { stopReason: "user" });
    }
    return this.requireRun(existingRunId);
  }

  getRun(existingRunId: string): RunRecord {
    return this.requireRun(existingRunId);
  }

  listRuns(limit = 20): RunRecord[] {
    return this.repository.listRuns(this.workspaceKey, limit);
  }

  resolveWorkflowQuestion(qid: string, answer: string): void {
    this.escalation.resolve(qid, answer);
  }

  saveWorkflow(record: Omit<SavedWorkflowRecord, "scriptHash" | "updatedAt">): SavedWorkflowRecord {
    const scriptHash = createHash("sha256").update(record.sourceText).digest("hex");
    const saved = { ...record, scriptHash, updatedAt: Date.now() };
    this.repository.saveWorkflow(saved);
    return saved;
  }

  listSavedWorkflows(scope?: SavedWorkflowRecord["scope"]): SavedWorkflowRecord[] {
    return this.repository.listSavedWorkflows(scope);
  }

  reconcile(): RunRecord[] {
    return reconcileNonTerminalRuns(this.repository, this.workspaceKey);
  }

  async dispose(): Promise<void> {
    for (const runId of [...this.active.keys()]) this.stopRun(runId);
    for (let attempt = 0; attempt < 200 && this.active.size > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    this.ownedDatabase?.close();
  }

  private compileSource(source: string, caps?: Partial<Caps>): LoweredWorkflow {
    const normalizedCaps = defaultCaps(caps);
    if (Buffer.byteLength(source, "utf8") > normalizedCaps.maxScriptBytes!) throw new WorkflowError("ValidationFailed", "Workflow source exceeds the script byte cap");
    const result = lowerWorkflowScript(source);
    if (!result.ok || result.lowered === undefined) {
      throw new WorkflowError("ValidationFailed", "Workflow source failed compilation", { violations: result.diagnostics.map((diagnostic) => ({ path: `${diagnostic.line}:${diagnostic.column}`, expected: "valid workflow source", actual: diagnostic.message })) });
    }
    return result.lowered;
  }

  private persistLaunch(record: RunRecord, model: string | undefined, lowered: LoweredWorkflow): void {
    this.repository.transaction(() => {
      this.repository.createRun(record);
      this.repository.appendEvent(record.runId, { type: "run-started", runId: record.runId, caps: record.caps });
      this.repository.updateRunStatus(record.runId, "running");
      this.repository.appendEvent(record.runId, { type: "run-launched", subagentModel: model, scriptPath: record.scriptPath, phaseNames: lowered.graph.phases.map((phase) => phase.name) });
    });
  }

  private launch(record: RunRecord, lowered: LoweredWorkflow, model?: string, thinking?: string): void {
    const controller = new AbortController();
    const actorOptions: PiWorkflowDriverOptions = {
      runId: record.runId,
      cwd: record.cwd ?? resolve(this.dependencies.cwd),
      workspaceKey: this.workspaceKey,
      journal: this.repository,
      maxConcurrency: record.caps.maxConcurrency,
      model,
      thinking,
      runningScript: this.dependencies.actorRunningScript,
      fallbackExecutable: this.dependencies.actorFallbackExecutable,
      actorExecutable: this.dependencies.actorExecutable,
      actorExecutableArgs: this.dependencies.actorExecutableArgs,
      actorTimeoutMs: this.dependencies.actorTimeoutMs,
      executeWorldRead: this.dependencies.executeWorldRead ?? ((op, args) => defaultWorldRead(record.cwd ?? resolve(this.dependencies.cwd), op, args)),
      executeArtifactPublish: this.dependencies.executeArtifactPublish,
    };
    let engine: WorkflowEngine | undefined;
    const driverOptions: PiWorkflowDriverOptions = {
      ...actorOptions,
      onResolveAsk: (instance, value, stats) => engine?.resolveAsk(instance, value, stats),
      onRejectAsk: (instance, error) => engine?.rejectAsk(instance, error),
    };
    const driver = (this.dependencies.driverFactory ?? createPiWorkflowDriver)(driverOptions);
    engine = new WorkflowEngine({ runId: record.runId, caps: record.caps, journal: this.repository, driver });
    const activeRun: ActiveRun = { record, engine, driver, controller };
    this.active.set(record.runId, activeRun);
    const actorIds = new Map<string, string>();
    const task = this.runWorkflowImpl({
      runId: record.runId,
      cwd: record.cwd ?? resolve(this.dependencies.cwd),
      code: lowered.code,
      args: record.args ?? {},
      signal: controller.signal,
      maxLineBytes: record.caps.maxEventBytes,
      onCreateActor: (message) => this.handleCreateActor(engine!, actorIds, message),
      onEvent: (message) => this.handleChildEvent(engine!, message),
      onRequest: (message) => this.handleChildRequest(record.runId, engine!, actorIds, message, controller.signal),
    }).then((settlement) => {
      if (settlement.status === "completed") engine?.complete(settlement.value);
      else if (settlement.status === "errored") engine?.fail(errorForSettlement(settlement));
      else engine?.stop(settlement.stopReason ?? "interrupted", errorForSettlement(settlement));
    }).catch((error) => engine?.fail(error)).finally(() => {
      if (this.active.get(record.runId) === activeRun) this.active.delete(record.runId);
    });
    void task;
  }

  private handleCreateActor(engine: WorkflowEngine, actorIds: Map<string, string>, message: ChildCreateActorMessage): void {
    const actor = engine.createActor(message.siteId, message.name, message.persona as string | { system?: string } | undefined);
    actorIds.set(message.localId, actor);
  }

  private handleChildEvent(engine: WorkflowEngine, message: ChildEventMessage): void {
    if (message.type === "phase-entered" && typeof message.name === "string") engine.enterPhase(message.name);
    else if (message.type === "log" && typeof message.message === "string") engine.log(message.message);
    else if (message.type === "report" && typeof message.siteId === "string") engine.report(message.siteId, message.item, typeof message.artifactId === "string" ? message.artifactId : undefined);
    else if (message.type === "declare-artifact" && typeof message.siteId === "string" && typeof message.op === "string" && Array.isArray(message.args)) engine.declareArtifact(message.siteId, message.op as "chart" | "table" | "metrics" | "board", message.args);
  }

  private handleChildRequest(runIdValue: string, engine: WorkflowEngine, actorIds: Map<string, string>, message: ChildRequestMessage, signal: AbortSignal): Promise<unknown> {
    if (message.type === "ask") {
      if (message.actor === undefined || message.instructions === undefined) return Promise.reject(new WorkflowError("DriverError", "Boundary-A ask request is missing actor or instructions"));
      return engine.ask(message.siteId, actorIds.get(message.actor) ?? message.actor, message.instructions);
    }
    if (message.type === "world-read" || message.type === "world-run") return engine.worldRead(message.siteId, (message.op ?? "world.run") as WorldReadOp, message.args ?? []);
    if (message.type === "publish-artifact") return engine.publishArtifact(message.siteId, (message.op ?? "file") as "file" | "markdown", message.args ?? []);
    const args = message.args ?? [];
    return this.escalation.request({ runId: runIdValue, question: String(args[0] ?? "Workflow input required"), context: args[1] === undefined ? undefined : String(args[1]) }, signal);
  }

  private requireRun(runIdValue: string): RunRecord {
    const run = this.repository.getRun(runIdValue);
    if (run === undefined) throw new WorkflowError("DriverError", `Unknown workflow run: ${runIdValue}`);
    return run;
  }

  private async resolveSource(source: WorkflowSourceInput): Promise<{ text: string; path?: string }> {
    if ("script" in source) return { text: source.script };
    if ("path" in source) {
      const path = resolve(this.dependencies.cwd, source.path);
      if (!isInside(resolve(this.dependencies.cwd), path)) throw new WorkflowError("ArtifactPathOutsideWorkspace", "Workflow source path is outside the workspace");
      return { text: await readFile(path, "utf8"), path };
    }
    const saved = typeof source.saved === "string" ? (source.saved.includes(":") ? { scope: source.saved.split(":", 1)[0] as "project" | "global", name: source.saved.split(":").slice(1).join(":") } : { scope: "project" as const, name: source.saved }) : source.saved;
    const found = this.repository.listSavedWorkflows(saved.scope).find((item) => item.name === saved.name);
    if (found === undefined) throw new WorkflowError("DriverError", `Saved workflow not found: ${saved.scope}:${saved.name}`);
    return { text: found.sourceText };
  }
}

export async function createWorkflowRunService(dependencies: WorkflowRunServiceDependencies): Promise<WorkflowRunService> {
  const database = dependencies.database ?? (dependencies.repository === undefined ? await openWorkflowDatabase({ cwd: dependencies.cwd, workspaceIdentity: dependencies.workspaceIdentity }) : undefined);
  const repository = dependencies.repository ?? new WorkflowRepository(database!.db);
  const service = new WorkflowRunService(repository, dependencies.database === undefined ? database : undefined, dependencies);
  if (dependencies.reconcile !== false) service.reconcile();
  return service;
}

async function defaultWorldRead(cwd: string, op: WorldReadOp, args: unknown[]): Promise<unknown> {
  if (op === "files.read") {
    const path = resolve(cwd, String(args[0] ?? ""));
    if (!isInside(cwd, path)) throw new WorkflowError("ArtifactPathOutsideWorkspace", "World read path is outside the workspace");
    return (await readFile(path, "utf8")).slice(0, 64 * 1024);
  }
  if (op === "files.glob") {
    const pattern = String(args[0] ?? "**/*");
    const result = await execFileAsync("rg", ["--files", "--glob", pattern], { cwd, maxBuffer: 64 * 1024 });
    return result.stdout.split("\n").filter(Boolean).slice(0, 2000);
  }
  if (op === "files.grep") {
    const pattern = String(args[0] ?? "");
    const path = String(args[1] ?? ".");
    const result = await execFileAsync("rg", ["--line-number", "--no-heading", pattern, path], { cwd, maxBuffer: 64 * 1024 });
    return result.stdout;
  }
  if (op.startsWith("git.")) {
    const command = op.slice(4);
    const result = await execFileAsync("git", [command, ...args.map(String)], { cwd, maxBuffer: 64 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  }
  if (op === "world.run") {
    const command = String(args[0] ?? "");
    const commandArgs = Array.isArray(args[1]) ? args[1].map(String) : [];
    if (command.length === 0 || command.includes("/")) throw new WorkflowError("DriverError", "world.run requires an allowed executable name");
    const result = await execFileAsync(command, commandArgs, { cwd, maxBuffer: 64 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  }
  throw new WorkflowError("DriverError", `Unsupported world operation: ${op}`);
}
