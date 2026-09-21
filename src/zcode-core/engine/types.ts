export type RunStatus = "pending" | "running" | "completed" | "errored" | "stopped";
export type RunStopReason = "user" | "model" | "provider" | "interrupted" | "superseded";
export type NodeKind = "ask" | "world-read" | "world-run" | "report" | "artifact";
export type NodeOutcome = "ok" | "failed" | "cancelled";
export type NodeRecordStatus = "running" | "completed" | "failed";
export type ActorId = string;
export type WorldReadOp =
  | "files.glob"
  | "files.read"
  | "files.grep"
  | "git.changedFiles"
  | "git.diff"
  | "git.status"
  | "git.log"
  | "world.run";
export type ArtifactContentOp = "file" | "markdown";
export type ArtifactPresetOp = "chart" | "table" | "metrics" | "board";

export interface Caps {
  maxConcurrency: number;
  maxScriptBytes?: number;
  maxEventBytes?: number;
}

export interface InstanceRef {
  siteId: string;
  ordinal: number;
}

export type ActorRef = InstanceRef;

export interface PersonaSpec {
  system?: string;
}

export interface AskMessage {
  instructions: string;
  typed: boolean;
  schema?: unknown;
}

export interface Violation {
  path: string;
  expected: string;
  actual?: unknown;
  message?: string;
}

export type WorkflowErrorCode =
  | "ValidationFailed"
  | "ResultNotSubmitted"
  | "DriverError"
  | "WorldReadCapExceeded"
  | "Cancelled"
  | "ContextLimit"
  | "ReportCapExceeded"
  | "InputHashMismatch"
  | "UnknownActor"
  | "MissingAskSpec"
  | "DuplicateActorName"
  | "ScriptHashMismatch"
  | "Interrupted"
  | "ProviderStop"
  | "ArtifactSourceMissing"
  | "ArtifactPathOutsideWorkspace"
  | "ArtifactTooLarge"
  | "ArtifactStoreUnavailable"
  | "ArtifactVersionCapExceeded"
  | "ArtifactKindMismatch"
  | "ArtifactCapExceeded"
  | "ArtifactSpecInvalid"
  | "ArtifactRedeclared"
  | "ArtifactUndeclared"
  | "ArtifactPrimaryConflict"
  | "NoUserInterface";

export interface WorkflowErrorMismatch {
  expected: string;
  got: string;
}

export interface WorkflowErrorJson {
  code: WorkflowErrorCode;
  message: string;
  violations?: Violation[];
  finalText?: string;
  mismatch?: WorkflowErrorMismatch;
  providerStop?: { provider: string; model?: string; message: string };
}

export interface ArtifactRef {
  id: string;
  version: number;
}

export interface ArtifactVersionRecord extends ArtifactRef {
  kind: ArtifactContentOp | ArtifactPresetOp;
  title?: string;
  description?: string;
  contentType?: string;
  bytes?: number;
  sha256?: string;
  uri?: string;
  sourcePath?: string;
  spec?: unknown;
  primary?: true;
  createdAt?: number;
}

export interface AskStats {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
}

export interface RunRecord {
  runId: string;
  workspaceKey?: string;
  cwd?: string;
  name?: string;
  parentSessionId?: string;
  toolCallId?: string;
  scriptPath?: string;
  scriptText?: string;
  scriptHash?: string;
  args?: Record<string, unknown>;
  caps: Caps;
  subagentModel?: string;
  spentTokens: number;
  currentPhase?: string;
  resumedFrom?: string;
  supersededBy?: string;
  status: RunStatus;
  stopReason?: RunStopReason;
  failure?: WorkflowErrorJson;
  result?: unknown;
  createdAt?: number;
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
  schemaVersion?: number;
}

