# Pi Workflow Extension

This package provides a deterministic `/workflow` command and the ZCode dynamic-workflow
tool family for Pi `0.86.x`.

## Installation and trust

Install the package through Pi's package mechanism or load the compiled extension with
`pi -e ./dist/index.js`. Pi extensions have full process and filesystem permissions. Only
enable a project-local extension or workflow source after reviewing and trusting that
project. The workflow compiler allowlist and the Boundary-A child process are additional
execution boundaries; they are not a replacement for package trust.

## Command surface

```text
/workflow run <path|project:name|global:name> [--args <json>] [--model <provider/model[:thinking]>] [--max-concurrency <n>]
/workflow validate <path|project:name|global:name>
/workflow list [--limit <n>]
/workflow status [<runId>]
/workflow resume <runId>
/workflow stop [<runId>]
```

`/workflow cancel` is accepted as an explicit alias for `stop`.

## Runtime policy

The parent run service owns admission, state transitions, settlement, resume, and escalation.
The workflow script runs in Boundary A and each actor runs in a separate Boundary-B Pi JSON
process with `shell:false`, an explicit cwd, `--no-extensions`, bounded output, and a
run-scoped session file.

Durable state is stored in `<workspace>/.pi/workflows.db`; generated entries, actor sessions,
and artifacts live beneath `<workspace>/.pi/workflow-runs/` and are ignored by the target
workspace. A missing provider credential prevents only live-Agent verification; fake-Pi tests
cover the process protocol without credentials.

## Manual Pi smoke

From a disposable target workspace, build this package and run the deterministic
no-network validation fixture through the pinned Pi executable:

```bash
pnpm build
pi --version
pi --extension ./dist/index.js --mode json \
  -p '/workflow validate tests/fixtures/workflows/typed-review.ts'
```

The smoke should create `.pi/workflows.db` only in the target workspace. Provider
credentials are not required for validation, command registration, or fake-Pi tests.

## Auto-commit and push

This repository includes a 2-minute runner that automatically stages, commits, and pushes changes to GitHub:

```bash
npm run auto-commit:start   # Start background daemon
npm run auto-commit:status  # Check daemon status
npm run auto-commit:stop    # Stop background daemon
bash scripts/auto-commit.sh once # Run single commit and push cycle
```
