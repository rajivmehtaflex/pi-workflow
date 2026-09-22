import { Type } from "@sinclair/typebox";

const SavedReferenceSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 256 }),
  Type.Object(
    {
      scope: Type.Union([Type.Literal("project"), Type.Literal("global")]),
      name: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
  ),
]);

const CommonCreateFields = {
  args: Type.Optional(Type.Record(Type.String({ maxLength: 128 }), Type.Unknown())),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
};

export const WorkflowSourceSchema = Type.Union([
  Type.Object(
    { script: Type.String({ minLength: 1, maxLength: 1024 * 1024 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { path: Type.String({ minLength: 1, maxLength: 1024 }) },
    { additionalProperties: false },
  ),
  Type.Object({ saved: SavedReferenceSchema }, { additionalProperties: false }),
]);

export const CreateWorkflowSchema = Type.Union([
  Type.Object(
    { script: Type.String({ minLength: 1, maxLength: 1024 * 1024 }), ...CommonCreateFields },
    { additionalProperties: false },
  ),
  Type.Object(
    { path: Type.String({ minLength: 1, maxLength: 1024 }), ...CommonCreateFields },
    { additionalProperties: false },
  ),
  Type.Object(
    { saved: SavedReferenceSchema, ...CommonCreateFields },
    { additionalProperties: false },
  ),
]);

export const AmendWorkflowSchema = Type.Union([
  Type.Object(
    {
      runId: Type.String({ minLength: 1, maxLength: 256 }),
      script: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
      ...CommonCreateFields,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String({ minLength: 1, maxLength: 256 }),
      path: Type.String({ minLength: 1, maxLength: 1024 }),
      ...CommonCreateFields,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String({ minLength: 1, maxLength: 256 }),
      saved: SavedReferenceSchema,
      ...CommonCreateFields,
    },
    { additionalProperties: false },
  ),
]);

export const GetWorkflowRunSchema = Type.Object(
  { runId: Type.String({ minLength: 1, maxLength: 256 }) },
  { additionalProperties: false },
);

export const ListWorkflowRunsSchema = Type.Object(
  { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) },
  { additionalProperties: false },
);

export const EvalWorkflowSnippetSchema = Type.Object(
  { script: Type.String({ minLength: 1, maxLength: 256 * 1024 }) },
  { additionalProperties: false },
);

export const ResumeWorkflowRunSchema = GetWorkflowRunSchema;

export const SaveWorkflowSchema = Type.Object(
  {
    scope: Type.Union([Type.Literal("project"), Type.Literal("global")]),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    sourceText: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
    argsSchema: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ListSavedWorkflowsSchema = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")])),
  },
  { additionalProperties: false },
);

export const ResolveWorkflowQuestionSchema = Type.Object(
  {
    qid: Type.String({ minLength: 1, maxLength: 256 }),
    answer: Type.String({ maxLength: 64 * 1024 }),
  },
  { additionalProperties: false },
);

export const workflowToolSchemas = {
  create_workflow: CreateWorkflowSchema,
  amend_workflow: AmendWorkflowSchema,
  get_workflow_run: GetWorkflowRunSchema,
  list_workflow_runs: ListWorkflowRunsSchema,
  eval_workflow_snippet: EvalWorkflowSnippetSchema,
  resume_workflow_run: ResumeWorkflowRunSchema,
  save_workflow: SaveWorkflowSchema,
  list_saved_workflows: ListSavedWorkflowsSchema,
  resolve_workflow_question: ResolveWorkflowQuestionSchema,
} as const;
