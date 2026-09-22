# Requirements Workflow Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Accept plain requirements and automatically generate, validate, repair, execute,
and report a durable workflow without asking the user to author TypeScript.

**Architecture:** A requirements coordinator owns generation and request state. Existing
WorkflowRunService remains the sole owner of execution and run state. SQLite links both
lifecycles, with one transaction admitting a request's workflow exactly once.

**Tech Stack:** TypeScript, existing Pi CLI process adapter, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-22-requirements-workflow-design.md`

Status: proposed; implementation has not started. All tasks below are pending.

## Global constraints

- Node 24; preserve current dependency policy; no new provider SDK.
- Three generator calls per request, 180-second total generation deadline.
- Requirements <=32 KiB UTF-8; generation output <=256 KiB; concurrency 1..16, default 2.
- Automatic execution by default; preview explicitly requested.
- Existing command semantics remain intact; generation never executes workspace tools.
- No automatic replay of failed execution; no ZCode mirror synchronization in this scope.

## Review focus

- Unicode requirements and literal quotes/options: byte limits and lossless parsing (tasks 1, 5).
- Invalid or fenced model JSON: explicit diagnostics and bounded repair (tasks 2, 3).
- Stop racing with valid generation: no post-cancellation admission (tasks 3, 4).
- Crash between admission and launch: one persisted run, explicit recovery (tasks 1, 4).
- Long runs and restart after settlement: durable result and deduplicated notifications (task 5).

## Task 1: Persist requests and admission identity

Files: create `src/requirements/types.ts`, `src/requirements/repository.ts`,
`tests/requirements-storage.test.ts`; modify `src/storage/migrations.ts`.

Interfaces:
```ts
type RequestState = "queued" | "generating" | "validating" | "repairing" |
  "ready" | "launching" | "running" | "completed" | "failed" | "stopped";
