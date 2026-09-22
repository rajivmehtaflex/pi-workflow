import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  spawnPiActorTurn,
  type ActorTurnSettlement,
  type SpawnPiActorTurnOptions,
} from "../runtime/pi-actor/process.js";
import { buildGenerationPrompt } from "./prompt.js";

export const MAX_GENERATION_OUTPUT_BYTES = 256 * 1024;
export const MAX_GENERATED_SOURCE_BYTES = 256 * 1024;
export const MAX_GENERATION_ARRAY_ITEMS = 64;
export const MAX_GENERATION_ITEM_BYTES = 8 * 1024;

export interface GenerationCandidate {
  source: string;
  assumptions: string[];
  acceptanceCriteria: string[];
}

export interface GenerationInput {
  requirements: string;
  context: string;
  previousSource?: string;
  diagnostics: string[];
  model?: string;
  thinking?: string;
}

export type GenerateCandidate = (
  input: GenerationInput,
  signal: AbortSignal,
) => Promise<GenerationCandidate>;

export type GenerationErrorCode =
  | "GenerationAborted"
  | "GenerationTimeout"
  | "GenerationProcess"
  | "GenerationOutputInvalid"
  | "GenerationOutputTooLarge";

export class GenerationError extends Error {
  constructor(
    readonly code: GenerationErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}

const GenerationCandidateSchema = Type.Object(
  {
    source: Type.String({ minLength: 1, maxLength: MAX_GENERATED_SOURCE_BYTES }),
    assumptions: Type.Array(Type.String({ maxLength: MAX_GENERATION_ITEM_BYTES }), {
      maxItems: MAX_GENERATION_ARRAY_ITEMS,
    }),
    acceptanceCriteria: Type.Array(Type.String({ maxLength: MAX_GENERATION_ITEM_BYTES }), {
      maxItems: MAX_GENERATION_ARRAY_ITEMS,
    }),
  },
  { additionalProperties: false },
);

function unwrapJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```json\s*\n([\s\S]*?)\n```$/i);
  if (fenced !== null) return fenced[1]!;
  if (trimmed.includes("```"))
    throw new GenerationError(
      "GenerationOutputInvalid",
      "Generation output must be plain JSON or one surrounding JSON code fence",
    );
  return trimmed;
}

function validationMessage(value: unknown): string {
  const first = [...Value.Errors(GenerationCandidateSchema, value)][0];
  if (first === undefined) return "Generation output does not match the candidate schema";
  const detail =
    first.message === "Unexpected property" ? "contains an additional property" : first.message;
  return `Generation output ${first.path || "$"} ${detail}`;
}

export function parseGenerationCandidate(text: string): GenerationCandidate {
  if (Buffer.byteLength(text, "utf8") > MAX_GENERATION_OUTPUT_BYTES)
    throw new GenerationError(
      "GenerationOutputTooLarge",
      `Generation output must be at most ${MAX_GENERATION_OUTPUT_BYTES / 1024} KiB`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJson(text));
  } catch {
    throw new GenerationError(
      "GenerationOutputInvalid",
      "Generation output must be plain JSON or one surrounding JSON code fence",
    );
  }
  if (!Value.Check(GenerationCandidateSchema, parsed))
    throw new GenerationError("GenerationOutputInvalid", validationMessage(parsed));
  const candidate = parsed as GenerationCandidate;
  if (Buffer.byteLength(candidate.source, "utf8") > MAX_GENERATED_SOURCE_BYTES)
    throw new GenerationError(
      "GenerationOutputTooLarge",
      `Generated source must be at most ${MAX_GENERATED_SOURCE_BYTES / 1024} KiB`,
    );
  return candidate;
}

export interface PiGeneratorOptions {
  cwd: string;
  sessionPath?: string | ((input: GenerationInput) => string);
  runningScript?: string;
  executable?: string;
  timeoutMs?: number;
  spawn?: (options: SpawnPiActorTurnOptions) => Promise<ActorTurnSettlement>;
}

function generationSessionPath(options: PiGeneratorOptions, input: GenerationInput): string {
  if (typeof options.sessionPath === "function") return options.sessionPath(input);
  return options.sessionPath ?? join(options.cwd, ".pi", "workflow-requests", "generation.jsonl");
}

function processError(
  result: Extract<ActorTurnSettlement, { status: "errored" }>,
): GenerationError {
  if (result.error.code === "LineTooLarge" || result.error.code === "StderrTooLarge")
    return new GenerationError("GenerationOutputTooLarge", result.error.message, result.error);
  return new GenerationError("GenerationProcess", result.error.message, result.error);
}

export function createPiGenerator(options: PiGeneratorOptions): GenerateCandidate {
  const spawn = options.spawn ?? spawnPiActorTurn;
  return async (input, signal) => {
    const result = await spawn({
      cwd: options.cwd,
      runningScript: options.runningScript,
      fallbackExecutable: options.executable,
      sessionPath: generationSessionPath(options, input),
      prompt: buildGenerationPrompt(input),
      model: input.model,
      thinking: input.thinking,
      profile: "generation",
      signal,
      timeoutMs: options.timeoutMs ?? 180_000,
      maxLineBytes: MAX_GENERATION_OUTPUT_BYTES,
      maxStderrBytes: 64 * 1024,
    });
    if (result.status === "stopped") {
      if (result.error?.code === "Timeout")
        throw new GenerationError("GenerationTimeout", result.error.message, result.error);
      throw new GenerationError(
        result.error?.code === "Aborted" ? "GenerationAborted" : "GenerationProcess",
        result.error?.message ?? `Generation stopped: ${result.stopReason}`,
        result.error,
      );
    }
    if (result.status === "errored") throw processError(result);
    if (result.text === undefined)
      throw new GenerationError("GenerationOutputInvalid", "Generation returned no text");
    return parseGenerationCandidate(result.text);
  };
}
