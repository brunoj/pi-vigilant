/**
 * Test suite for the stale-continuation mitigation, run against the REAL
 * modified pi-vigilant source (copied into work/ so module resolution works).
 *
 * Covers the plan's 8-point test plan items 2-7. Item 1 (regression) and item 8
 * (live E2E) are separate runs.
 */
import { loadExtension, assistantMsg } from "./harness.mjs";

const EXT = new URL("../index.ts", import.meta.url).pathname;

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(s) { console.log(`\n=== ${s} ===`); }

/** Simulate the host: drain queued messages into the LLM context (custom → context msg). */
function drain(queue, llm) {
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

const netErr = () => {
  const m = assistantMsg({ stopReason: "error", text: "", toolCalls: 0 });
  m.errorMessage = "fetch failed";
  return m;
};
const hardErr = () => {
  const m = assistantMsg({ stopReason: "error", text: "", toolCalls: 0 });
  m.errorMessage = "400 invalid_request_error: bad tool schema";
  return m;
};

// ---------------------------------------------------------------------------
section("T2: 12-cycle outage is bounded (was 13 continuations)");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  await emit({ type: "agent_start" });
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "error", text: "", toolCalls: 3 })] });

  for (let i = 0; i < 12; i++) {
    drain(queue, llm);
    await emit({ type: "agent_end", messages: [netErr()] });
  }
  drain(queue, llm);

  console.log(`  continuations queued over 13 failed turns: ${sent.length}`);
  check("outage continuations are capped (not 1 per failed turn)", sent.length <= 3, `${sent.length} queued`);
  check("cap is strictly less than the old unbounded behaviour", sent.length < 13, `${sent.length} < 13`);
}

// ---------------------------------------------------------------------------
section("T5: retry-budget boundary (retryable network errors)");
// ---------------------------------------------------------------------------
for (const n of [1, 2, 3, 4, 6, 12, 50]) {
  const { emit, sent, queue } = await loadExtension(EXT);
  const llm = [];
  await emit({ type: "agent_start" });
  for (let i = 0; i < n; i++) {
    drain(queue, llm);
    await emit({ type: "agent_end", messages: [netErr()] });
  }
  const expected = n <= 3 ? 0 : Math.min(n - 3, 3);
  check(`${String(n).padStart(2)} retryable failures -> ${expected} continuations`, sent.length === expected, `got ${sent.length}`);
}

// ---------------------------------------------------------------------------
section("T5b: non-retryable errors engage immediately, still capped");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue } = await loadExtension(EXT);
  const llm = [];
  await emit({ type: "agent_start" });
  for (let i = 0; i < 12; i++) {
    drain(queue, llm);
    await emit({ type: "agent_end", messages: [hardErr()] });
  }
  check("non-retryable: first failure queues immediately (no host deferral)", sent.length > 0);
  check("non-retryable: capped at 3", sent.length === 3, `got ${sent.length}`);
}

// ---------------------------------------------------------------------------
section("T3: RECOVERY — stale continuations filtered after work completes");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, handlers } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "Fix the auth bug.", timestamp: 1 }];
  await emit({ type: "agent_start" });

  for (let i = 0; i < 12; i++) {
    drain(queue, llm);
    await emit({ type: "agent_end", messages: [hardErr()] });
  }
  drain(queue, llm);

  const staleBefore = llm.filter((m) => m.role === "custom").length;
  console.log(`  continuations in context during outage: ${staleBefore}`);

  // Connectivity restores; the agent finishes the work.
  await emit({
    type: "agent_end",
    messages: [assistantMsg({ stopReason: "stop", text: "Fixed the auth bug and added tests. All 14 tests pass.", toolCalls: 0 })],
  });

  // The context handler runs before the next LLM call.
  const ctxHandler = handlers.get("context")[0];
  const out = await ctxHandler({ type: "context", messages: llm }, {});
  const filtered = out?.messages ?? llm;
  const staleAfter = filtered.filter((m) => m.role === "custom").length;

  console.log(`  after recovery + context filter: ${staleAfter}`);
  check("stale continuations are dropped from the LLM context", staleBefore > 0 && staleAfter === 0, `${staleBefore} → ${staleAfter}`);
  check("the real user message is preserved", filtered.some((m) => m.role === "user" && /Fix the auth bug/.test(m.content)));
  check("no message is invented", filtered.length <= llm.length);
}

