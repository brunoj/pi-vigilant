/**
 * Context-overflow error recovery (Case 3a + agent_settled retry).
 *
 * When an agent turn ends with an error caused by the request exceeding the
 * model's context window, re-queueing a continuation is strictly
 * self-reinforcing (the provider rejects the same request every time, and each
 * retry grows the input a little more). pi-vigilant must NOT re-queue; instead
 * it lets the host's overflow recovery run, arms the bounded-slice fallback
 * when that recovery fails, and retries the compaction from agent_settled
 * (where the session is idle — a compact from inside the run loop would
 * deadlock on waitForIdle). On success the interrupted turn resumes via a
 * triggerTurn continuation; the handler blocks until the resumed run settles.
 *
 * Sections:
 *  1  overflow error (provider pattern)      -> no continuation at agent_end
 *  2  overflow + successful retry compact    -> continuation queued (resume)
 *  3  overflow + failed retry compact        -> notify, no continuation, no hang
 *  4  non-overflow error                     -> continuation (unchanged)
 *  5  context nearly full + non-overflow     -> no continuation, retry compacts
 *  6  cap (maxContextPressureCompactions=1)  -> second overflow warns, no compact
 *  7  cooldown (two overflows < 60s apart)   -> one compact, second warns
 *  8  length path regression                 -> Case 1a still compacts
 *  9  overflow with contextPressureCompaction disabled -> continuation
 */
import { loadExtension, assistantMsg } from "./harness.mjs";
import * as fs from "node:fs";
import * as path from "node:path";

const EXT = process.env.PV_EXT || new URL("../index.ts", import.meta.url).pathname;
const REPO = path.dirname(EXT);

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
  const dir = fs.mkdtempSync(path.join(base, ".tmp-ovf-"));
  tempDirs.push(dir);
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

/** The exact provider error observed in the Betamaxx outage (OpenRouter pattern). */
function overflowError() {
  const m = assistantMsg({ stopReason: "error", text: "", toolCalls: 0 });
  m.errorMessage =
    "400: {\"message\":\"This model's maximum context length is 168000 tokens. " +
    "However, you requested 31048 output tokens and your prompt contains at " +
    "least 136953 input tokens, for a total of at least 168001 tokens. Please " +
    "reduce the length of the messages or completion.\"}";
  return m;
}
function transientError() {
  const m = assistantMsg({ stopReason: "error", text: "", toolCalls: 0 });
  m.errorMessage = "fetch failed";
  return m;
}
/** A non-retryable provider error (not context overflow, not transient). */
function hardError() {
  const m = assistantMsg({ stopReason: "error", text: "", toolCalls: 0 });
  m.errorMessage = "400 invalid_request_error: bad tool schema";
  return m;
}

const errorContinuations = (sent) =>
  sent.filter((s) => s.msg.customType === "auto-continue-error");
const overflowNotices = (notifications) =>
  notifications.filter((n) => /Context overflow/.test(n.message));
const capNotices = (notifications) =>
  notifications.filter((n) => /Context remains exhausted/.test(n.message));
const cooldownNotices = (notifications) =>
  notifications.filter((n) => /cooldown/.test(n.message));
const failNotices = (notifications) =>
  notifications.filter((n) => /Context-overflow compaction failed|Compaction keeps failing/.test(n.message));

/** Simulate the host starting a new run and delivering queued messages. */
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

/**
 * Simulate the host's overflow recovery: its auto-compaction (whole-span
 * summary) fails with the same overflow, and the extension arms the fallback.
 */
async function hostOverflowRecovery(emit, ctx) {
  await emit({ type: "session_before_compact", reason: "overflow" }, ctx);
  await emit(
    {
      type: "session_compact_failed",
      reason: "overflow",
      aborted: false,
      errorMessage: "prompt is too long: the span to summarize exceeds the context window",
      willRetry: false,
      fromExtension: false,
    },
    ctx,
  );
}

/**
 * Drive the agent_settled retry compact. On success the handler blocks until
 * the resumed run settles, so a second agent_settled is emitted to release it
 * (mirrors the real host: the triggerTurn continuation starts a new run).
 */
async function settleWithRetry(emit, ctx, { failRetry = false, failNextCompact } = {}) {
  if (failRetry) {
    failNextCompact();
    await emit({ type: "agent_settled" }, ctx);
    // The host reacts to the failed compact with session_compact_failed;
    // pi-vigilant's handler counts it and notifies the operator.
    await emit(
      {
        type: "session_compact_failed",
        reason: "manual",
        aborted: false,
        errorMessage: "summarization rejected",
        willRetry: false,
        fromExtension: false,
      },
      ctx,
    );
    return;
  }
  const first = emit({ type: "agent_settled" }, ctx);
  // Yield so the first handler's microtasks (compact onComplete → resume wait)
  // run before the resumed run's settle is emitted.
  await new Promise((r) => setImmediate(r));
  await emit({ type: "agent_settled" }, ctx); // resumed run settles
  await first;
}

