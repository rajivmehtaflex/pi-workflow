import type { CompileDiagnostic } from "../compiler/compile.js";

export type SiteKind = "ask" | "world-read" | "world-run" | "report" | "artifact";

export interface ActorProjection {
  siteId: string;
  name?: string;
  persona?: string | { system?: string };
}

export interface SiteProjection {
  siteId: string;
  kind: SiteKind;
  op?: string;
  actorSiteId?: string;
  actorName?: string;
  actorSeq?: number;
  artifactId?: string;
  artifactKind?: string;
}

export interface PhaseProjection {
  id: string;
  name: string;
  ordinal: number;
  siteIds: string[];
}

export interface WorkflowGraph {
  actors: ActorProjection[];
  sites: SiteProjection[];
  phases: PhaseProjection[];
}

export interface CausalityGraph {
  phases: PhaseProjection[];
  edges: Array<{ from: string; to: string }>;
}

export interface DeclaredArtifact {
  id: string;
  kind: string;
}

export interface AnalyzeResult {
  diagnostics: CompileDiagnostic[];
  ok: boolean;
  graph?: WorkflowGraph;
  causality?: CausalityGraph;
  declaredArtifacts: DeclaredArtifact[];
  sourceText?: string;
}
