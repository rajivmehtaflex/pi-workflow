/* oxlint-disable max-lines -- analysis and typed-result projection share one source walk. */
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
import type { WorkflowValueSchema } from "../engine/types.js";

interface CallFact {
  node: ts.CallExpression;
  position: number;
  kind: "phase" | "actor" | "site" | "report";
  name?: string;
  op?: string;
  siteKind?: SiteKind;
  typed?: boolean;
  resultType?: ts.TypeNode;
  actorSiteId?: string;
  artifactId?: string;
  artifactKind?: string;
}

const literalString = (value: ts.Expression | undefined): string | undefined =>
  value !== undefined && ts.isStringLiteral(value) ? value.text : undefined;

function propertyChain(expression: ts.Expression): { root: string; property: string } | undefined {
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const root = expression.expression;
  return ts.isIdentifier(root) ? { root: root.text, property: expression.name.text } : undefined;
}

function isReportPayloadUnsafe(expression: ts.Expression | undefined): boolean {
  if (expression === undefined) return true;
  let unsafe = false;
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node))
      unsafe = true;
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

function diagnostic(
  code: number,
  node: ts.Node,
  message: string,
  source: ts.SourceFile,
): CompileDiagnostic {
  const location = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { code, line: location.line + 1, column: location.character + 1, message };
}

function runtimeSchema(
  node: ts.TypeNode,
  declarations: ReadonlyMap<string, ts.Declaration>,
  active: ReadonlySet<string> = new Set(),
): WorkflowValueSchema {
  if (ts.isParenthesizedTypeNode(node)) return runtimeSchema(node.type, declarations, active);
  if (ts.isTypeOperatorNode(node)) {
    if (node.operator !== ts.SyntaxKind.ReadonlyKeyword)
      throw new Error("type operators other than readonly are not supported");
    return runtimeSchema(node.type, declarations, active);
  }
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (ts.isStringLiteral(literal) || ts.isNumericLiteral(literal))
      return {
        type: "literal",
        value: ts.isStringLiteral(literal) ? literal.text : Number(literal.text),
      };
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return { type: "literal", value: true };
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return { type: "literal", value: false };
    if (literal.kind === ts.SyntaxKind.NullKeyword) return { type: "literal", value: null };
    throw new Error("literal type is not JSON-compatible");
  }
  if (ts.isArrayTypeNode(node))
    return { type: "array", items: runtimeSchema(node.elementType, declarations, active) };
  if (ts.isTupleTypeNode(node)) {
    if (node.elements.length === 0) throw new Error("empty tuple is not supported");
    const items = node.elements.map((element) =>
      runtimeSchema(ts.isNamedTupleMember(element) ? element.type : element, declarations, active),
    );
    return {
      type: "array",
      items: items.length === 1 ? items[0]! : { type: "union", variants: items },
    };
  }
  if (ts.isUnionTypeNode(node)) {
    if (node.types.length === 0) throw new Error("empty union is not supported");
    const variants = node.types.map((type) => runtimeSchema(type, declarations, active));
    return variants.length === 1 ? variants[0]! : { type: "union", variants };
  }
  if (ts.isIntersectionTypeNode(node)) {
    const schemas = node.types.map((type) => runtimeSchema(type, declarations, active));
    if (schemas.every((schema) => schema.type === "object")) {
      const properties = Object.assign({}, ...schemas.map((schema) => schema.properties));
      return { type: "object", properties };
    }
    throw new Error("only object intersections are supported");
  }
  if (ts.isTypeLiteralNode(node)) {
    const properties: Record<string, { schema: WorkflowValueSchema; optional: boolean }> = {};
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || member.name === undefined || member.type === undefined)
        throw new Error("only typed object properties are supported");
      const name =
        ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
          ? member.name.text
          : undefined;
      if (name === undefined) throw new Error("computed object properties are not supported");
      properties[name] = {
        schema: runtimeSchema(member.type, declarations, active),
        optional: member.questionToken !== undefined,
      };
    }
    return { type: "object", properties };
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    if (name === "Array" || name === "ReadonlyArray") {
      const element = node.typeArguments?.[0];
      if (element === undefined) throw new Error(`${name} requires an element type`);
      return { type: "array", items: runtimeSchema(element, declarations, active) };
    }
    const declaration = declarations.get(name);
    if (declaration === undefined) throw new Error(`type ${name} cannot be converted`);
    if (active.has(name)) throw new Error(`recursive type ${name} cannot be converted`);
    const next = new Set(active);
    next.add(name);
    if (ts.isInterfaceDeclaration(declaration)) {
      const properties: Record<string, { schema: WorkflowValueSchema; optional: boolean }> = {};
      for (const member of declaration.members) {
        if (
          !ts.isPropertySignature(member) ||
          member.name === undefined ||
          member.type === undefined
        )
          throw new Error("only typed interface properties are supported");
        const propertyName =
          ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
            ? member.name.text
            : undefined;
        if (propertyName === undefined)
          throw new Error("computed interface properties are not supported");
        properties[propertyName] = {
          schema: runtimeSchema(member.type, declarations, next),
          optional: member.questionToken !== undefined,
        };
      }
      return { type: "object", properties };
    }
    if (ts.isTypeAliasDeclaration(declaration)) {
      if (declaration.typeParameters !== undefined)
        throw new Error(`generic type ${name} cannot be converted`);
      return runtimeSchema(declaration.type, declarations, next);
    }
    throw new Error(`type ${name} cannot be converted`);
  }
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { type: "string" };
    case ts.SyntaxKind.NumberKeyword:
      return { type: "number" };
    case ts.SyntaxKind.BooleanKeyword:
      return { type: "boolean" };
    case ts.SyntaxKind.NullKeyword:
      return { type: "null" };
    default:
      throw new Error("type cannot be converted to a JSON runtime schema");
  }
}