// ---------------------------------------------------------------------------
section("T4: NON-REGRESSION — a genuine interruption still resumes");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue, handlers } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "Write the report.", timestamp: 1 }];
  await emit({ type: "agent_start" });

  // A single length-stop: the classic legitimate case.
  await emit({
    type: "agent_end",
    messages: [assistantMsg({ stopReason: "length", text: "Part one of the report is", toolCalls: 1 })],
  });
  check("length-stop continuation is still queued", sent.some((s) => s.msg.customType === "auto-continue-length"), `${sent.length} sent`);

  drain(queue, llm);
  const ctxHandler = handlers.get("context")[0];
  const out = await ctxHandler({ type: "context", messages: llm }, {});
  const filtered = out?.messages ?? llm;
  check("current-epoch continuation is NOT filtered (feature still works)", filtered.some((m) => m.customType === "auto-continue-length"));
}

{
  // Premature stop after a failure streak: must still be delivered.
  const { emit, sent, queue, handlers } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "Do the thing.", timestamp: 1 }];
  await emit({ type: "agent_start" });
  for (let i = 0; i < 6; i++) {
    drain(queue, llm);
    await emit({ type: "agent_end", messages: [hardErr()] });
  }
  drain(queue, llm);
  const beforeCount = sent.length;

  // Recovery, then a genuinely premature stop in the NEW epoch.
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Step one done.", toolCalls: 2 })] });
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Next I will need to", toolCalls: 0 })] });
  const premature = sent.slice(beforeCount).filter((s) => s.msg.customType === "auto-continue-premature");
  check("premature-stop detection still fires after a recovered outage", premature.length === 1, `${premature.length}`);

  drain(queue, llm);
  const ctxHandler = handlers.get("context")[0];
  const filtered = (await ctxHandler({ type: "context", messages: llm }, {}))?.messages ?? llm;
  check("the new premature continuation survives the filter", filtered.some((m) => m.customType === "auto-continue-premature"));
  check("the old outage continuations are gone", !filtered.some((m) => m.customType === "auto-continue-error"));
}

