import type { EscalationQuestion } from "./escalation-registry.js";

export interface PiEscalationUi {
  input?(prompt: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  select?(
    prompt: string,
    options: string[],
    optionsConfig?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  confirm?(prompt: string, options?: { signal?: AbortSignal }): Promise<boolean>;
}

export interface PiEscalationContext {
  hasUI?: boolean;
  ui?: PiEscalationUi;
}

export function createPiEscalationAsk(
  context: PiEscalationContext,
): (question: EscalationQuestion, signal?: AbortSignal) => Promise<string | undefined> {
  return async (question, signal) => {
    if (context.hasUI !== true || context.ui === undefined) return undefined;
    if (context.ui.input !== undefined) return context.ui.input(question.question, { signal });
    if (context.ui.confirm !== undefined)
      return (await context.ui.confirm(question.question, { signal })) ? "yes" : "no";
    if (context.ui.select !== undefined)
      return context.ui.select(question.question, ["yes", "no"], { signal });
    return undefined;
  };
}
