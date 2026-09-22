# Pi Workflow Extension

This package adds a durable `/workflow` command and workflow tools to Pi. A workflow is
compiled by the ZCode-compatible engine, persisted in SQLite, and executed with bounded
child Pi processes.

The repository is distributed as source. The package's `prepare` lifecycle builds
`dist/` automatically when Pi installs it from GitHub; source development still requires
an explicit build.

## Requirements

- Node.js 24.x
- Corepack with pnpm 10.33.2
- Pi 0.86.0 or newer
- A provider credential for live model-backed workflow runs

Validation, listing, snippet evaluation, and the fake-Pi tests do not require a provider
credential.

## Install directly from GitHub

Pi can install the extension directly from the repository. The install lifecycle builds
the compiled extension before Pi registers it:

```bash
pi install https://github.com/rajivmehtaflex/pi-workflow.git --approve
pi list --approve
```

To keep the installation project-local instead of user-global, add `--local`:

```bash
pi install https://github.com/rajivmehtaflex/pi-workflow.git --local --approve
pi list --approve
```

Run `pi list` from the project where a project-local package was installed. Pi does not
search child directories for package settings.

## Install from source

Clone and build the extension:

```bash
git clone https://github.com/rajivmehtaflex/pi-workflow.git
cd pi-workflow
corepack pnpm@10.33.2 install --frozen-lockfile
corepack pnpm@10.33.2 build
```

The locked dependencies provide a compatible local Pi executable at
`node_modules/.bin/pi`. Check it with:

```bash
./node_modules/.bin/pi --version
```

### Register the extension for this project

This adds the extension to the current project's Pi settings:

```bash
./node_modules/.bin/pi install . --local --approve
./node_modules/.bin/pi list --approve
```

Project-local packages are discovered from the project where they are installed. Run
these commands from the `pi-workflow` directory; `pi list` from a parent directory does
not search child projects.

### Load it once without installing

For a one-off run, load the compiled extension explicitly:

```bash
./node_modules/.bin/pi --approve --extension ./dist/index.js
```

The short form is also supported:

```bash
./node_modules/.bin/pi --approve -e ./dist/index.js
```

To use a different workflow workspace, start Pi from that workspace and pass the absolute
extension path. This keeps `.pi/workflows.db` in the intended workspace:

```bash
cd /path/to/your/workflow-workspace
/path/to/pi-workflow/node_modules/.bin/pi \
  --approve \
  --extension /path/to/pi-workflow/dist/index.js
```

## First smoke check

From the repository root, validate the included fixture without network access or a
provider credential:

```bash
./node_modules/.bin/pi \
  --approve \
  --offline \
  --no-session \
  --extension ./dist/index.js \
  --print \
  -- '/workflow validate tests/fixtures/workflows/typed-review.ts'
```

The command should report that the workflow is valid and create the workspace-local
`.pi/workflows.db`.

## Slash commands

The extension registers the `/workflow` command with these actions:

```text
/workflow run <path|project:name|global:name> [--args <json>] [--model <provider/model[:thinking]>] [--max-concurrency <n>]
/workflow validate <path|project:name|global:name>
/workflow list [--limit <n>]
/workflow status [<runId>]
/workflow resume <runId>
/workflow stop [<runId>]
```

Examples:

```text
/workflow validate workflows/review.ts
/workflow list --limit 10
/workflow run workflows/review.ts --args {"topic":"release"} --max-concurrency 2
/workflow status
/workflow stop 01J...RUN_ID
```

`/workflow cancel` is an alias for `/workflow stop`. A live `/workflow run` launches
model-backed actors, so Pi must have a configured provider credential. The `--model` value
may be a provider/model identifier with an optional thinking level, for example
`provider/model:low`.

Saved workflows can be addressed as `project:name` or `global:name`:

```text
/workflow run project:release-review
/workflow validate global:shared-check
```

## Registered Pi tools

Pi exposes these tools to the model. Tool calls use JSON arguments; the examples below
show the argument payload for each tool.

| Tool                        | Example arguments                                                               |
| --------------------------- | ------------------------------------------------------------------------------- |
| `create_workflow`           | `{"path":"workflows/review.ts","maxConcurrency":2}`                             |
| `amend_workflow`            | `{"runId":"01J...RUN_ID","path":"workflows/review-v2.ts"}`                      |
| `get_workflow_run`          | `{"runId":"01J...RUN_ID"}`                                                      |
| `list_workflow_runs`        | `{"limit":10}`                                                                  |
| `eval_workflow_snippet`     | `{"script":"phase(\"Check\"); return { ok: true };"}`                           |
| `resume_workflow_run`       | `{"runId":"01J...RUN_ID"}`                                                      |
| `save_workflow`             | `{"scope":"project","name":"release-review","sourceText":"phase(\"Review\");"}` |
| `list_saved_workflows`      | `{"scope":"project"}`                                                           |
| `resolve_workflow_question` | `{"qid":"question-id","answer":"yes"}`                                          |

For example, ask Pi to “evaluate this workflow snippet” and it can use
`eval_workflow_snippet`; ask it to “start the review workflow from
`workflows/review.ts`” and it can use `create_workflow`.

## Runtime and state

The parent run service owns admission, state transitions, settlement, resume, and
escalation. Workflow scripts run in Boundary A. Each actor runs in a separate Boundary-B
Pi JSON process with `shell:false`, an explicit cwd, `--no-extensions`, bounded output,
and a run-scoped session file.

Durable state is stored in `<workspace>/.pi/workflows.db`. Generated workflow-run data,
actor sessions, and artifacts live beneath `<workspace>/.pi/workflow-runs/`.

## Pi version note

The extension uses a structural Pi host boundary and keeps optional UI and renderer hooks
optional. The package metadata accepts Pi host packages `>=0.86.0` without an artificial
upper bound, so Pi 0.87 and later hosts can install it. A future host that removes one of
the required extension APIs would still require an adapter change.

## Development checks

```bash
corepack pnpm@10.33.2 typecheck
corepack pnpm@10.33.2 test
corepack pnpm@10.33.2 build
corepack pnpm@10.33.2 fmt:check
```

## Auto-commit helper

This repository includes a two-minute runner that automatically stages, commits, and
pushes changes to GitHub:

```bash
npm run auto-commit:start   # Start background daemon
npm run auto-commit:status  # Check daemon status
npm run auto-commit:stop    # Stop daemon
bash scripts/auto-commit.sh once # Run one commit and push cycle
```
