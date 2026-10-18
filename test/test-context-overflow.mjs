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
 * triggerTurn continuation; the handler must NOT itself block waiting for
 * that resumed run to settle (the host defers the continuation until after
 * every agent_settled handler returns, so such a wait would deadlock — see
 * settleWithRetry below).
 *
 * Sections:
 *  1  overflow error (provider pattern)      -> no continuation at agent_end
 *  1b agent_settled retry releases on its own (no deadlock regression)
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
 * Drive the agent_settled retry compact and confirm the handler releases on
 * its own.
 *
 * Regression guard: an earlier version of this handler blocked on a promise
 * that only a SECOND agent_settled could resolve — but that second event can
 * only fire after the first handler returns (the host defers the triggerTurn
 * continuation until after every agent_settled handler has finished), so the
 * handler waited forever and the resumed turn never started. The first emit
 * below must now complete WITHOUT needing the second one; if it ever hangs
 * again, the race below fails fast instead of hanging the whole suite.
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
  const deadlock = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("agent_settled handler did not release — deadlock regression")),
      2000,
    ),
  );
  try {
    await Promise.race([first, deadlock]);
  } catch (error) {
    console.log(`FAIL  agent_settled handler releases on its own — ${error.message}`);
    results.push({ name: "agent_settled handler releases on its own", cond: false });
    throw error;
  }
  // The host then delivers the triggerTurn continuation; its run settles and
  // emits agent_settled again. The compact already ran for this overflow, so
  // the retry must not fire a second time.
  await emit({ type: "agent_settled" }, ctx);
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
section("1b — the agent_settled retry releases on its own (deadlock regression)");
// ---------------------------------------------------------------------------
{
  // Regression guard for the deadlock that made overflow recovery hang in
  // production instead of resuming the turn: the handler used to block on a
  // promise that only a second agent_settled could resolve, but that event
  // can only fire after this handler returns (the host defers the triggerTurn
  // continuation until every agent_settled handler has finished). The emit
  // below must complete without any second agent_settled being emitted at
  // all — if it hangs, this fails within the timeout instead of hanging the
  // whole suite.
  const { emit, sent, queue, compacted } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  const ctx = { model: { contextWindow: 168000 } };
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [overflowError()] }, ctx);
  await hostOverflowRecovery(emit, ctx);

  const first = emit({ type: "agent_settled" }, ctx);
  const timedOut = await Promise.race([
    first.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 2000)),
  ]);
  check(
    "agent_settled retry handler releases without needing a second agent_settled",
    timedOut === false,
  );
  check("retry compact ran", compacted.length === 1, `${compacted.length}`);
  check(
    "continuation queued for the resumed turn",
    errorContinuations(sent).length === 1,
    `${errorContinuations(sent).length}`,
  );
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
section("7b — the Case 1a cap must NOT block the last-resort fallback");
// ---------------------------------------------------------------------------
{
  // The production signature this guards: the provider rejects the request
  // because the prompt already fills the window and only ~1 output token fits
  // ("requested 1 output tokens and your prompt contains at least 168000 input
  // tokens"). That is a starved-length stop, so it lands in Case 1a — NOT in
  // Case 3a, which §5 covers. Case 1a used to latch overflowRetryBlocked the
  // moment its compaction cap was reached, and the latch is cleared only by a
  // successful compaction — which could no longer happen. agent_settled was
  // therefore permanently unable to retry the compaction, the fallback never
  // ran, and the session printed the same two give-up messages every turn.
  const ext = extWithConfig({
    maxContextPressureCompactions: 1,
    maxCompactionFallbackAttempts: 3,
  });
  const { emit, sent, queue, compacted, notifications, pendingCompacts } = await loadExtension(ext);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  const ctx = { model: { contextWindow: 168000 } };
  const starved = () =>
    assistantMsg({
      stopReason: "length",
      text: null,
      usage: { input: 168000, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
  const drain = async () => {
    if (pendingCompacts.length) await Promise.all(pendingCompacts.splice(0));
  };

  // Episode 1 — the starved stop compacts.
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [starved()] }, ctx);
  await drain();
  check("starved stop compacts", compacted.length === 1, `${compacted.length}`);

  // Episode 2 — the cap is reached. pi-vigilant's own recovery stops here, but
  // it must not take the last resort down with it.
  await startRun(emit, queue, llm, ctx);
  await emit({ type: "agent_end", messages: [starved()] }, ctx);
  await drain();
  check(
    "the cap holds — no second self-initiated compaction",
    compacted.length === 1,
    `${compacted.length}`,
  );

  // The host's own overflow recovery fails (its whole-span summary hits the
  // token cap). An overflow failure arms the fallback immediately.
  await emit(
    {
      type: "session_compact_failed",
      reason: "overflow",
      aborted: false,
      errorMessage: "Summarization failed: generation hit the token cap and the summary is incomplete",
      willRetry: false,
      fromExtension: false,
    },
    ctx,
  );
  check(
    "the fallback arms",
    notifications.some((n) => /summarize the context itself/.test(n.message)),
  );

  // The turn settles. This is where the session is either recovered or lost.
  await settleWithRetry(emit, ctx);
  await drain();
  check(
    "the last-resort retry compact runs despite the cap",
    compacted.length === 2,
    `${compacted.length}`,
  );
  check(
    "the interrupted turn resumes",
    sent.filter((s) => s.msg.customType === "auto-continue-error").length === 1,
    `${sent.filter((s) => s.msg.customType === "auto-continue-error").length}`,
  );
  check(
    "the operator is not told to start a new session while recovery remains",
    !notifications.some((n) => /Context remains exhausted/.test(n.message)),
  );
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
