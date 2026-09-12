/**
 * Loop Guardian tests.
 *
 * Two layers:
 *  1. Module-level (LoopGuardian directly, injected clock) — detectors,
 *     escalation, cooldown, resets, config.
 *  2. Wiring-level (real extension via the harness) — tool events → steer via
 *     sendUserMessage, reset events, kill switch.
 */
import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtension } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const EXT = process.env.PV_EXT || path.join(REPO, "index.ts");
const EXT_DIR = path.dirname(EXT);

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(s) {
  console.log(`\n=== ${s} ===`);
}

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { LoopGuardian } = await jiti.import(
  path.join(REPO, "lib", "loop-guardian.ts"),
  { default: false },
);

const DEFAULTS = {
  repeatThreshold: 3,
  cycleRepeats: 2,
  maxCycleLength: 32,
  windowSize: 64,
  stallCalls: 24,
  stallRepeatRatio: 0.5,
  steerMax: 2,
  cooldownMs: 90_000,
};

function makeGuardian(overrides = {}, clock = { now: 1_000_000 }) {
  return new LoopGuardian({
    config: { ...DEFAULTS, ...overrides },
    now: () => clock.now,
  });
}

/** Record n identical calls; return the first action (the guardian fires at the
 *  first call that crosses the threshold, then clears its window). */
function repeat(guardian, tool, args, result, n, isError = false) {
  let action = null;
  for (let i = 0; i < n; i++) {
    const a = guardian.recordToolCall(tool, args, result, isError);
    if (a && !action) action = a;
  }
  return action;
}

// ════════════════════════════════════════════════════════════════════════
// 1 — D1 identical-repeat
// ════════════════════════════════════════════════════════════════════════
section("1. D1 identical-repeat");
{
  const g = makeGuardian();
  check("not at 2 identical calls", repeat(g, "read", { path: "a.ts" }, "x", 2) === null);
  const g2 = makeGuardian();
  const a3 = repeat(g2, "read", { path: "a.ts" }, "x", 3);
  check("fires at 3 identical calls", a3?.action === "steer" && a3?.level === 1);
  check("detection kind is identical", a3?.detection?.kind === "identical");
  check("detection names the tool", a3?.detection?.toolName === "read");
  check("detection counts 3", a3?.detection?.count === 3);

  const g3 = makeGuardian();
  const diff = repeat(g3, "read", { path: "a.ts" }, "x", 2);
  const diffResult = g3.recordToolCall("read", { path: "a.ts" }, "y", false);
  check("different result does not fire", diffResult === null && diff === null);

  const g4 = makeGuardian();
  repeat(g4, "read", { path: "a.ts" }, "x", 2);
  const diffArgs = g4.recordToolCall("read", { path: "b.ts" }, "x", false);
  check("different args do not fire", diffArgs === null);

  const g5 = makeGuardian();
  repeat(g5, "bash", { command: "npm test" }, "ok", 2);
  const diffErr = g5.recordToolCall("bash", { command: "npm test" }, "ok", true);
  check("different isError does not fire", diffErr === null);

  // Interleaved with no clean cycle: read A, read B, read C, read A, read B, read A
  // → D1 counts 3 identical A's in the window.
  const g6 = makeGuardian();
  g6.recordToolCall("read", { path: "a.ts" }, "x", false);
  g6.recordToolCall("read", { path: "b.ts" }, "y", false);
  g6.recordToolCall("read", { path: "c.ts" }, "z", false);
  g6.recordToolCall("read", { path: "a.ts" }, "x", false);
  g6.recordToolCall("read", { path: "b.ts" }, "y", false);
  const inter = g6.recordToolCall("read", { path: "a.ts" }, "x", false);
  check("interleaved repeats fire (count in window)", inter?.detection?.kind === "identical" && inter?.detection?.count === 3);

  // A,B,A,B is a clean cycle — D2 catches it at the 4th call.
  const g7 = makeGuardian();
  g7.recordToolCall("read", { path: "a.ts" }, "x", false);
  g7.recordToolCall("read", { path: "b.ts" }, "y", false);
  g7.recordToolCall("read", { path: "a.ts" }, "x", false);
  const cyc2 = g7.recordToolCall("read", { path: "b.ts" }, "y", false);
  check("A,B,A,B caught as cycle at the 4th call", cyc2?.detection?.kind === "cycle");
}

