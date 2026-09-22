const prompt = process.argv.at(-1) ?? "";
const repairing = prompt.includes("Compiler diagnostics to repair, if any:\n-");
const source = repairing
  ? 'phase("Check"); return { ok: true };'
  : 'phase("Check"); const broken = ;';
const envelope = JSON.stringify({
  source,
  assumptions: ["The provider-free integration fixture is deterministic"],
  acceptanceCriteria: ["The generated workflow completes"],
});
process.stdout.write(
  `${JSON.stringify({
    type: "message_end",
    messageId: "generator",
    message: {
      role: "assistant",
      content: [{ type: "text", text: envelope }],
      stopReason: "stop",
    },
  })}\n`,
);
process.stdout.write(`${JSON.stringify({ type: "agent_end", reason: "stop" })}\n`);
