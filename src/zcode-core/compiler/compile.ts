import ts from "typescript";
import { FACADE_DTS, FACADE_FILE_NAME } from "../facade/dts.js";

export const SCRIPT_FILE_NAME = "workflow-script.ts";
export const WORKFLOW_FUNCTION_NAME = "__workflowScript__";

export interface CompileDiagnostic {
  code: number;
  line: number;
  column: number;
  message: string;
}

export interface WorkflowProgram {
  program: ts.Program;
  scriptFile: ts.SourceFile;
  toScriptLoc(position: number): { line: number; column: number };
}

export interface CreateWorkflowProgramOptions {
  facadeDts?: string;
}

const compilerOptions: ts.CompilerOptions = {
  allowJs: false,
  lib: ["lib.es2022.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  types: [],
};

export function createWorkflowProgram(
  scriptText: string,
  options?: CreateWorkflowProgramOptions,
): WorkflowProgram {
  const wrapped = `async function ${WORKFLOW_FUNCTION_NAME}() {\n${scriptText}\n}\n`;
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  const virtualFiles = new Map([
    [SCRIPT_FILE_NAME, wrapped],
    [FACADE_FILE_NAME, options?.facadeDts ?? FACADE_DTS],
  ]);
  const host = {
    ...defaultHost,
    fileExists(fileName: string) {
      return virtualFiles.has(fileName) || defaultHost.fileExists(fileName);
    },
    getSourceFile(
      fileName: string,
      languageVersion: ts.ScriptTarget,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean,
    ) {
      const text = virtualFiles.get(fileName);
      return text === undefined
        ? defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    readFile(fileName: string) {
      return virtualFiles.get(fileName) ?? defaultHost.readFile(fileName);
    },
    writeFile() {
      return undefined;
    },
  } satisfies ts.CompilerHost;
  const program = ts.createProgram({
    host,
    options: compilerOptions,
    rootNames: [SCRIPT_FILE_NAME, FACADE_FILE_NAME],
  });
  const scriptFile = program.getSourceFile(SCRIPT_FILE_NAME);
  if (scriptFile === undefined) throw new Error("workflow script source file missing");
  return {
    program,
    scriptFile,
    toScriptLoc(position) {
      const location = scriptFile.getLineAndCharacterOfPosition(position);
      return { line: Math.max(1, location.line), column: location.character + 1 };
    },
  };
}

export function collectDiagnostics(program: ts.Program): CompileDiagnostic[] {
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map(
    (diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      if (diagnostic.file === undefined || diagnostic.start === undefined) {
        return { code: diagnostic.code, line: 1, column: 1, message };
      }
      const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return { code: diagnostic.code, line: Math.max(1, location.line), column: location.character + 1, message };
    },
  );
}

export function compileWorkflowScript(
  scriptText: string,
  options?: CreateWorkflowProgramOptions,
): { diagnostics: CompileDiagnostic[]; ok: boolean } {
  const { program } = createWorkflowProgram(scriptText, options);
  const diagnostics = collectDiagnostics(program);
  return { diagnostics, ok: diagnostics.length === 0 };
}