// ════════════════════════════════════════════════════════════════════════
// 2 — canonicalization
// ════════════════════════════════════════════════════════════════════════
section("2. signature canonicalization");
{
  const g = makeGuardian();
  g.recordToolCall("bash", { command: "ls", env: { A: "1", B: "2" } }, "out", false);
  g.recordToolCall("bash", { env: { B: "2", A: "1" }, command: "ls" }, "out", false);
  const a = g.recordToolCall("bash", { command: "ls", env: { A: "1", B: "2" } }, "out", false);
  check("key order does not matter", a?.detection?.kind === "identical");

  const g2 = makeGuardian();
  g2.recordToolCall("read", { path: "a.ts", offset: 1 }, "x", false);
  g2.recordToolCall("read", { path: "a.ts", offset: 2 }, "x", false);
  const a2 = g2.recordToolCall("read", { path: "a.ts", offset: 1 }, "x", false);
  check("different offset values do not collide", a2 === null);
}

// ════════════════════════════════════════════════════════════════════════
// 3 — D2 cycle
// ════════════════════════════════════════════════════════════════════════
section("3. D2 cycle (tail → head)");
{
  const g = makeGuardian();
  g.recordToolCall("read", { path: "a.ts" }, "A", false);
  g.recordToolCall("grep", { pattern: "x" }, "B", false);
  g.recordToolCall("read", { path: "c.ts" }, "C", false);
  g.recordToolCall("read", { path: "a.ts" }, "A", false);
  g.recordToolCall("grep", { pattern: "x" }, "B", false);
  const cyc = g.recordToolCall("read", { path: "c.ts" }, "C", false);
  check("A,B,C,A,B,C fires as cycle", cyc?.detection?.kind === "cycle");
  check("period is 3", cyc?.detection?.period === 3);
  check("repeats reported as 3 passes", cyc?.detection?.repeats === 3);

  const g2 = makeGuardian();
  g2.recordToolCall("read", { path: "a.ts" }, "A", false);
  g2.recordToolCall("grep", { pattern: "x" }, "B", false);
  g2.recordToolCall("read", { path: "c.ts" }, "C", false);
  g2.recordToolCall("read", { path: "a.ts" }, "A", false);
  g2.recordToolCall("grep", { pattern: "x" }, "B", false);
  const no = g2.recordToolCall("read", { path: "d.ts" }, "D", false);
  check("A,B,C,A,B,D does not fire", no === null);

  const g3 = makeGuardian();
  g3.recordToolCall("read", { path: "a.ts" }, "A", false);
  g3.recordToolCall("grep", { pattern: "x" }, "B", false);
  g3.recordToolCall("read", { path: "c.ts" }, "C", false);
  const one = g3.recordToolCall("read", { path: "a.ts" }, "A", false);
  check("single pass does not fire", one === null);

  const g4 = makeGuardian();
  g4.recordToolCall("read", { path: "a.ts" }, "A", false);
  g4.recordToolCall("read", { path: "b.ts" }, "B", false);
  g4.recordToolCall("read", { path: "a.ts" }, "A", false);
  const two = g4.recordToolCall("read", { path: "b.ts" }, "B", false);
  check("A,B,A,B fires with period 2", two?.detection?.kind === "cycle" && two?.detection?.period === 2);

  // Cycle with a different result in the second pass is not a no-progress cycle.
  const g5 = makeGuardian();
  g5.recordToolCall("read", { path: "a.ts" }, "A", false);
  g5.recordToolCall("read", { path: "b.ts" }, "B", false);
  g5.recordToolCall("read", { path: "a.ts" }, "A", false);
  const changed = g5.recordToolCall("read", { path: "b.ts" }, "B2", false);
  check("cycle with changed result does not fire", changed === null);

  // Long cycle (p=30) with 2 passes.
  const g6 = makeGuardian();
  let act = null;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 30; i++) {
      act = g6.recordToolCall("read", { path: `f${i}.ts` }, `R${i}`, false);
    }
  }
  check("long cycle (p=30) fires", act?.detection?.kind === "cycle" && act?.detection?.period === 30);
}

