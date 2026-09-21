interface Findings {
  summary: string;
  risks: string[];
}

interface Plan {
  steps: string[];
}

phase("Review changed files");
const reviewer = agent("reviewer", { system: "Review only; cite evidence." });
const planner = agent("planner", { system: "Turn findings into a small execution plan." });
const findings = reviewer.ask<Findings>("Inspect the changed files and return findings.");
const plan = planner.ask<Plan>("Prepare a plan for the findings.");
const [review, executionPlan] = await Promise.all([findings, plan]);

phase("Prepare findings");
report({ review, executionPlan });
return { review, executionPlan };
