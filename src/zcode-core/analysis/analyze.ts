import ts from "typescript";
import { collectDiagnostics, createWorkflowProgram } from "../compiler/compile.js";
import type { CompileDiagnostic } from "../compiler/compile.js";
import type {
  ActorProjection,
  DeclaredArtifact,
  PhaseProjection,
  SiteKind,
  SiteProjection,
  WorkflowGraph,
} from "./types.js";
import type { AnalyzeResult } from "./types.js";

interface CallFact {
  node: ts.CallExpression;
  position: number;
  kind: "phase" | "actor" | "site" | "report";
  name?: string;
  op?: string;
  siteKind?: SiteKind;
  actorSiteId?: string;
  artifactId?: string;
  artifactKind?: string;
}

const literalString = (value: ts.Expression | undefined): string | undefined =>
  value !== undefined && ts.isStringLiteral(value) ? value.text : undefined;

function propertyChain(expression: ts.Expression): { root: string; property: string } | undefined {
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const root = expression.expression;
  return ts.isIdentifier(root)
    ? { root: root.text, property: expression.name.text }
    : undefined;
}

function isReportPayloadUnsafe(expression: ts.Expression | undefined): boolean {
  if (expression === undefined) return true;
  let unsafe = false;
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) unsafe = true;
    if (ts.isNewExpression(node)) unsafe = true;
    if (!unsafe) ts.forEachChild(node, visit);
  };
  visit(expression);
  return unsafe;
}

