interface WorkspaceSummary {
  changed: string[];
  exitCode: number;
}

phase("Inspect workspace");
const status = await git.status();
const changed = await git.changedFiles();
const nodeVersion = await world.run("node", ["--version"]);

phase("Publish report");
artifact.metrics("health", {
  metrics: [{ field: "exitCode", label: "Exit code" }],
});
report({ exitCode: nodeVersion.exitCode, status: status.clean }, "health");
const summary = await artifact.markdown("summary", "# Workspace summary\n", { primary: true });
const result: WorkspaceSummary = { changed, exitCode: nodeVersion.exitCode };
return { result, summary };
