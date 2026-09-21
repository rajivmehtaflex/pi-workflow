# Pi workflow compatibility fixtures

These fixtures pin the first published compatibility target for the extension.

| Surface | Pinned value |
| --- | --- |
| Node engine | `>=24.0.0` (repository toolchain: Node `24.14.0`) |
| pnpm | `10.33.2` |
| Pi coding agent | `@earendil-works/pi-coding-agent@0.86.0` |
| Extension entry | `function workflowExtension(pi: ExtensionAPI): void` |
| Pi JSON stream | `session`, `agent_start`, `turn_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, `agent_end` |
| Package discovery | `pi.extensions: ["./dist/index.js"]` |
| Workflow run statuses | `pending`, `running`, `completed`, `errored`, `stopped` |
| Workflow facade | Current ZCode `agent().ask<T>()`, `phase`, `report`, `files.*`, `git.*`, `world.run`, and `artifact.*` surface |

`message_end` is the authoritative assistant result. `message_update` is progress-only and
must never replace the final message. The fixtures intentionally contain no credentials,
workspace data, or provider addresses.
