/**
 * REGRESSION suite — pre-existing pi-vigilant behaviour must be unchanged on
 * every path that is not a failure streak.
 */
import { loadExtension, assistantMsg } from "./harness.mjs";

const EXT = new URL("../index.ts", import.meta.url).pathname;
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const section = (s) => console.log(`\n=== ${s} ===`);

section("Tools and commands still registered");
{
  const { tools, commands } = await loadExtension(EXT);
  for (const t of ["capture_feedback", "resolve_feedback", "get_feedback_checkpoints", "capture_spec", "get_task_specs", "update_spec_status"]) {
    check(`tool ${t} registered`, tools.has(t));
  }
  for (const c of ["clear-feedback", "clear-specs"]) {
    check(`command /${c} registered`, commands.has(c));
  }
}

section("Length-stop continuation (unchanged)");
{
  const { emit, sent } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "length", text: "I was writing and then", toolCalls: 1 })] });
  check("queues exactly one length continuation", sent.filter((s) => s.msg.customType === "auto-continue-length").length === 1);
  check("delivered as followUp", sent[0]?.opts?.deliverAs === "followUp");
  check("triggers a turn", sent[0]?.opts?.triggerTurn === true);
}

section("Length-stop latch still one-shot per run");
{
  const { emit, sent, queue } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "length", text: "abc and", toolCalls: 1 })] });
  queue.followUp.length = 0; queue.steering.length = 0;
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "length", text: "def and", toolCalls: 1 })] });
  check("second length stop in same run is suppressed by the latch", sent.length === 1, `${sent.length}`);
}

section("Premature-stop detection (unchanged)");
{
  const cases = [
    ["Next I will need to", true],
    ["Here is the plan:", true],
    ["All 14 tests pass.", false],
    ["Done!", false],
    ["The result is `foo`.", false],
  ];
  for (const [text, shouldFire] of cases) {
    const { emit, sent } = await loadExtension(EXT);
    await emit({ type: "agent_start" });
    await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text, toolCalls: 0 })] });
    const fired = sent.some((s) => s.msg.customType === "auto-continue-premature");
    check(`premature ${shouldFire ? "fires" : "silent"}: "${text}"`, fired === shouldFire);
  }
}

section("Tool calls are a normal stop, never premature");
{
  const { emit, sent } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Let me check:", toolCalls: 2 })] });
  check("no continuation when the model handed off to tools", sent.length === 0, `${sent.length}`);
}

section("hasPendingMessages guard (unchanged)");
{
  const { emit, sent } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "length", text: "x and", toolCalls: 1 })] }, { hasPendingMessages: () => true });
  check("nothing queued when work is already pending", sent.length === 0, `${sent.length}`);
}

section("Final verification (unchanged)");
{
  const { emit, sent } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "All done.", toolCalls: 4 })] });
  await emit({ type: "agent_settled" });
  const v = sent.filter((s) => s.msg.customType === "auto-continue-verify");
  check("verification fires once after a complex task", v.length === 1, `${v.length}`);
  check("verification prompt demands real implementation", /implemented as requested/.test(String(v[0]?.msg.content)));
}

section("Complexity gate (unchanged): simple Q&A stays silent");
{
  const { emit, sent } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "It is 42.", toolCalls: 0 })] });
  await emit({ type: "agent_settled" });
  check("no verification for a 0-tool-call exchange", sent.length === 0, `${sent.length}`);
}

section("Compaction continuation (unchanged)");
{
  const { emit, sent, queue } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  // Correct "mid-task" setup for the compaction path:
  //  - a length stop is wrong: `state.lengthQueued` intentionally suppresses it;
  //  - a premature stop WITH tool calls is wrong too: isPrematureStop() treats a
  //    tool hand-off as a normal stop, leaving lastResponseConclusive true.
  // So: one tool-call turn to clear the complexity gate, then a genuine
  // text-only premature stop to leave the task visibly unfinished.
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Checking the config:", toolCalls: 3 })] });
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Next I will need to", toolCalls: 0 })] });
  // The host drains the queued continuation before the next turn; without this
  // the hasPendingMessages() guard correctly suppresses the compaction path.
  queue.followUp.length = 0; queue.steering.length = 0;
  const before = sent.length;
  await emit({ type: "session_compact", reason: "threshold", willRetry: false });
  const comp = sent.slice(before).filter((s) => s.msg.customType === "auto-continue-compaction");
  check("compaction continuation is queued mid-task", comp.length === 1, `${comp.length}`);
  check("compaction uses steer delivery", comp[0]?.opts?.deliverAs === "steer");
}

section("Compaction guards (unchanged)");
{
  for (const [label, event, ctx] of [
    ["manual /compact stays idle", { type: "session_compact", reason: "manual" }, {}],
    ["willRetry stays idle", { type: "session_compact", reason: "threshold", willRetry: true }, {}],
    ["idle session stays idle", { type: "session_compact", reason: "threshold" }, { isIdle: () => true }],
  ]) {
    const { emit, sent, queue } = await loadExtension(EXT);
    await emit({ type: "agent_start" });
    await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Checking:", toolCalls: 3 })] });
    await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Next I will need to", toolCalls: 0 })] });
    queue.followUp.length = 0; queue.steering.length = 0;
    const before = sent.length;
    await emit(event, ctx);
    check(label, sent.slice(before).filter((s) => s.msg.customType === "auto-continue-compaction").length === 0);
  }
}

section("Single error still produces a continuation (non-retryable)");
{
  const { emit, sent } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  const m = assistantMsg({ stopReason: "error", text: "", toolCalls: 0 });
  m.errorMessage = "400 invalid_request_error";
  await emit({ type: "agent_end", messages: [m] });
  check("one-off non-retryable error still resumes", sent.filter((s) => s.msg.customType === "auto-continue-error").length === 1, `${sent.length}`);
}

section("Provider abort still produces a continuation");
{
  const { emit, sent } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  await emit({ type: "agent_end", messages: [] });
  check("abort continuation queued on first occurrence", sent.filter((s) => s.msg.customType === "auto-continue-abort").length === 1, `${sent.length}`);
}

console.log("");
const failed = results.filter((r) => !r.cond);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:"); failed.forEach((f) => console.log("  - " + f.name)); }
process.exit(failed.length === 0 ? 0 : 1);
