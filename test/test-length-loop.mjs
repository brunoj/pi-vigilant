/**
 * §6 test plan for PI-VIGILANT-LENGTH-LOOP-FIX.md — bounding the output-length
 * continuation loop.
 *
 * Every test drives the REAL shipped index.ts through the mocked ExtensionAPI
 * (see harness.mjs), so the assertions cover the same code path production runs.
 *
 * §6 table mapping:
 *   1  productive length stop, window 50% full          -> one continuation
 *   2  starved stop, window 99% full                    -> compact, no continuation
 *   3  same, repeated 16x                               -> exactly one compaction
 *   4  same but contextPressureCompaction:false         -> 1b pauses after 3
 *   5  4 productive continuations                       -> paused after 3 + warning
 *   6  2 starved stops, window 50% full                 -> compaction via streak
 *   7  agent_start between starved stops                -> counter survives (§3.1)
 *   8  user message mid-streak                          -> counters reset
 *   9  session_compact                                  -> length counters reset
 *  10  isContextOverflow length stop                    -> unchanged early return
 *  11  maxContextPressureCompactions reached            -> warns and stops
 *  12  16-starved-stop production trace replayed        -> 1 compaction, 0 continuations
 */
import { loadExtension, assistantMsg } from "./harness.mjs";
import * as fs from "node:fs";
import * as path from "node:path";

const EXT = process.env.PV_EXT || new URL("../index.ts", import.meta.url).pathname;
const REPO = path.dirname(EXT);
const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/length-loop-trace.json", import.meta.url), "utf8"),
);

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(s) {
  console.log(`\n=== ${s} ===`);
}

/** Copy the real extension next to a config file so settings can be overridden. */
const tempDirs = [];
function extWithConfig(overrides = {}) {
  const base = path.join(REPO, "test");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, ".tmp-len-"));  tempDirs.push(dir);
  fs.copyFileSync(EXT, path.join(dir, "index.ts"));
  fs.cpSync(path.join(REPO, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pi-vigilant.json"),
    JSON.stringify(
      {
        // Keep the tests hermetic: no reads/writes of the real agent-dir stores.
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

/** A length stop with explicit context usage. */
function lengthStop({ input, output, window = 200000, errorMessage } = {}) {
  return assistantMsg({
    stopReason: "length",
    text: output > 0 ? "x".repeat(Math.min(output, 40)) : null,
    usage: { input, output, cacheRead: 0, cacheWrite: 0 },
    errorMessage,
  });
}

const lengthContinuations = (sent) =>
  sent.filter((s) => s.msg.customType === "auto-continue-length");
const compactionNotices = (notifications) =>
  notifications.filter((n) => /Context is exhausted/.test(n.message));
const pauseNotices = (notifications) =>
  notifications.filter((n) => /Paused after/.test(n.message));

/** Simulate the host starting a new run: agent_start, then deliver queued messages. */
async function startRun(emit, queue, llm, ctx = {}) {
  await emit({ type: "agent_start" }, ctx);
  for (const m of [...queue.steering, ...queue.followUp]) {
    llm.push({
      role: "custom",
      customType: m.customType,
      content: m.content,
      details: m.details,
      display: false,
      timestamp: Date.now(),
    });
  }
  queue.steering.length = 0;
  queue.followUp.length = 0;
}

/** Run `n` length stops, each in its own run (the production loop shape). */
async function loop({ emit, queue, llm, sent, n, input, output, window }) {
  const ctx = { model: { contextWindow: window } };
  for (let i = 0; i < n; i++) {
    await startRun(emit, queue, llm, ctx);
    await emit(
      { type: "agent_end", messages: [lengthStop({ input, output, window })] },
      ctx,
    );
  }
  return sent;
}

// ---------------------------------------------------------------------------
section("§6.1 — productive length stop (window 50% full) still continues");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted } = await loadExtension(EXT);
  const llm = [];
  await loop({ emit, queue, llm, sent, n: 1, input: 100000, output: 32000, window: 200000 });
  check("one auto-continue-length queued", lengthContinuations(sent).length === 1, `${lengthContinuations(sent).length}`);
  check("no compaction requested", compacted.length === 0, `${compacted.length}`);
}

// ---------------------------------------------------------------------------
section("§6.2 — starved stop at 99% full compacts instead of continuing");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted, notifications } = await loadExtension(EXT);
  const llm = [];
  await loop({ emit, queue, llm, sent, n: 1, input: 166660, output: 1, window: 168000 });
  check("no auto-continue-length queued", lengthContinuations(sent).length === 0, `${lengthContinuations(sent).length}`);
  check("ctx.compact() called exactly once", compacted.length === 1, `${compacted.length}`);
  check("compaction carries custom instructions", typeof compacted[0]?.customInstructions === "string" && compacted[0].customInstructions.length > 0);
  check("operator is warned", compactionNotices(notifications).length === 1, `${compactionNotices(notifications).length}`);
}