export interface ActorRecord {
  runId: string;
  siteId: string;
  ordinal: number;
  name?: string;
  persona?: PersonaSpec;
  sessionId?: string;
  sessionPath?: string;
  resolvedModel?: string;
  sessionMessageCount?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface NodeRecord {
  runId: string;
  siteId: string;
  ordinal: number;
  kind: NodeKind;
  actorSiteId?: string;
  actorOrdinal?: number;
  actorSeq?: number;
  inputHash: string;
  input?: unknown;
  status: NodeRecordStatus;
  result?: unknown;
  error?: WorkflowErrorJson;
  stats?: AskStats;
  artifactId?: string;
  messageBoundary?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface RunSettlementRecord {
  stopReason?: RunStopReason;
  supersededBy?: string;
  failure?: WorkflowErrorJson;
  result?: unknown;
}

export interface ListEventsOptions {
  afterSequence?: number;
  limit?: number;
}

export interface StoredEvent {
  sequence: number;
  event: RunEvent;
  timeCreated?: number;
}

export interface JournalStorePort {
  createRun(record: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void;
  updateRunUsage(runId: string, spentTokens: number): void;
  putActor(record: ActorRecord): void;
  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined;
  listActors(runId: string): ActorRecord[];
  putNode(record: NodeRecord): void;
  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined;
  listNodes(runId: string): NodeRecord[];
  appendEvent(runId: string, event: RunEvent): StoredEvent;
  listEvents(runId: string, options?: ListEventsOptions): StoredEvent[];
}

export interface SessionRef {
  readonly id: string;
}

export type SubmitVerdict =
  | { kind: "accept"; value?: unknown; stats?: AskStats; messageBoundary?: number }
  | { kind: "reject"; violations: Violation[] }
  | { kind: "nudge" };

export interface ActorSessionSeed {
  sourceSessionId: string;
  messageCount: number;
  resolvedModel?: string;
}

export interface ArtifactPublishRequest {
  runId: string;
  siteId: string;
  ordinal: number;
  op: ArtifactContentOp;
  args: unknown[];
}

export interface WorkflowDriver {
  createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef>;
  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void;
  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void;
  cancelAsk(instance: InstanceRef): void;
  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown>;
  executeArtifactPublish?(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord>;
  journal: JournalStorePort;
  emit(event: RunEvent): void;
  dispose?(): void;
}

export interface WorkflowHostApi {
  createActor(siteId: string, name?: string, persona?: string | PersonaSpec): ActorId;
  ask(siteId: string, actor: ActorId, instructions: string): Promise<unknown>;
  worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown>;
  report(siteId: string, item: unknown, artifactId?: string): void;
  enterPhase(name: string): void;
  publishArtifact(siteId: string, op: ArtifactContentOp, args: unknown[]): Promise<ArtifactRef>;
  declareArtifact(siteId: string, op: ArtifactPresetOp, args: unknown[]): void;
  log(message: string): void;
}

export type RunEvent =
  | { type: "run-started"; runId: string; caps: Caps }
  | {
      type: "run-launched";
      inputId?: string;
      toolCallId?: string;
      parentSessionId?: string;
      phaseNames?: string[];
      subagentModel?: string;
      scriptPath?: string;
    }
  | { type: "actor-created"; actor: ActorRef; name?: string; persona?: PersonaSpec; phaseName?: string }
  | {
      type: "node-queued";
      instance: InstanceRef;
      kind: NodeKind;
      actor?: ActorRef;
      actorSeq?: number;
      phaseName?: string;
    }
  | { type: "node-dispatched"; instance: InstanceRef }
  | { type: "node-repairing"; instance: InstanceRef; attempt: number; violations: Violation[] }
  | { type: "node-nudged"; instance: InstanceRef }
  | { type: "node-settled"; instance: InstanceRef; outcome: NodeOutcome; cached?: boolean; error?: WorkflowErrorJson }
  | { type: "usage-updated"; spentTokens: number }
  | { type: "log"; message: string }
  | { type: "phase-entered"; name: string; ordinal: number }
  | { type: "report"; instance: InstanceRef; item: unknown; artifactId?: string }
  | { type: "artifact-published"; instance: InstanceRef; artifact: ArtifactVersionRecord }
  | { type: "artifact-failed"; instance: InstanceRef; id: string; op: ArtifactContentOp; error: WorkflowErrorJson }
  | { type: "escalation-requested"; qid: string; question: string; context?: string; askedAt: number }
  | { type: "escalation-resolved"; qid: string; answer: string }
  | { type: "run-settled"; status: RunStatus; stopReason?: RunStopReason; supersededBy?: string; error?: WorkflowErrorJson };