// ---------------------------------------------------------------------------
section("T6: ISOLATION — other extensions' messages are never touched");
// ---------------------------------------------------------------------------
{
  const { emit, queue, handlers } = await loadExtension(EXT);
  const llm = [];
  await emit({ type: "agent_start" });
  for (let i = 0; i < 6; i++) { drain(queue, llm); await emit({ type: "agent_end", messages: [hardErr()] }); }
  drain(queue, llm);
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Done." })] });

  llm.push({ role: "custom", customType: "some-other-extension", content: "keep me", details: { epoch: 0 }, display: false, timestamp: 9 });
  llm.push({ role: "custom", customType: "betamaxx-ticket", content: "keep me too", details: {}, display: false, timestamp: 9 });
  llm.push({ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", timestamp: 9 });
  llm.push({ role: "toolResult", content: "result", timestamp: 9 });

  const ctxHandler = handlers.get("context")[0];
  const filtered = (await ctxHandler({ type: "context", messages: llm }, {}))?.messages ?? llm;
  check("other extension's custom message with an epoch is kept", filtered.some((m) => m.customType === "some-other-extension"));
  check("other extension's custom message without epoch is kept", filtered.some((m) => m.customType === "betamaxx-ticket"));
  check("assistant messages are kept", filtered.some((m) => m.role === "assistant"));
  check("toolResult messages are kept", filtered.some((m) => m.role === "toolResult"));
}

// ---------------------------------------------------------------------------
section("T7: BACKWARD COMPAT — un-stamped continuations are never dropped");
// ---------------------------------------------------------------------------
{
  const { emit, queue, handlers } = await loadExtension(EXT);
  const llm = [];
  await emit({ type: "agent_start" });
  for (let i = 0; i < 6; i++) { drain(queue, llm); await emit({ type: "agent_end", messages: [hardErr()] }); }
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Done." })] });

  // Written by a pre-0.1.4 version: no epoch in details.
  llm.push({ role: "custom", customType: "auto-continue-error", content: "old style", details: { kind: "error_continuation" }, display: false, timestamp: 9 });
  llm.push({ role: "custom", customType: "auto-continue-error", content: "no details at all", display: false, timestamp: 9 });

  const ctxHandler = handlers.get("context")[0];
  const filtered = (await ctxHandler({ type: "context", messages: llm }, {}))?.messages ?? llm;
  check("un-stamped continuation (details, no epoch) is kept", filtered.some((m) => m.content === "old style"));
  check("un-stamped continuation (no details) is kept", filtered.some((m) => m.content === "no details at all"));
}

// ---------------------------------------------------------------------------
section("T7b: live continuations are never filtered before recovery");
// ---------------------------------------------------------------------------
{
  const { emit, queue, handlers } = await loadExtension(EXT);
  const llm = [{ role: "user", content: "hi", timestamp: 1 }];
  await emit({ type: "agent_start" });
  await emit({ type: "agent_end", messages: [hardErr()] });
  drain(queue, llm);

  const ctxHandler = handlers.get("context")[0];
  const out = await ctxHandler({ type: "context", messages: llm }, {});
  const kept = out?.messages ?? llm;
  // A continuation from the CURRENT run in the CURRENT epoch is live: it must
  // never be filtered, otherwise the resume feature itself would break.
  check("a live current-run continuation is not filtered", kept.some((m) => m.customType === "auto-continue-error"));
  check("nothing is dropped before any recovery", kept.length === llm.length, `${kept.length}/${llm.length}`);
}

// ---------------------------------------------------------------------------
section("T7c: epoch advances once per streak, not per success");
// ---------------------------------------------------------------------------
{
  const { emit, queue, handlers } = await loadExtension(EXT);
  const llm = [];
  await emit({ type: "agent_start" });
  // streak 1
  for (let i = 0; i < 5; i++) { drain(queue, llm); await emit({ type: "agent_end", messages: [hardErr()] }); }
  drain(queue, llm);
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "A." })] });
  const e1Marker = { role: "custom", customType: "auto-continue-error", content: "streak1", details: { epoch: 0 }, display: false, timestamp: 1 };
  // several more successes should NOT advance the epoch further
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "B." })] });
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "C." })] });
  // streak 2
  for (let i = 0; i < 5; i++) { drain(queue, llm); await emit({ type: "agent_end", messages: [hardErr()] }); }
  drain(queue, llm);
  const streak2 = llm.filter((m) => m.customType === "auto-continue-error");
  const epochs = [...new Set(streak2.map((m) => m.details?.epoch))];
  console.log(`  epochs present across two streaks: ${JSON.stringify(epochs)}`);
  check("epoch advanced exactly once per recovered streak", epochs.length === 2 && epochs.includes(0) && epochs.includes(1), JSON.stringify(epochs));

  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "D." })] });
  const ctxHandler = handlers.get("context")[0];
  const filtered = (await ctxHandler({ type: "context", messages: [...llm, e1Marker] }, {}))?.messages ?? llm;
  check("both streaks' continuations are stale after final recovery", !filtered.some((m) => m.customType === "auto-continue-error"));
}

// ---------------------------------------------------------------------------
section("T7d: circuit breaker resets after recovery (new outage gets a budget)");
// ---------------------------------------------------------------------------
{
  const { emit, sent, queue } = await loadExtension(EXT);
  const llm = [];
  await emit({ type: "agent_start" });
  for (let i = 0; i < 8; i++) { drain(queue, llm); await emit({ type: "agent_end", messages: [hardErr()] }); }
  const afterFirst = sent.length;
  drain(queue, llm);
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Recovered." })] });
  for (let i = 0; i < 8; i++) { drain(queue, llm); await emit({ type: "agent_end", messages: [hardErr()] }); }
  const afterSecond = sent.length - afterFirst;
  check("a later outage is not silenced by the earlier one", afterSecond === 3, `first=${afterFirst}, second=${afterSecond}`);
}

console.log("");
const failed = results.filter((r) => !r.cond);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:"); failed.forEach((f) => console.log("  - " + f.name)); }
process.exit(failed.length === 0 ? 0 : 1);
