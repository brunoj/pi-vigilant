/**
 * Write a synthetic pi session with many finalized turns.
 *
 * The compaction E2E needs a session the host will actually hand the fallback a
 * real span for. A run that piles up tool calls inside one turn leaves
 * preparation.messagesToSummarize empty (the host summarizes that as a "turn
 * prefix" instead), so the fallback has nothing to fold and the scenario proves
 * nothing. Real sessions — the kind that get stuck in production — are many
 * completed turns, which is what this writes.
 *
 * Usage: node make-session.mjs <path> <turns> <charsPerMessage>
 */
import { writeFileSync } from "node:fs";

const [out, turnsArg, sizeArg] = process.argv.slice(2);
const turns = Number(turnsArg || 24);
const size = Number(sizeArg || 1500);

const now = Date.now();
const id = () => Math.random().toString(16).slice(2, 10);
const lines = [];
let parent = null;

lines.push({ type: "session", version: 1, id: "e2e-session", timestamp: new Date(now).toISOString(), cwd: process.cwd() });
lines.push({ type: "model", id: id(), parentId: parent, timestamp: new Date(now).toISOString(), provider: "e2e", modelId: "e2e-model" });

function entry(message) {
  const e = { type: "message", id: id(), parentId: parent, timestamp: new Date(now).toISOString(), message };
  parent = e.id;
  lines.push(e);
}

const filler = "filler token xyzzy ".repeat(Math.ceil(size / 19));
for (let i = 0; i < turns; i += 1) {
  entry({ role: "user", content: [{ type: "text", text: `turn ${i}: ${filler.slice(0, size)}` }], timestamp: now + i });
  entry({ role: "assistant", content: [{ type: "text", text: `ack ${i}: ${filler.slice(0, size)}` }], timestamp: now + i, stopReason: "stop" });
}

writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
console.log(`wrote ${lines.length} entries (~${Math.round((turns * size * 2) / 1024)}KB of content) to ${out}`);