// ---------------------------------------------------------------------------
section("1 — overflow error: no continuation at agent_end (the core fix)");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted, notifications, failNextCompact } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  const ctx = { model: { contextWindow: 168000 } };
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [overflowError()] }, ctx);
  check("no auto-continue-error queued at agent_end", errorContinuations(sent).length === 0, `${errorContinuations(sent).length}`);
  check("no compact from agent_end (host recovery owns it)", compacted.length === 0, `${compacted.length}`);
  check("operator is notified", overflowNotices(notifications).length === 1, `${overflowNotices(notifications).length}`);

  // Host's recovery fails; the fallback arms.
  await hostOverflowRecovery(emit, ctx);
  check("fallback armed after the host's overflow recovery fails", true);

  // agent_settled retries the compact and resumes the turn.
  await settleWithRetry(emit, ctx);
  check("retry compact ran exactly once", compacted.length === 1, `${compacted.length}`);
  check("compaction carries custom instructions", typeof compacted[0]?.customInstructions === "string" && compacted[0].customInstructions.length > 0);
  check("continuation queued after the retry compact succeeds", errorContinuations(sent).length === 1, `${errorContinuations(sent).length}`);
  check("continuation is an error_continuation with epoch+runId", errorContinuations(sent)[0]?.msg.details?.kind === "error_continuation" && typeof errorContinuations(sent)[0]?.msg.details?.epoch === "number");
  // The host delivers it; the resumed turn succeeds.
  await startRun(emit, queue, llm, ctx);
  check("resumed turn is a fresh run (llm gained the continuation)", llm.some((m) => m.customType === "auto-continue-error"));
}

// ---------------------------------------------------------------------------
section("2 — overflow + failed retry compact notifies, no continuation, no hang");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted, notifications, failNextCompact } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  const ctx = { model: { contextWindow: 168000 } };
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [overflowError()] }, ctx);
  await hostOverflowRecovery(emit, ctx);
  await settleWithRetry(emit, ctx, { failRetry: true, failNextCompact });
  check("no continuation after a failed retry compact", errorContinuations(sent).length === 0, `${errorContinuations(sent).length}`);
  check("retry compact was attempted", compacted.length === 1, `${compacted.length}`);
  check("operator was notified (fallback arming message)", notifications.length >= 1, `${notifications.length}`);
}

// ---------------------------------------------------------------------------
section("3 — non-overflow error still queues a continuation (unchanged)");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  const ctx = { model: { contextWindow: 168000 } };
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [hardError()] }, ctx);
  check("continuation queued for a non-overflow error", errorContinuations(sent).length === 1, `${errorContinuations(sent).length}`);
  check("no compaction for a non-overflow error", compacted.length === 0, `${compacted.length}`);
}

// ---------------------------------------------------------------------------
section("4 — context nearly full + non-overflow error: no continuation, retry compacts");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted, notifications } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  const ctx = {
    model: { contextWindow: 168000 },
    getContextUsage: () => ({ tokens: 152000, contextWindow: 168000, percent: 90.5 }),
  };
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [transientError()] }, ctx);
  check("no continuation when the context is nearly full", errorContinuations(sent).length === 0, `${errorContinuations(sent).length}`);
  check("no compact from agent_end", compacted.length === 0, `${compacted.length}`);
  check("operator is notified", overflowNotices(notifications).length === 1, `${overflowNotices(notifications).length}`);

  // Host's recovery fails; the fallback arms (threshold path needs 2 failures).
  await emit({ type: "session_before_compact", reason: "threshold" }, ctx);
  await emit({ type: "session_compact_failed", reason: "threshold", aborted: false, errorMessage: "boom", willRetry: false, fromExtension: false }, ctx);
  await emit({ type: "session_before_compact", reason: "threshold" }, ctx);
  await emit({ type: "session_compact_failed", reason: "threshold", aborted: false, errorMessage: "boom", willRetry: false, fromExtension: false }, ctx);

  await settleWithRetry(emit, ctx);
  check("retry compact ran", compacted.length === 1, `${compacted.length}`);
  check("continuation queued after the retry compact succeeds", errorContinuations(sent).length === 1, `${errorContinuations(sent).length}`);
}