// ════════════════════════════════════════════════════════════════════════
// 4 — D3 analysis stall
// ════════════════════════════════════════════════════════════════════════
section("4. D3 analysis stall");
{
  // 24 calls, no mutation, half the results repeated (each of 12 files read
  // twice, in order — D1 never reaches 3, D2 finds no cycle) → D3 fires.
  const g = makeGuardian();
  let act = null;
  for (let i = 0; i < 24; i++) {
    const file = `f${Math.floor(i / 2)}.ts`;
    act = g.recordToolCall("read", { path: file }, `R${Math.floor(i / 2)}`, false);
  }
  check("stall with ≥50% repeated results fires", act?.detection?.kind === "stall");
  check("stall reports 24 calls", act?.detection?.calls === 24);

  // All-new results → no fire.
  const g2 = makeGuardian();
  let act2 = null;
  for (let i = 0; i < 24; i++) {
    act2 = g2.recordToolCall("read", { path: `f${i}.ts` }, `R${i}`, false);
  }
  check("all-new results never fire", act2 === null);

  // Exactly 50% repeats → fires (ratio >= 0.5). Order is deliberately
  // non-periodic so D2 does not catch it as a cycle first.
  const g3 = makeGuardian();
  let act3 = null;
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 2, 4, 6, 8, 10, 1, 3, 5, 7, 9, 11];
  for (let i = 0; i < order.length; i++) {
    act3 = g3.recordToolCall("read", { path: `f${order[i]}.ts` }, `R${order[i]}`, false);
  }
  check("exactly 50% repeats fires", act3?.detection?.kind === "stall");

  // A write inside the budget resets the episode → the stall never builds.
  const g4 = makeGuardian();
  let act4 = null;
  for (let i = 0; i < 23; i++) {
    const file = `f${Math.floor(i / 2)}.ts`;
    act4 = g4.recordToolCall("read", { path: file }, `R${Math.floor(i / 2)}`, false);
  }
  act4 = g4.recordToolCall("write", { path: "out.ts", content: "x" }, undefined, false);
  for (let i = 0; i < 10; i++) {
    const file = `f${Math.floor(i / 2)}.ts`;
    act4 = g4.recordToolCall("read", { path: file }, `R${Math.floor(i / 2)}`, false);
  }
  check("write inside the budget resets (no fire)", act4 === null);
}

// ════════════════════════════════════════════════════════════════════════
// 5 — escalation, cooldown, notify
// ════════════════════════════════════════════════════════════════════════
section("5. escalation ladder");
{
  const clock = { now: 1_000_000 };
  const g = makeGuardian({}, clock);
  const s1 = repeat(g, "read", { path: "a.ts" }, "x", 3);
  check("first detection → steer level 1", s1?.action === "steer" && s1?.level === 1);
  check("steer 1 names the pattern", s1?.message.includes("`read`") && s1?.message.includes("3 times"));

  // Same pattern again within cooldown → suppressed.
  const within = repeat(g, "read", { path: "a.ts" }, "x", 3);
  check("within cooldown → suppressed", within === null);

  // After cooldown, same pattern → steer level 2.
  clock.now += 91_000;
  const s2 = repeat(g, "read", { path: "a.ts" }, "x", 3);
  check("after cooldown → steer level 2", s2?.action === "steer" && s2?.level === 2);
  check("steer 2 is stronger", s2?.message.includes("STILL looping"));

  // After cooldown again → notify (steers exhausted).
  clock.now += 91_000;
  const n1 = repeat(g, "read", { path: "a.ts" }, "x", 3);
  check("steers exhausted → notify", n1?.action === "notify");
  check("notify mentions manual intervention", n1?.message.includes("Manual intervention"));

  // After cooldown again → silence (notified once).
  clock.now += 91_000;
  const n2 = repeat(g, "read", { path: "a.ts" }, "x", 3);
  check("after notify → silence", n2 === null);

  // reset() gives a fresh budget.
  g.reset();
  const s1b = repeat(g, "read", { path: "a.ts" }, "x", 3);
  check("reset gives fresh steer budget", s1b?.action === "steer" && s1b?.level === 1);
}