// ---------------------------------------------------------------------------
section("§6.3 — the same starved stop repeated 16x compacts exactly once");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted } = await loadExtension(EXT);
  const llm = [];
  await loop({ emit, queue, llm, sent, n: 16, input: 166660, output: 1, window: 168000 });
  check("exactly one compaction", compacted.length === 1, `${compacted.length}`);
  check("no continuation loop", lengthContinuations(sent).length === 0, `${lengthContinuations(sent).length}`);
}

// ---------------------------------------------------------------------------
section("§6.4 — contextPressureCompaction:false falls through to the 1b breaker");
// ---------------------------------------------------------------------------
{
  const ext = extWithConfig({ contextPressureCompaction: false });
  const { emit, sent, queue, compacted, notifications } = await loadExtension(ext);
  const llm = [];
  await loop({ emit, queue, llm, sent, n: 4, input: 166660, output: 1, window: 168000 });
  check("never compacts when disabled", compacted.length === 0, `${compacted.length}`);
  check("breaker pauses after 3", lengthContinuations(sent).length === 3, `${lengthContinuations(sent).length}`);
  check("pause is announced", pauseNotices(notifications).length === 1, `${pauseNotices(notifications).length}`);
}

// ---------------------------------------------------------------------------
section("§6.5 — 4 productive continuations pause after lengthContinuationMaxConsecutive");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted, notifications } = await loadExtension(EXT);
  const llm = [];
  await loop({ emit, queue, llm, sent, n: 4, input: 100000, output: 32000, window: 200000 });
  check("exactly 3 continuations queued", lengthContinuations(sent).length === 3, `${lengthContinuations(sent).length}`);
  check("4th stop is paused with a warning", pauseNotices(notifications).length === 1, `${pauseNotices(notifications).length}`);
  check("productive stops never compact", compacted.length === 0, `${compacted.length}`);
}

// ---------------------------------------------------------------------------
section("§6.6 — 2 starved stops at 50% full: compaction via the streak condition");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted, notifications } = await loadExtension(EXT);
  const llm = [];
  const window = 200000;
  const input = 100000; // 50% — the ratio condition is NOT met
  await loop({ emit, queue, llm, sent, n: 3, input, output: 1, window });
  check("ratio condition was genuinely not met", input < window * 0.9, `${input} < ${window * 0.9}`);
  check("first two stops continue", lengthContinuations(sent).length === 2, `${lengthContinuations(sent).length}`);
  check("third starved stop compacts via the streak", compacted.length === 1, `${compacted.length}`);
  check("compaction is announced", compactionNotices(notifications).length === 1, `${compactionNotices(notifications).length}`);
}

// ---------------------------------------------------------------------------
section("§6.7 — the streak counters survive agent_start boundaries (§3.1 regression)");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue } = await loadExtension(EXT);
  const llm = [];
  // Productive stops: the breaker must hold across 10 run boundaries. Before the
  // fix this produced 10 continuations (the production bug); the bound is 3.
  await loop({ emit, queue, llm, sent, n: 10, input: 100000, output: 32000, window: 200000 });
  check("10 productive runs across agent_start -> 3 continuations", lengthContinuations(sent).length === 3, `${lengthContinuations(sent).length}`);
  check("bound is independent of run boundaries", lengthContinuations(sent).length < 10);
}
{
  const { emit, sent, queue, compacted } = await loadExtension(EXT);
  const llm = [];
  // Starved stops: the surviving starved streak must trigger compaction on the
  // 3rd stop even though the window is only 50% full. A counter reset by
  // agent_start could never reach 3 here.
  await loop({ emit, queue, llm, sent, n: 10, input: 100000, output: 1, window: 200000 });
  check(
    "10 starved runs across agent_start -> 2 continuations then compaction",
    lengthContinuations(sent).length === 2 && compacted.length === 1,
    `${lengthContinuations(sent).length} cont / ${compacted.length} compact`,
  );
}