function collectTypeDeclarations(source: ts.SourceFile): Map<string, ts.Declaration> {
  const declarations = new Map<string, ts.Declaration>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name !== undefined
    )
      declarations.set(node.name.text, node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return declarations;
}

function collectFacts(source: ts.SourceFile): CallFact[] {
  const facts: CallFact[] = [];
  const actorVariables = new Map<string, string>();
  let actorCount = 0;
  const prepass = (node: ts.Node): void => {
    const declaration = ts.isVariableDeclaration(node) ? node : undefined;
    const initializer = declaration?.initializer;
    if (
      declaration !== undefined &&
      ts.isIdentifier(declaration.name) &&
      initializer !== undefined &&
      ts.isCallExpression(initializer)
    ) {
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
        if (
          !facts.some((fact) => fact.position === node.getStart(source) && fact.kind === "actor")
        ) {
          facts.push({
            node,
            position: node.getStart(source),
            kind: "actor",
            name: literalString(node.arguments[0]),
          });
        }
      } else if (ts.isIdentifier(expression) && expression.text === "report") {
        facts.push({
          node,
          position: node.getStart(source),
          kind: "report",
          name: `report#${++reportCount}`,
        });
      } else if (ts.isPropertyAccessExpression(expression)) {
        const chain = propertyChain(expression);
        if (chain?.property === "ask") {
          const receiver = expression.expression;
          const actorSiteId = ts.isIdentifier(receiver)
            ? actorVariables.get(receiver.text)
            : undefined;
          facts.push({
            node,
            position: node.getStart(source),
            kind: "site",
            siteKind: "ask",
            name: `ask#${++askCount}`,
            actorSiteId,
            ...(node.typeArguments?.length ? { typed: true } : {}),
            ...(node.typeArguments?.[0] === undefined ? {} : { resultType: node.typeArguments[0] }),
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
            siteKind:
              chain.property === "run" && chain.root === "world" ? "world-run" : "world-read",
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
  const typeDeclarations = collectTypeDeclarations(workflow.scriptFile);
  const actors = new Map<string, ActorProjection>();
  const sites: SiteProjection[] = [];
  const phases: PhaseProjection[] = [];
  const declared = new Map<string, DeclaredArtifact>();
  let currentPhase: PhaseProjection | undefined;
  let actorSequence = new Map<string, number>();

  const inspect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      extra.push(
        diagnostic(
          9100,
          node,
          "Workflow scripts cannot import arbitrary modules.",
          workflow.scriptFile,
        ),
      );
    }
    if (
      (ts.isWhileStatement(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node)) &&
      containsAsk(node.statement)
    ) {
      extra.push(
        diagnostic(9107, node, "Workflow graph contains an unsafe ask cycle.", workflow.scriptFile),
      );
    }
    ts.forEachChild(node, inspect);
  };
  inspect(workflow.scriptFile);

  for (const fact of facts) {
    if (fact.kind === "phase") {
      if (fact.name === undefined || fact.name.trim() === "") {
        extra.push(
          diagnostic(
            9002,
            fact.node.arguments[0] ?? fact.node,
            "phase() requires a non-empty string literal.",
            workflow.scriptFile,
          ),
        );
        continue;
      }
      currentPhase = {
        id: `phase#${phases.length + 1}`,
        name: fact.name.trim(),
        ordinal: phases.length + 1,
        siteIds: [],
      };
      phases.push(currentPhase);
      continue;
    }
    if (fact.kind === "actor") {
      const siteId = [...actors.keys()].find(
        (key) => key === fact.node.getText(workflow.scriptFile),
      );
      const id = siteId ?? `actor#${actors.size + 1}`;
      actors.set(id, { siteId: id, ...(fact.name === undefined ? {} : { name: fact.name }) });
      if (
        fact.name !== undefined &&
        [...actors.values()].some((actor) => actor.siteId !== id && actor.name === fact.name)
      ) {
        extra.push(
          diagnostic(9006, fact.node, `Duplicate actor name: ${fact.name}`, workflow.scriptFile),
        );
      }
      continue;
    }
    if (fact.kind === "report") {
      if (isReportPayloadUnsafe(fact.node.arguments[0])) {
        extra.push(
          diagnostic(
            9010,
            fact.node.arguments[0] ?? fact.node,
            "report() payload must be JSON serializable.",
            workflow.scriptFile,
          ),
        );
      }
      const artifactId = literalString(fact.node.arguments[1]);
      if (fact.node.arguments[1] !== undefined && artifactId === undefined) {
        extra.push(
          diagnostic(
            9003,
            fact.node.arguments[1],
            "report() artifact id must be a string literal.",
            workflow.scriptFile,
          ),
        );
      }
      const site: SiteProjection = {
        siteId: fact.name!,
        kind: "report",
        ...(artifactId ? { artifactId } : {}),
      };
      sites.push(site);
      currentPhase?.siteIds.push(site.siteId);
      continue;
    }
    if (fact.kind !== "site" || fact.name === undefined || fact.siteKind === undefined) continue;
    if (fact.siteKind === "ask") {
      const instructions = fact.node.arguments[0];
      if (instructions === undefined || !ts.isStringLiteral(instructions)) {
        extra.push(
          diagnostic(
            9004,
            instructions ?? fact.node,
            "ask() requires a string literal instruction.",
            workflow.scriptFile,
          ),
        );
      }
      const sequence = (actorSequence.get(fact.actorSiteId ?? "anonymous") ?? 0) + 1;
      actorSequence.set(fact.actorSiteId ?? "anonymous", sequence);
      let resultSchema: WorkflowValueSchema | undefined;
      if (fact.typed && fact.resultType !== undefined) {
        try {
          resultSchema = runtimeSchema(fact.resultType, typeDeclarations);
        } catch (error) {
          extra.push(
            diagnostic(
              9011,
              fact.resultType,
              `Typed ask result type cannot become a runtime schema: ${error instanceof Error ? error.message : String(error)}`,
              workflow.scriptFile,
            ),
          );
        }
      }
      sites.push({
        siteId: fact.name,
        kind: "ask",
        ...(fact.typed ? { typed: true } : {}),
        ...(resultSchema === undefined ? {} : { resultSchema }),
        actorSiteId: fact.actorSiteId,
        actorSeq: sequence,
      });
    } else if (fact.siteKind === "artifact") {
      if (fact.artifactId === undefined || fact.artifactId.trim() === "") {
        extra.push(
          diagnostic(
            9005,
            fact.node.arguments[0] ?? fact.node,
            "artifact id must be a non-empty string literal.",
            workflow.scriptFile,
          ),
        );
      } else {
        const existing = declared.get(fact.artifactId);
        if (existing !== undefined && existing.kind !== fact.artifactKind) {
          extra.push(
            diagnostic(
              9008,
              fact.node,
              `Artifact ${fact.artifactId} changes kind.`,
              workflow.scriptFile,
            ),
          );
        }
        declared.set(fact.artifactId, { id: fact.artifactId, kind: fact.artifactKind! });
      }
      sites.push({
        siteId: fact.name,
        kind: "artifact",
        artifactId: fact.artifactId,
        artifactKind: fact.artifactKind,
      });
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
    causality: {
      phases,
      edges: sites.slice(1).map((site, index) => ({ from: sites[index]!.siteId, to: site.siteId })),
    },
    declaredArtifacts: [...declared.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    sourceText: scriptText,
  };
}