// ════════════════════════════════════════════════════════════════════════
// 6 — progress / reset semantics
// ════════════════════════════════════════════════════════════════════════
section("6. progress and reset");
{
  // write ends the episode (returns null, resets).
  const g = makeGuardian();
  repeat(g, "read", { path: "a.ts" }, "x", 2);
  const w = g.recordToolCall("write", { path: "o.ts", content: "c" }, undefined, false);
  check("write returns null", w === null);
  const s = repeat(g, "read", { path: "a.ts" }, "x", 3);
  check("fresh episode after write fires again", s?.action === "steer" && s?.level === 1);

  // edit also resets.
  const g2 = makeGuardian();
  repeat(g2, "read", { path: "a.ts" }, "x", 2);
  g2.recordToolCall("edit", { path: "o.ts", oldText: "a", newText: "b" }, undefined, false);
  const s2 = repeat(g2, "read", { path: "a.ts" }, "x", 3);
  check("edit resets too", s2?.action === "steer");

  // A steer clears the window: only NEW looping escalates.
  const clock = { now: 1_000_000 };
  const g3 = makeGuardian({}, clock);
  repeat(g3, "read", { path: "a.ts" }, "x", 3); // steer 1
  clock.now += 91_000;
  const after = repeat(g3, "read", { path: "a.ts" }, "x", 3);
  check("new looping after steer escalates to 2", after?.level === 2);
}

// ════════════════════════════════════════════════════════════════════════
// 7 — config
// ════════════════════════════════════════════════════════════════════════
section("7. config");
{
  const g = makeGuardian({ repeatThreshold: 2 });
  const a = repeat(g, "read", { path: "a.ts" }, "x", 2);
  check("repeatThreshold 2 fires at 2", a?.detection?.kind === "identical");

  const g2 = makeGuardian({ stallCalls: 100, windowSize: 32 });
  let act = null;
  for (let i = 0; i < 32; i++) {
    const file = `f${Math.floor(i / 2)}.ts`;
    act = g2.recordToolCall("read", { path: file }, `R${Math.floor(i / 2)}`, false);
  }
  check("stallCalls clamped to windowSize", act?.detection?.kind === "stall" && act?.detection?.calls === 32);

  const g3 = makeGuardian({ steerMax: 1 });
  const clock = { now: 1_000_000 };
  const g3c = makeGuardian({ steerMax: 1 }, clock);
  const s = repeat(g3c, "read", { path: "a.ts" }, "x", 3);
  clock.now += 91_000;
  const n = repeat(g3c, "read", { path: "a.ts" }, "x", 3);
  check("steerMax 1 → notify on second detection", s?.action === "steer" && n?.action === "notify");
}

// ════════════════════════════════════════════════════════════════════════
// 8 — wiring: tool events → steer via sendUserMessage
// ════════════════════════════════════════════════════════════════════════
const tempDirs = [];
function extWithConfig(overrides = {}) {
  const base = path.join(REPO, "test");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, ".tmp-loop-"));
  tempDirs.push(dir);
  fs.copyFileSync(EXT, path.join(dir, "index.ts"));
  fs.cpSync(path.join(EXT_DIR, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pi-vigilant.json"),
    JSON.stringify(
      {
        specMemoryIntegration: false,
        feedbackMemoryIntegration: false,
        ...overrides,
      },
      null,
      2,
    ),
  );
  return path.join(dir, "index.ts");
}

async function load(overrides = {}) {
  return loadExtension(extWithConfig(overrides));
}

