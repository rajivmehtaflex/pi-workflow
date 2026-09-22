export type RequestState =
  | "queued"
  | "generating"
  | "validating"
  | "repairing"
  | "ready"
  | "launching"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export interface RequirementsInput {
  requirements: string;
  preview?: boolean;
  model?: string;
  thinking?: string;
  maxConcurrency?: number;
  requestId?: string;
}

export interface RequirementsRequestError {
  code: string;
  message: string;
}

export interface RequirementsRequest {
  requestId: string;
  workspaceKey: string;
  input: RequirementsInput;
  state: RequestState;
  attempts: number;
  source?: string;
  runId?: string;
  diagnostics: string[];
  assumptions: string[];
  acceptanceCriteria: string[];
  error?: RequirementsRequestError;
  createdAt: number;
  updatedAt: number;
  notificationDelivered: boolean;
}

export interface RequirementsRequestPatch {
  state?: RequestState;
  attempts?: number;
  source?: string | null;
  runId?: string | null;
  diagnostics?: string[];
  assumptions?: string[];
  acceptanceCriteria?: string[];
  error?: RequirementsRequestError | null;
  notificationDelivered?: boolean;
}

export interface RequirementsAttempt {
  requestId: string;
  attempt: number;
  source: string;
  diagnostics: string[];
  createdAt: number;
}
