import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parsePiJsonLine, PiJsonProtocolError } from "../src/runtime/pi-actor/json-events.js";
import { PiJsonStreamParser, aggregatePiTurn } from "../src/runtime/pi-actor/stream-parser.js";

describe("Pi JSON event compatibility", () => {
  it("parses the pinned event union and uses message_end as the result source", async () => {
    const source = await readFile(
      new URL("./fixtures/pi-json-events.ndjson", import.meta.url),
      "utf8",
    );
    const events = source.trim().split("\n").map(parsePiJsonLine);
    const result = aggregatePiTurn(events);

    expect(events.map((event) => event.type)).toEqual([
      "session",
      "agent_start",
      "turn_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "agent_end",
    ]);
    expect(result.text).toBe('{"ok":true}');
    expect(result.stopReason).toBe("stop");
    expect(result.usage?.totalTokens).toBe(16);
    expect(result.toolEvents).toHaveLength(2);
  });

  it("rejects malformed, unknown, and oversized Pi event lines", () => {
    expect(() => parsePiJsonLine("invalid")).toThrow(PiJsonProtocolError);
    expect(() => parsePiJsonLine(JSON.stringify({ type: "unknown" }))).toThrow(PiJsonProtocolError);
    const parser = new PiJsonStreamParser({ maxLineBytes: 12 });
    expect(() => parser.push(Buffer.from('{"type":"session"}\n'))).toThrow(PiJsonProtocolError);
  });

  it("keeps update deltas as progress and does not let them replace the final message", () => {
    const result = aggregatePiTurn([
      {
        type: "message_update",
        messageId: "m",
        assistantMessageEvent: { type: "text_delta", delta: "wrong" },
      },
      {
        type: "message_end",
        messageId: "m",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "authoritative" }],
          stopReason: "stop",
        },
      },
    ]);
    expect(result.text).toBe("authoritative");
    expect(result.progressText).toBe("wrong");
  });
});