// ---------------------------------------------------------------------------
section("§6.8 — a user message resets the length budget");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, notifications } = await loadExtension(EXT);
  const llm = [];
  await loop({ emit, queue, llm, sent, n: 3, input: 100000, output: 32000, window: 200000 });
  check("3 continuations queued before the user message", pauseNotices(notifications).length === 0 && lengthContinuations(sent).length === 3, `${lengthContinuations(sent).length}`);
  await emit({ type: "input", text: "Also update the changelog.", source: "user" });
  await loop({ emit, queue, llm, sent, n: 1, input: 100000, output: 32000, window: 200000 });
  check("next length stop continues again after user input", lengthContinuations(sent).length === 4, `${lengthContinuations(sent).length}`);
}

// ---------------------------------------------------------------------------
section("§6.9 — session_compact resets the length counters");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue } = await loadExtension(EXT);
  const llm = [];
  await loop({ emit, queue, llm, sent, n: 3, input: 100000, output: 32000, window: 200000 });
  check("three continuations queued before compaction", lengthContinuations(sent).length === 3, `${lengthContinuations(sent).length}`);
  await emit({ type: "session_compact", reason: "auto", willRetry: false });
  await loop({ emit, queue, llm, sent, n: 1, input: 100000, output: 32000, window: 200000 });
  check("length budget restarts after compaction", lengthContinuations(sent).length === 4, `${lengthContinuations(sent).length}`);
}

// ---------------------------------------------------------------------------
section("§6.10 — isContextOverflow length stops keep the early return (Pi core owns recovery)");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted } = await loadExtension(EXT);
  const llm = [];
  // Overflow.js Case 3: stopReason "length", output 0, input >= 99% of window.
  await loop({ emit, queue, llm, sent, n: 1, input: 166500, output: 0, window: 168000 });
  check("no length continuation for a genuine overflow", lengthContinuations(sent).length === 0, `${lengthContinuations(sent).length}`);
  check("no compaction either (Pi core recovers)", compacted.length === 0, `${compacted.length}`);
}

// ---------------------------------------------------------------------------
section("§6.11 — maxContextPressureCompactions caps the compaction loop");
// ---------------------------------------------------------------------------
{
  const ext = extWithConfig({ maxContextPressureCompactions: 1 });
  const { emit, sent, queue, compacted, notifications } = await loadExtension(ext);
  const llm = [];
  await loop({ emit, queue, llm, sent, n: 4, input: 166660, output: 1, window: 168000 });
  check("exactly one compaction (the cap)", compacted.length === 1, `${compacted.length}`);
  check("no continuations while context stays exhausted", lengthContinuations(sent).length === 0, `${lengthContinuations(sent).length}`);
  check("operator is told the context is still exhausted", notifications.some((n) => /Context remains exhausted/.test(n.message)));
}

// ---------------------------------------------------------------------------
section("§6.12 — replay the production 16-starved-stop trace");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted, notifications } = await loadExtension(EXT);
  const llm = [];
  const { stops, contextWindow } = FIXTURE;
  const ctx = { model: { contextWindow } };
  for (let i = 0; i < stops.count; i++) {
    await startRun(emit, queue, llm, ctx);
    await emit(
      {
        type: "agent_end",
        messages: [
          lengthStop({
            input: stops.inputStart + i * stops.inputStep,
            output: stops.output,
            window: contextWindow,
          }),
        ],
      },
      ctx,
    );
  }
  await startRun(emit, queue, llm, ctx);
  await emit(
    {
      type: "agent_end",
      messages: [
        assistantMsg({
          stopReason: "error",
          text: null,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          errorMessage: FIXTURE.terminal.errorMessage,
        }),
      ],
    },
    ctx,
  );

  check("exactly one compaction over the whole trace", compacted.length === 1, `${compacted.length}`);
  check("zero auto-continue-length (was 16)", lengthContinuations(sent).length === 0, `${lengthContinuations(sent).length}`);
  const firstInput = stops.inputStart;
  const lastInput = stops.inputStart + (stops.count - 1) * stops.inputStep;
  check(
    "fixture matches the trace envelope (first stop >= 90% full, never overflows)",
    firstInput >= contextWindow * 0.9 && lastInput < contextWindow,
    `${firstInput}..${lastInput} of ${contextWindow}`,
  );
  check("compaction happened on the first starved stop", compactionNotices(notifications).length === 1, `${compactionNotices(notifications).length}`);
}

