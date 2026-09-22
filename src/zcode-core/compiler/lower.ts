import { createHash } from "node:crypto";
import ts from "typescript";
import { createWorkflowProgram, SCRIPT_FILE_NAME } from "./compile.js";
import { analyzeWorkflowScript } from "../analysis/analyze.js";
import type { WorkflowGraph } from "../analysis/types.js";
import type { CompileDiagnostic } from "./compile.js";

export interface LoweredWorkflow {
  code: string;
  scriptHash: string;
  graph: WorkflowGraph;
}

export interface LowerResult {
  ok: boolean;
  diagnostics: CompileDiagnostic[];
  lowered?: LoweredWorkflow;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function literalText(node: ts.Expression | undefined, source: ts.SourceFile): string {
  return node === undefined ? "undefined" : node.getText(source);
}

function chain(expression: ts.Expression): { root: string; property: string } | undefined {
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression))
    return undefined;
  return { root: expression.expression.text, property: expression.name.text };
}

function collectReplacements(source: ts.SourceFile, offset: number): Replacement[] {
  const replacements: Replacement[] = [];
  let actorCount = 0;
  let askCount = 0;
  let worldCount = 0;
  let artifactCount = 0;
  let reportCount = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      let text: string | undefined;
      if (ts.isIdentifier(expression) && expression.text === "phase") {
        text = `__host.enterPhase(${literalText(node.arguments[0], source)})`;
      } else if (ts.isIdentifier(expression) && expression.text === "log") {
        text = `__host.log(${literalText(node.arguments[0], source)})`;
      } else if (ts.isIdentifier(expression) && expression.text === "report") {
        const artifact =
          node.arguments[1] === undefined ? "" : `, ${literalText(node.arguments[1], source)}`;
        text = `__host.report("report#${++reportCount}", ${literalText(node.arguments[0], source)}${artifact})`;
      } else if (ts.isIdentifier(expression) && expression.text === "agent") {
        const name = literalText(node.arguments[0], source);
        const persona = literalText(node.arguments[1], source);
        text = `__host.createActor("actor#${++actorCount}", ${name}, ${persona})`;
      } else if (ts.isPropertyAccessExpression(expression) && expression.name.text === "ask") {
        const receiver = expression.expression.getText(source);
        text = `__host.ask("ask#${++askCount}", ${receiver}, ${literalText(node.arguments[0], source)})`;
      } else if (ts.isPropertyAccessExpression(expression)) {
        const current = chain(expression);
        if (current?.root === "artifact") {
          const op = current.property;
          const args = node.arguments.map((argument) => argument.getText(source)).join(", ");
          const method = ["chart", "table", "metrics", "board"].includes(op)
            ? "declareArtifact"
            : "publishArtifact";
          text = `__host.${method}("artifact#${++artifactCount}", "${op}", [${args}])`;
        } else if (
          current?.root === "files" ||
          current?.root === "git" ||
          current?.root === "world"
        ) {
          const args = node.arguments.map((argument) => argument.getText(source)).join(", ");
          const op = `${current.root}.${current.property}`;
          text = `__host.worldRead("world#${++worldCount}", "${op}", [${args}])`;
        }
      }
      if (text !== undefined) {
        replacements.push({
          start: node.getStart(source) - offset,
          end: node.getEnd() - offset,
          text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return replacements;
}

export function lowerWorkflowScript(scriptText: string): LowerResult {
  const analysis = analyzeWorkflowScript(scriptText);
  if (!analysis.ok || analysis.graph === undefined) {
    return { ok: false, diagnostics: analysis.diagnostics };
  }
  const workflow = createWorkflowProgram(scriptText);
  const offset = workflow.scriptFile.text.indexOf(scriptText);
  const replacements = collectReplacements(workflow.scriptFile, offset).sort(
    (left, right) => right.start - left.start,
  );
  let code = scriptText;
  for (const replacement of replacements)
    code = `${code.slice(0, replacement.start)}${replacement.text}${code.slice(replacement.end)}`;
  code = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: SCRIPT_FILE_NAME,
  }).outputText;
  return {
    ok: true,
    diagnostics: [],
    lowered: {
      code,
      graph: analysis.graph,
      scriptHash: createHash("sha256").update(scriptText).digest("hex"),
    },
  };
}