// ---------------------------------------------------------------------------
section("5 — the last-resort fallback is bounded by its own budget, not the cap");
// ---------------------------------------------------------------------------
{
  // maxContextPressureCompactions caps pi-vigilant's own recovery, but the
  // compaction fallback is the last resort: blocking it there would dead-end
  // the session (the one outcome the fallback exists to prevent). Its own
  // attempt budget is what stops a compact → overflow → compact loop.
  const ext = extWithConfig({
    maxContextPressureCompactions: 1,
    maxCompactionFallbackAttempts: 2,
  });
  const { emit, sent, queue, compacted, notifications } = await loadExtension(ext);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  const ctx = { model: { contextWindow: 168000 } };

  // Episode 1: the cap is already reached, but the fallback still recovers.
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [overflowError()] }, ctx);
  await hostOverflowRecovery(emit, ctx);
  await settleWithRetry(emit, ctx);
  check("first overflow compacts", compacted.length === 1, `${compacted.length}`);

  // Episode 2: same again — the cap does not stop the last resort.
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [overflowError()] }, ctx);
  await hostOverflowRecovery(emit, ctx);
  await settleWithRetry(emit, ctx);
  check(
    "the cap never blocks the last-resort fallback",
    compacted.length === 2,
    `${compacted.length}`,
  );
  check(
    "the cap message is not shown while the fallback can still run",
    capNotices(notifications).length === 0,
    `${capNotices(notifications).length}`,
  );

  // Episode 3: the fallback's own budget is spent — now it stops, and says so.
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [overflowError()] }, ctx);
  await hostOverflowRecovery(emit, ctx);
  await settleWithRetry(emit, ctx);
  check(
    "the fallback's budget stops the loop",
    compacted.length === 2,
    `${compacted.length}`,
  );
  check(
    "the operator is told the fallback gave up",
    notifications.some((n) => /already ran 2× without success/.test(n.message)),
    notifications.map((n) => n.message.slice(0, 40)).join(" | "),
  );
}

// ---------------------------------------------------------------------------
section("6 — cooldown: two overflows < 60s apart still both recover");
// ---------------------------------------------------------------------------
{
  // The cooldown spaces out pi-vigilant's own compaction attempts. It must not
  // block the fallback either: a second overflow moments later still needs the
  // bounded-slice summary, otherwise the session dead-ends.
  const { emit, sent, queue, compacted, notifications } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  const ctx = { model: { contextWindow: 168000 } };
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [overflowError()] }, ctx);
  await hostOverflowRecovery(emit, ctx);
  await settleWithRetry(emit, ctx);
  check("first overflow compacts", compacted.length === 1, `${compacted.length}`);

  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [overflowError()] }, ctx);
  await hostOverflowRecovery(emit, ctx);
  await settleWithRetry(emit, ctx);
  check(
    "a second overflow inside the cooldown still recovers",
    compacted.length === 2,
    `${compacted.length}`,
  );
  check(
    "the cooldown message is not shown while the fallback can still run",
    cooldownNotices(notifications).length === 0,
    `${cooldownNotices(notifications).length}`,
  );
}

// ---------------------------------------------------------------------------
section("7 — length path regression: Case 1a still compacts on starved stops");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, compacted, notifications } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  const ctx = { model: { contextWindow: 168000 } };
  await startRun(emit, queue, llm, ctx);
  const starved = assistantMsg({
    stopReason: "length",
    text: "x",
    usage: { input: 166660, output: 1, cacheRead: 0, cacheWrite: 0 },
  });
  await emit({ type: "agent_end", messages: [starved] }, ctx);
  check("starved length stop compacts (Case 1a unchanged)", compacted.length === 1, `${compacted.length}`);
  check("no auto-continue-length queued", sent.filter((s) => s.msg.customType === "auto-continue-length").length === 0);
  check("length path notifies with the exhaustion message", notifications.some((n) => /Context is exhausted/.test(n.message)));
}

// ---------------------------------------------------------------------------
section("8 — overflow error with contextPressureCompaction disabled falls back to continuation");
// ---------------------------------------------------------------------------
{
  const ext = extWithConfig({ contextPressureCompaction: false });
  const { emit, sent, queue, compacted } = await loadExtension(ext);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  const ctx = { model: { contextWindow: 168000 } };
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [overflowError()] }, ctx);
  check("no compaction when disabled", compacted.length === 0, `${compacted.length}`);
  check("continuation queued (bounded by the failure budget)", errorContinuations(sent).length === 1, `${errorContinuations(sent).length}`);
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.cond);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