// ---------------------------------------------------------------------------
section("§6.13 (extra) — a productive stop ends the starvation streak");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted } = await loadExtension(EXT);
  const llm = [];
  const ctx = { model: { contextWindow: 200000 } };
  // Two starved stops at 50% full build streak=2 ...
  for (let i = 0; i < 2; i++) {
    await startRun(emit, queue, llm, ctx);
    await emit({ type: "agent_end", messages: [lengthStop({ input: 100000, output: 1, window: 200000 })] }, ctx);
  }
  // ... a productive stop clears it (streak=0, counter=3) ...
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [lengthStop({ input: 100000, output: 32000, window: 200000 })] }, ctx);
  // ... so the next starved stop must NOT compact via the streak condition:
  // if the streak had survived it would be 3 and trigger compaction.
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [lengthStop({ input: 100000, output: 1, window: 200000 })] }, ctx);
  check("productive stop resets starvedLengthStreak", compacted.length === 0, `${compacted.length} compactions`);
  check("the breaker (not the streak) is what paused the loop", lengthContinuations(sent).length === 3, `${lengthContinuations(sent).length}`);
}

// ---------------------------------------------------------------------------
section("§6.14 (extra) — new settings are actually parsed from pi-vigilant.json");
// ---------------------------------------------------------------------------
{
  const ext = extWithConfig({ lengthContinuationMaxConsecutive: 1 });
  const { emit, sent, queue, notifications } = await loadExtension(ext);
  const llm = [];
  await loop({ emit, queue, llm, sent, n: 2, input: 100000, output: 32000, window: 200000 });
  check(
    "lengthContinuationMaxConsecutive:1 -> one continuation then pause",
    lengthContinuations(sent).length === 1 && pauseNotices(notifications).length === 1,
    `${lengthContinuations(sent).length} cont / ${pauseNotices(notifications).length} pause`,
  );
}
{
  const ext = extWithConfig({ contextPressureRatio: 0.5 });
  const { emit, sent, queue, compacted } = await loadExtension(ext);
  const llm = [];
  // 50% full: with the default ratio this would continue twice, then compact via
  // the streak. With ratio 0.5 the very first stop is already "nearly full".
  await loop({ emit, queue, llm, sent, n: 1, input: 100000, output: 1, window: 200000 });
  check(
    "contextPressureRatio:0.5 -> first starved stop compacts",
    compacted.length === 1 && lengthContinuations(sent).length === 0,
    `${compacted.length} compact / ${lengthContinuations(sent).length} cont`,
  );
}
{
  const ext = extWithConfig({ lengthContinuationTinyOutputTokens: 100 });
  const { emit, sent, queue, compacted } = await loadExtension(ext);
  const llm = [];
  // output=90 is productive at the default 64 threshold but starved at 100.
  await loop({ emit, queue, llm, sent, n: 1, input: 166660, output: 90, window: 168000 });
  check(
    "lengthContinuationTinyOutputTokens:100 -> output 90 counts as starved",
    compacted.length === 1 && lengthContinuations(sent).length === 0,
    `${compacted.length} compact / ${lengthContinuations(sent).length} cont`,
  );
}
{
  // Malformed ratio must fall back to 0.9 — NOT be floored to 0, which would make
  // every window "nearly full" and compact on the first stop at 50%.
  const ext = extWithConfig({ contextPressureRatio: 0 });
  const { emit, sent, queue, compacted } = await loadExtension(ext);
  const llm = [];
  await loop({ emit, queue, llm, sent, n: 1, input: 100000, output: 1, window: 200000 });
  check(
    "malformed contextPressureRatio:0 falls back to 0.9 (does not compact at 50%)",
    compacted.length === 0 && lengthContinuations(sent).length === 1,
    `${compacted.length} compact / ${lengthContinuations(sent).length} cont`,
  );
}

// ---------------------------------------------------------------------------
for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.cond);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILURES:");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