function containsAsk(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "ask"
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function diagnostic(code: number, node: ts.Node, message: string, source: ts.SourceFile): CompileDiagnostic {
  const location = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { code, line: location.line + 1, column: location.character + 1, message };
}

function collectFacts(source: ts.SourceFile): CallFact[] {
  const facts: CallFact[] = [];
  const actorVariables = new Map<string, string>();
  let actorCount = 0;
  const prepass = (node: ts.Node): void => {
    const declaration = ts.isVariableDeclaration(node) ? node : undefined;
    const initializer = declaration?.initializer;
    if (declaration !== undefined && ts.isIdentifier(declaration.name) && initializer !== undefined && ts.isCallExpression(initializer)) {
      const expression = initializer.expression;
      if (ts.isIdentifier(expression) && expression.text === "agent") {
        const siteId = `actor#${++actorCount}`;
        actorVariables.set(declaration.name.text, siteId);
        facts.push({
          node: initializer,
          position: initializer.getStart(source),
          kind: "actor",
          name: literalString(initializer.arguments[0]),
        });
      }
    }
    ts.forEachChild(node, prepass);
  };
  prepass(source);
  let askCount = 0;
  let worldCount = 0;
  let artifactCount = 0;
  let reportCount = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && expression.text === "phase") {
        facts.push({
          node,
          position: node.getStart(source),
          kind: "phase",
          name: literalString(node.arguments[0]),
        });
      } else if (ts.isIdentifier(expression) && expression.text === "agent") {
        if (!facts.some((fact) => fact.position === node.getStart(source) && fact.kind === "actor")) {
          facts.push({
            node,
            position: node.getStart(source),
            kind: "actor",
            name: literalString(node.arguments[0]),
          });
        }
      } else if (ts.isIdentifier(expression) && expression.text === "report") {
        facts.push({ node, position: node.getStart(source), kind: "report", name: `report#${++reportCount}` });
      } else if (ts.isPropertyAccessExpression(expression)) {
        const chain = propertyChain(expression);
        if (chain?.property === "ask") {
          const receiver = expression.expression;
          const actorSiteId = ts.isIdentifier(receiver) ? actorVariables.get(receiver.text) : undefined;
          facts.push({
            node,
            position: node.getStart(source),
            kind: "site",
            siteKind: "ask",
            name: `ask#${++askCount}`,
            actorSiteId,
          });
        } else if (chain?.root === "artifact") {
          const artifactId = literalString(node.arguments[0]);
          facts.push({
            node,
            position: node.getStart(source),
            kind: "site",
            siteKind: "artifact",
            name: `artifact#${++artifactCount}`,
            artifactId,
            artifactKind: chain.property,
          });
        } else if (chain && ["files", "git", "world"].includes(chain.root)) {
          facts.push({
            node,
            position: node.getStart(source),
            kind: "site",
            siteKind: chain.property === "run" && chain.root === "world" ? "world-run" : "world-read",
            name: `world#${++worldCount}`,
            op: `${chain.root}.${chain.property}`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts.sort((left, right) => left.position - right.position);
}

export function analyzeWorkflowScript(scriptText: string): AnalyzeResult {
  const workflow = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  const extra: CompileDiagnostic[] = [];
  const facts = collectFacts(workflow.scriptFile);
  const actors = new Map<string, ActorProjection>();
  const sites: SiteProjection[] = [];
  const phases: PhaseProjection[] = [];
  const declared = new Map<string, DeclaredArtifact>();
  let currentPhase: PhaseProjection | undefined;
  let actorSequence = new Map<string, number>();

  const inspect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      extra.push(diagnostic(9100, node, "Workflow scripts cannot import arbitrary modules.", workflow.scriptFile));
    }
    if ((ts.isWhileStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && containsAsk(node.statement)) {
      extra.push(diagnostic(9107, node, "Workflow graph contains an unsafe ask cycle.", workflow.scriptFile));
    }
    ts.forEachChild(node, inspect);
  };
  inspect(workflow.scriptFile);

  for (const fact of facts) {
    if (fact.kind === "phase") {
      if (fact.name === undefined || fact.name.trim() === "") {
        extra.push(diagnostic(9002, fact.node.arguments[0] ?? fact.node, "phase() requires a non-empty string literal.", workflow.scriptFile));
        continue;
      }
      currentPhase = { id: `phase#${phases.length + 1}`, name: fact.name.trim(), ordinal: phases.length + 1, siteIds: [] };
      phases.push(currentPhase);
      continue;
    }
    if (fact.kind === "actor") {
      const siteId = [...actors.keys()].find((key) => key === fact.node.getText(workflow.scriptFile));
      const id = siteId ?? `actor#${actors.size + 1}`;
      actors.set(id, { siteId: id, ...(fact.name === undefined ? {} : { name: fact.name }) });
      if (fact.name !== undefined && [...actors.values()].some((actor) => actor.siteId !== id && actor.name === fact.name)) {
        extra.push(diagnostic(9006, fact.node, `Duplicate actor name: ${fact.name}`, workflow.scriptFile));
      }
      continue;
    }
    if (fact.kind === "report") {
      if (isReportPayloadUnsafe(fact.node.arguments[0])) {
        extra.push(diagnostic(9010, fact.node.arguments[0] ?? fact.node, "report() payload must be JSON serializable.", workflow.scriptFile));
      }
      const artifactId = literalString(fact.node.arguments[1]);
      if (fact.node.arguments[1] !== undefined && artifactId === undefined) {
        extra.push(diagnostic(9003, fact.node.arguments[1], "report() artifact id must be a string literal.", workflow.scriptFile));
      }
      const site: SiteProjection = { siteId: fact.name!, kind: "report", ...(artifactId ? { artifactId } : {}) };
      sites.push(site);
      currentPhase?.siteIds.push(site.siteId);
      continue;
    }
    if (fact.kind !== "site" || fact.name === undefined || fact.siteKind === undefined) continue;
    if (fact.siteKind === "ask") {
      const instructions = fact.node.arguments[0];
      if (instructions === undefined || !ts.isStringLiteral(instructions)) {
        extra.push(diagnostic(9004, instructions ?? fact.node, "ask() requires a string literal instruction.", workflow.scriptFile));
      }
      const sequence = (actorSequence.get(fact.actorSiteId ?? "anonymous") ?? 0) + 1;
      actorSequence.set(fact.actorSiteId ?? "anonymous", sequence);
      sites.push({ siteId: fact.name, kind: "ask", actorSiteId: fact.actorSiteId, actorSeq: sequence });
    } else if (fact.siteKind === "artifact") {
      if (fact.artifactId === undefined || fact.artifactId.trim() === "") {
        extra.push(diagnostic(9005, fact.node.arguments[0] ?? fact.node, "artifact id must be a non-empty string literal.", workflow.scriptFile));
      } else {
        const existing = declared.get(fact.artifactId);
        if (existing !== undefined && existing.kind !== fact.artifactKind) {
          extra.push(diagnostic(9008, fact.node, `Artifact ${fact.artifactId} changes kind.`, workflow.scriptFile));
        }
        declared.set(fact.artifactId, { id: fact.artifactId, kind: fact.artifactKind! });
      }
      sites.push({ siteId: fact.name, kind: "artifact", artifactId: fact.artifactId, artifactKind: fact.artifactKind });
    } else {
      sites.push({ siteId: fact.name, kind: fact.siteKind, op: fact.op });
    }
    currentPhase?.siteIds.push(fact.name);
  }

  const graph: WorkflowGraph = { actors: [...actors.values()], sites, phases };
  const allDiagnostics = [...diagnostics, ...extra];
  return {
    diagnostics: allDiagnostics,
    ok: allDiagnostics.length === 0,
    graph,
    causality: { phases, edges: sites.slice(1).map((site, index) => ({ from: sites[index]!.siteId, to: site.siteId })) },
    declaredArtifacts: [...declared.values()].sort((left, right) => left.id.localeCompare(right.id)),
    sourceText: scriptText,
  };
}