interface RequirementsInput {
  requirements: string;
  preview?: boolean;
  model?: string;
  thinking?: string;
  maxConcurrency?: number;
  requestId?: string;
}
interface RequirementsRequest {
  requestId: string;
  workspaceKey: string;
  input: RequirementsInput;
  state: RequestState;
  attempts: number;
  source?: string;
  runId?: string;
  diagnostics: string[];
  assumptions: string[];
  acceptanceCriteria: string[];
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
  notificationDelivered: boolean;
}
```

- [ ] Write SQLite tests: migrate version 1 without losing runs; persist/reopen requests;
  reject a duplicate requestId with different input; return the same request for identical
  input; reject workspace mismatch. Assert rollback leaves no linked run on admission error.
- [ ] Run `pnpm exec vitest run tests/requirements-storage.test.ts`; confirm missing behavior.
- [ ] Add migration version 2 with `workflow_requests` and `workflow_request_attempts`;
  request primary key, workspace index, unique nullable runId FK, attempt composite key.
  Store options and diagnostics as JSON, source separately. Repository methods:
  `create(input, workspaceKey): RequirementsRequest`, `get(id): RequirementsRequest`,
  `transition(id, expectedState, patch): RequirementsRequest`,
  `recordAttempt(id, attempt, source, diagnostics): void`, `list(workspaceKey)`.
  State transitions use compare-and-set updates and reject stale writes.
- [ ] Pass migration, duplicate-input, and UTF-8 limit tests; commit this task.

## Task 2: Generate a candidate using the existing Pi transport

Files: create `src/requirements/generator.ts`, `src/requirements/prompt.ts`,
`tests/requirements-generator.test.ts`, `tests/fixtures/fake-pi-generator.mjs`;
modify `src/runtime/pi-actor/invocation.ts`, `src/runtime/pi-actor/process.ts` only where
needed to provide an opt-in generation profile. Preserve actor invocation defaults.

Interface:
```ts
interface GenerationCandidate {
  source: string;
  assumptions: string[];
  acceptanceCriteria: string[];
}
interface GenerationInput {
  requirements: string;
  context: string;
  previousSource?: string;
  diagnostics: string[];
  model?: string;
  thinking?: string;
}
type GenerateCandidate = (
  input: GenerationInput, signal: AbortSignal
) => Promise<GenerationCandidate>;
```

- [ ] Add subprocess fixtures returning valid envelopes, malformed JSON, oversized output,
  missing source, provider error, and a hanging process. Assert exact candidate contents
  and termination on abort; assert the generation invocation disables tools and extension
  discovery while ordinary actor invocations preserve their existing options.
- [ ] Run `pnpm exec vitest run tests/requirements-generator.test.ts tests/actor-driver.test.ts`.
- [ ] Implement envelope parsing with TypeBox and no additional properties. Allow exactly
  one surrounding JSON code fence or plain JSON; reject mixed prose. Bound strings and
  arrays before building the prompt. Build generation context from tracked paths and git
  status with a 16 KiB cap, with an empty fallback outside a Git repository. Prompt includes
  supported DSL and a compiler-tested sequential example that passes the first actor's
  findings into the second actor's request. Use the active host executable when available.
- [ ] Apply explicit no-tools/no-extensions/no-skills/no-prompt-templates options supported
  by the installed Pi CLIs; pass arguments as arrays with shell false. Propagate cancellation
  and existing Pi credential configuration. Test invocation and output, then commit.

## Task 3: Coordinate generation, validation, and repair

Files: create `src/requirements/coordinator.ts`, `tests/requirements-coordinator.test.ts`.

Interfaces: consume GenerateCandidate and repository from tasks 1/2 plus
`WorkflowRunService.validate(source)`. Produce `start(input): RequirementsRequest`,
`get(requestId): RequirementsRequest`, `stop(requestId): Promise<void>`,
`resume(requestId): Promise<RequirementsRequest>`, and `dispose(): Promise<void>`.
Inject generation and clock for deterministic tests; launch is supplied by task 4.

- [ ] Write tests with real compiler: valid first candidate; invalid candidate followed by
  corrected candidate; three invalid candidates; preview produces ready and zero runs;
  generator rejection persists failure; stop during generation never calls launch.
  Minimal valid compiler fixture: `phase("Check"); return { ok: true };`.
  Use counters only at the external generator/launch boundaries, and assert persisted
  source, diagnostics, state, and generated results, not just call counts.
- [ ] Run `pnpm exec vitest run tests/requirements-coordinator.test.ts` and observe failures.
- [ ] Implement the loop: persist generating and increment attempt; await candidate under
  remaining deadline; validate; persist attempt and diagnostics; repair within budget;
  on success export source and transition to ready or launch. Check abort after every
  await and immediately before launch. A resumed request keeps attempts already consumed.
- [ ] Verify exhausted repairs never create a run; Unicode input limits, timeout, duplicate
  start, and stopped-request recovery behave as specified. Commit this task.

## Task 4: Admit one run and recover interrupted requests

Files: modify `src/service/run-service.ts`, `src/requirements/repository.ts`,
`src/requirements/coordinator.ts`; create `tests/requirements-admission.test.ts`.

Interface: add `createWorkflowForRequest(requestId: string, input: CreateWorkflowInput)`
returning the existing `AcceptedWorkflowRun`. It uses the same database connection as
request persistence, checks workspace and request state, and rejects cancelled requests.
Expose this method through the service interface and lazy forwarding in `src/index.ts`.

- [ ] Test two admissions for one request yield one persisted run; rollback does not leave
  a run or link; stopped requests cannot launch; crash recovery preserves the existing
  runId. Use real SQLite and the existing fake actor transport.
- [ ] Run `pnpm exec vitest run tests/requirements-admission.test.ts tests/service-resume.test.ts`.
- [ ] Extract run admission from current createWorkflow only as needed: compile, create run,
  journal admission, and link request in one synchronous transaction; launch after commit.
  Repeated admission returns existing linked run rather than launching a second child.
  Keep the original createWorkflow path behavior unchanged.
- [ ] Reconcile request states against existing run states on session start. Mark unfinished
  generation stopped; linked interrupted execution requires explicit resume. Stop propagates
  to generation or stopRun depending on current state. Commit after passing recovery tests.

## Task 5: Expose the automatic flow and report results

Files: modify `src/commands/workflow-command.ts`, `src/index.ts`, `src/tools/schemas.ts`,
`src/tools/workflow-tools.ts`, `src/ui/progress-widget.ts`; create
`src/requirements/notifications.ts`, `tests/requirements-surface.test.ts`.

- [ ] Test `/workflow auto` with spaces, embedded JSON, multiline requirements, and `--`;
  empty text returns helpful usage. Test the new tool and request-prefixed status/stop/resume.
  Keep tests for existing `/workflow run <path>` and saved workflows green.
- [ ] Run `pnpm exec vitest run tests/requirements-surface.test.ts tests/commands.test.ts tests/extension-smoke.test.ts`.
- [ ] Register create_workflow_from_requirements with the task 1 input schema. Return a
  requestId immediately and let coordinator work continue in the session. Add command
  parsing before existing tokenization so free text stays intact. Initialize/dispose the
  coordinator alongside the run service; use the same SQLite connection.
- [ ] Show generating, repairing, running, and terminal states. Observe settlement without
  the existing fixed five-minute cutoff; persist final result projection. Send a bounded
  message with requestId, runId, result/error, assumptions, and verification limitations.
  Use Pi's actual message shape and optional callbacks from installed host definitions.
  Test a long run with a fake clock and restart after settlement; notification recovery
  must not launch work again. Commit this task.

## Task 6: Verify requirements-to-result and document installation

Files: create `tests/requirements-e2e.test.ts`; update `README.md`.

- [ ] Add a provider-free integration case using the real compiler, SQLite, coordinator,
  and fake generator/actor subprocesses. Requirements produce invalid then valid source,
  one durable workflow completes, and status includes its result. Reopen database and
  check the persisted request/run link. Add preview and mid-generation cancellation cases.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm fmt:check`.
- [ ] Verify a fresh disposable source checkout using `npm install --omit=dev`; load its
  generated dist with the available Pi 0.86/0.87 hosts. Confirm tool registration and
  command handling in an isolated PI_CODING_AGENT_DIR. Do not reuse developer node_modules.
- [ ] If provider credentials are available, run one small requirements-to-result smoke
  and record provider/model, requestId, generated source, terminal result, and diagnostics.
  Otherwise explicitly record that live provider validation remains unverified.
- [ ] Document a single prompt and `/workflow auto` example, optional preview, status,
  cancellation, retry limits, result interpretation, and recovery. Commit verified changes.

## Execution order and review

Execute tasks 1 through 6 in order; storage/admission/coordinator interfaces are coupled.
Native execution is recommended for this scope, followed by a complete diff review.
The design and plan are review artifacts; creating them does not implement the feature.
