import { writeFileSync } from "node:fs";

const prompt = process.argv.at(-1) ?? "";
const emit = (text) => {
  process.stdout.write(
    `${JSON.stringify({
      type: "message_end",
      messageId: "generator",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
      },
    })}\n`,
  );
  process.stdout.write(`${JSON.stringify({ type: "agent_end", reason: "stop" })}\n`);
};

if (prompt.includes("fixture: valid")) {
  emit(
    JSON.stringify({
      source: 'phase("Check"); return { ok: true };',
      assumptions: ["fixture assumption"],
      acceptanceCriteria: ["fixture criterion"],
    }),
  );
} else if (prompt.includes("fixture: fenced")) {
  emit(
    '```json\n{"source":"phase(\\"Check\\"); return { ok: true };","assumptions":[],"acceptanceCriteria":[]}\n```',
  );
} else if (prompt.includes("fixture: malformed")) {
  emit("not JSON");
} else if (prompt.includes("fixture: mixed")) {
  emit('Here is the workflow: {"source":"x","assumptions":[],"acceptanceCriteria":[]}');
} else if (prompt.includes("fixture: missing-source")) {
  emit(JSON.stringify({ assumptions: [], acceptanceCriteria: [] }));
} else if (prompt.includes("fixture: oversized")) {
  emit(JSON.stringify({ source: "x".repeat(300_000), assumptions: [], acceptanceCriteria: [] }));
} else if (prompt.includes("fixture: provider-error")) {
  process.stderr.write("fixture provider error\n");
  process.exitCode = 1;
} else if (prompt.includes("fixture: hanging")) {
  const marker = process.env.PI_GENERATOR_MARKER;
  if (marker !== undefined) writeFileSync(`${marker}.pid`, String(process.pid));
  process.on("SIGTERM", () => {
    if (marker !== undefined) writeFileSync(marker, "terminated");
    process.exit(0);
  });
  setInterval(() => undefined, 1_000);
} else {
  emit(
    JSON.stringify({
      source: 'phase("Fallback"); return {};',
      assumptions: [],
      acceptanceCriteria: [],
    }),
  );
}
