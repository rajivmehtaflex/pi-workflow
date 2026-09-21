/**
 * The package boundary. Runtime details stay behind this entrypoint so a Pi host
 * consumes registration and run contracts without importing storage/process code.
 */
export interface WorkflowExtensionContract {
  readonly name: "pi-workflow";
}
