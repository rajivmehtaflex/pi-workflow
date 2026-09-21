# Pi workflow module contract

- The parent `WorkflowRunService` is the only owner of accepted runs, transitions,
  settlement, resume, stop, and escalation admission.
- The compiler and Boundary-A child never receive a database handle or Pi UI context.
- Boundary-B actor processes use one session path per `(workspaceKey, runId, actorRef)`.
- Commands, tools, widgets, and completion messages are projections/adapters; they do not
  maintain a second queue or terminal-state path.
- SQLite journal sequences are the durable cursor. Late child events are ignored after the
  run's first terminal settlement.
