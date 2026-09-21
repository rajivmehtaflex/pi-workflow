/**
 * Public module manifest for the Pi workflow extension.
 * Mutable run state belongs to the run service; all other surfaces are adapters.
 */
export const piWorkflowModule = {
  id: "pi-workflow",
  requires: [],
  provides: ["pi-workflow-extension", "workflow-run-service"],
  publicEntrypoints: ["contract.ts"],
} as const;
