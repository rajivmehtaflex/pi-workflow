export const FACADE_FILE_NAME = "workflow-facade.d.ts";

export const FACADE_DTS = String.raw`
interface Node<T> extends PromiseLike<T> {}
interface AgentPersona { system?: string }
interface Agent { ask<T = string>(instructions: string): Node<T> }
declare function agent(name?: string, persona?: string | AgentPersona): Agent;
declare function log(message: string): void;
declare function report(item: unknown, artifactId?: string): void;
interface ArtifactRef { id: string; version: number }
interface ArtifactOptions { title?: string; description?: string; primary?: boolean }
interface ArtifactFileOptions extends ArtifactOptions { contentType?: string }
interface ArtifactField { field: string; label?: string; unit?: string }
interface ChartSpec extends ArtifactOptions { type?: "line" | "bar" | "scatter"; x: ArtifactField; y: ArtifactField | ArtifactField[]; scale?: "linear" | "log"; baseline?: ArtifactField }
interface TableSpec extends ArtifactOptions { columns: ArtifactField[]; key?: string }
interface MetricsSpec extends ArtifactOptions { metrics: ArtifactField[] }
interface BoardSpec extends ArtifactOptions { key: string; status: string; columns: string[]; cardTitle?: string; detail?: ArtifactField[] }
declare const artifact: {
  file(id: string, path: string, opts?: ArtifactFileOptions): Promise<ArtifactRef>;
  markdown(id: string, content: string, opts?: ArtifactOptions): Promise<ArtifactRef>;
  chart(id: string, spec: ChartSpec): void;
  table(id: string, spec: TableSpec): void;
  metrics(id: string, spec: MetricsSpec): void;
  board(id: string, spec: BoardSpec): void;
};
declare function phase(name: string): void;
interface GrepMatch { path: string; line: number; text: string }
interface GitStatus { branch?: string; clean: boolean; staged: string[]; unstaged: string[]; untracked: string[] }
interface GitCommit { hash: string; subject: string; author: string; date: string }
interface WorldRunResult { exitCode: number; stdout: string; stderr: string }
declare const files: {
  glob(pattern: string): Promise<string[]>;
  read(path: string): Promise<string>;
  grep(pattern: string, glob?: string): Promise<GrepMatch[]>;
};
declare const git: {
  changedFiles(base?: string): Promise<string[]>;
  diff(base?: string, path?: string): Promise<string>;
  status(): Promise<GitStatus>;
  log(count?: number): Promise<GitCommit[]>;
};
declare const world: {
  run(cmd: string, args?: string[], opts?: { timeoutMs?: number }): Promise<WorldRunResult>;
};
declare const args: Readonly<Record<string, unknown>>;
`;

export const SNIPPET_FACADE_DTS = String.raw`
declare function log(message: string): void;
interface GrepMatch { path: string; line: number; text: string }
interface GitStatus { branch?: string; clean: boolean; staged: string[]; unstaged: string[]; untracked: string[] }
interface GitCommit { hash: string; subject: string; author: string; date: string }
interface WorldRunResult { exitCode: number; stdout: string; stderr: string }
declare const files: { glob(pattern: string): Promise<string[]>; read(path: string): Promise<string>; grep(pattern: string, glob?: string): Promise<GrepMatch[]> };
declare const git: { changedFiles(base?: string): Promise<string[]>; diff(base?: string, path?: string): Promise<string>; status(): Promise<GitStatus>; log(count?: number): Promise<GitCommit[]> };
declare const world: { run(cmd: string, args?: string[], opts?: { timeoutMs?: number }): Promise<WorldRunResult> };
declare const args: Readonly<Record<string, unknown>>;
`;
