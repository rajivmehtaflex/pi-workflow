# Requirements to automatic workflow

Status: implemented and verified in the standalone `pi-workflow` repository. Provider-free
generation, compilation, execution, persistence, recovery, and Pi 0.87 loading are covered;
provider-backed live validation remains unverified without credentials.

## Intent

The user supplies requirements in Pi and receives a completed workflow result without
writing TypeScript, choosing a file path, or manually issuing validation commands.
Generation, compiler repair, persistence, execution, progress, and final reporting are
owned by the extension. A valid workflow starts automatically; preview is optional.

## Evidence and correction

`src/tools/workflow-tools.ts` already accepts inline source through `create_workflow`
and validates snippets through `eval_workflow_snippet`. Pi can compose these tools today;
the earlier claim that a manual TypeScript file is required was too strong. Reliable
requirements orchestration is still missing.

`src/service/run-service.ts` owns validation, execution, resume, and durable run state.
`src/runtime/pi-actor/process.ts` supplies cancellable Pi child execution and structured
results. `src/runtime/pi-actor/invocation.ts` currently disables extensions but does not
disable built-in tools. `src/tools/workflow-tools.ts` polls completion for a fixed period;
this is insufficient for durable automatic requests that may outlive a session.
`src/storage/migrations.ts` currently defines schema version 1.

CodeGraph MCP was unavailable in this session. The CLI was attempted but failed with
missing `commander`; these findings use current source reads, not successful graph results.

## Alternatives

1. Prompt template: small change; the conversation model coordinates existing tools,
   but progress, retries, and restart behavior are not reliably owned by the extension.
2. Durable coordinator above the engine: recommended. One request record connects
   bounded generation to the existing workflow run and preserves recovery information.
3. Separate autonomous engine: unnecessary duplication of scheduling, persistence,
   cancellation, and resume.

## User experience

```text
/workflow auto Review changed files, identify bugs, and produce an action plan.
/workflow auto --preview -- Review changed files and summarize risks.
/workflow status request:<id>
/workflow stop request:<id>
/workflow resume request:<id>
```

`auto` treats text after `--` as literal requirements. Without `--`, only recognized
leading options are parsed; the remaining text is preserved, including quotes and JSON.
Existing commands retain their meaning. Bare `/workflow` continues to show help.

Register `create_workflow_from_requirements` with requirements, preview, model,
thinking, maxConcurrency, and optional requestId. Pi receives a concise usage description
so a natural-language request such as “Use a workflow to review this project” can invoke
the tool. Tool selection by the chat model is not guaranteed; the slash command is the
deterministic entry point. Arbitrary chat messages are not intercepted.

No manual file is needed. Store generated source in SQLite and export the accepted
source to `.pi/workflow-requests/<requestId>/workflow.ts` for inspection. This path is
chosen by the coordinator, never by model output.

## Coordinator contract

Create a request before any provider work. State transitions are:
`queued -> generating -> validating -> repairing -> validating -> launching -> running`
with terminal `completed`, `failed`, or `stopped`. `validating -> ready` is the preview
branch; resuming a ready request launches its accepted source. At most three generator
calls are permitted per request: one initial attempt plus two repairs. The total
generation deadline is 180 seconds, individual output is capped at 256 KiB, and
requirements at 32 KiB UTF-8. Reject empty requirements and concurrency outside 1..16.
Defaults: preview false, maxConcurrency 2. Expose limits in configuration and status.

Persist requestId, workspaceKey, requirements, options, state, attempts, source,
diagnostics, assumptions, acceptance criteria, runId, timestamps, and terminal error.
Persist each attempt before continuing. Model selection uses an explicit override,
otherwise the active Pi model when available, otherwise the child's configured default;
show the resolved selection. Credentials use Pi's existing configuration.

The generator returns a bounded JSON envelope with source, assumptions, and acceptance
criteria. Parse and validate it as data. Supply workflow DSL documentation and tested
examples from this package, plus requirements and bounded context. Context initially
contains cwd, a bounded tracked-file listing, and git status; it excludes file contents
unless explicitly provided in requirements. Treat workspace text as data. Generation
uses no built-in tools, extensions, skills, or prompt templates and cannot edit files.
Verify the relevant flags on the installed Pi versions during implementation.

Compile every candidate using `WorkflowRunService.validate`. On invalid JSON or compiler
diagnostics, send the previous candidate and bounded diagnostics for the next attempt.
No workflow launches before validation succeeds. Compilation checks DSL validity, not
whether the user's business requirement has been achieved.

On success, launch via the existing run service with inline source and retain the runId.
The durable request-to-run link and run admission must be one database transaction,
followed by process launch after commit. A unique requestId prevents duplicate admission.
If a process dies after admission, reconcile that run as interrupted and use existing
explicit resume behavior; never generate and launch a replacement automatically.

Observe run settlement until terminal or session shutdown. Persist terminal projection
and notification state; on restart report pending terminal results once using a stable
request/event identity where the host supports it. Do not promise exactly-once UI delivery
across a crash between display and persistence. Successful engine completion and verified
acceptance criteria are distinct: report result and remaining/unverified criteria.

## Cancellation and recovery

Stopping a generation request aborts its child and forbids later admission. Stopping an
executing request calls the existing stopRun. Shutdown stops active work and flushes state.
On startup, queued/generating/repairing requests become stopped with an interruption
reason; no automatic provider call occurs. Resume consumes the remaining generation
attempt budget or reports exhaustion. Resume of a linked run delegates to existing resume.
Missing credentials, timeout, invalid output, exhausted repair, and execution failures
must be visible in request status with the latest diagnostics.

Execution retains the existing engine's capabilities. Compiler repair does not imply
automatic retry of failed actions; already executed changes may remain after failure.
Ask a clarification only when essential input is missing; record reasonable assumptions.

## Scope and verification

Implement in the standalone `pi-workflow` repository. Do not synchronize the previously
deferred ZCode copy as part of this change. Keep source workflows and saved workflows
working. Retain Node 24 and the current dependency policy. No new provider SDK is needed.

Test real compiler validation, SQLite persistence, fake Pi subprocess generation,
three-attempt exhaustion, cancellation races, duplicate request admission, preview,
restart reconciliation, and final reporting. Verify clean Git installation with dev
dependencies omitted and both locally available Pi 0.86/0.87 hosts. A provider-backed
requirements-to-result test is a separate evidence level; mark it unverified if credentials
are unavailable. Do not describe fake-process tests as live model verification.