/** Emit a sequence of [tool, args, result, isError?] tool executions. */
async function calls(h, seq) {
  let last = null;
  for (let i = 0; i < seq.length; i++) {
    const [tool, args, result, isError = false] = seq[i];
    const id = `c${i}`;
    await h.emit({ type: "tool_execution_start", toolCallId: id, toolName: tool, args });
    last = await h.emit({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: tool,
      result,
      isError,
    });
  }
  return last;
}

section("8. wiring: steer delivery");
{
  const h = await load();
  await calls(h, [
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
  ]);
  check("steer sent via sendUserMessage", h.userMessages.length === 1);
  check("deliverAs is steer", h.userMessages[0]?.opts?.deliverAs === "steer");
  check("steer content names the tool", h.userMessages[0]?.content?.includes("`read`"));
  check("steer content says not making progress", h.userMessages[0]?.content?.includes("not making progress"));
  check("no notify on first steer", h.notifications.length === 0);
}

section("9. wiring: cycle detected through events");
{
  const h = await load();
  await calls(h, [
    ["read", { path: "a.ts" }, "A"],
    ["grep", { pattern: "x" }, "B"],
    ["read", { path: "c.ts" }, "C"],
    ["read", { path: "a.ts" }, "A"],
    ["grep", { pattern: "x" }, "B"],
    ["read", { path: "c.ts" }, "C"],
  ]);
  check("cycle fires through wiring", h.userMessages.length === 1);
  check("cycle steer mentions sequence", h.userMessages[0]?.content?.includes("sequence of 3 tool calls"));
}

section("10. wiring: resets");
{
  // User input resets the episode → fresh steer budget.
  const h = await load();
  await calls(h, [
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
  ]);
  check("first steer sent", h.userMessages.length === 1);
  await h.emit({ type: "input", text: "continue", source: "user" });
  await calls(h, [
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
  ]);
  check("user input resets → fresh steer (level 1 again)", h.userMessages.length === 2);
  check("second steer is level 1 wording", h.userMessages[1]?.content?.includes("Loop detected"));

  // Extension-sourced input does NOT reset (same task).
  const h2 = await load();
  await calls(h2, [
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
  ]);
  const before = h2.userMessages.length;
  await h2.emit({ type: "input", text: "auto-continue", source: "extension" });
  await calls(h2, [
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
  ]);
  check("extension input does not reset (cooldown suppresses)", h2.userMessages.length === before);

  // model_select resets.
  const h3 = await load();
  await calls(h3, [
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
  ]);
  await h3.emit({ type: "model_select", model: { id: "m2" }, previousModel: { id: "m1" }, source: "set" });
  await calls(h3, [
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
  ]);
  check("model_select resets → fresh steer", h3.userMessages.length === 2);

  // session_compact resets.
  const h4 = await load();
  await calls(h4, [
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
  ]);
  await h4.emit({ type: "session_compact", reason: "threshold", fromExtension: false });
  await calls(h4, [
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
  ]);
  check("session_compact resets → fresh steer", h4.userMessages.length === 2);

  // write resets through wiring.
  const h5 = await load();
  await calls(h5, [
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["write", { path: "o.ts", content: "c" }, undefined],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
  ]);
  check("write resets through wiring (steer after 3 fresh reads)", h5.userMessages.length === 1);
}

section("11. wiring: kill switch");
{
  const h = await load({ loopGuardian: false });
  await calls(h, [
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
    ["read", { path: "a.ts" }, "x"],
  ]);
  check("loopGuardian:false → no steer", h.userMessages.length === 0);
  check("loopGuardian:false → no notify", h.notifications.length === 0);
}

section("12. wiring: D3 stall through events");
{
  const h = await load();
  const seq = [];
  for (let i = 0; i < 24; i++) {
    const file = `f${Math.floor(i / 2)}.ts`;
    seq.push(["read", { path: file }, `R${Math.floor(i / 2)}`]);
  }
  await calls(h, seq);
  check("stall fires through wiring", h.userMessages.length === 1);
  check("stall steer mentions no file modification", h.userMessages[0]?.content?.includes("without modifying any file"));
}

// ── summary ──────────────────────────────────────────────────────────────
for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.cond);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
