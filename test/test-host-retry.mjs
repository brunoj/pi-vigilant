/**
 * HOST-RETRY-EXHAUSTION suite — the host retries retryable provider errors
 * internally (one `agent_end` per attempt), so pi-vigilant must:
 *   1. stay out of the way while the host still has budget,
 *   2. step in on the attempt AFTER the host's budget is exhausted,
 *   3. use the state-aware instruction (no tool call from the interrupted
 *      message was executed; resume from the actual state of the work),
 *   4. notify the operator once per failure streak that the session is
 *      resuming automatically.
 */
import { loadExtension, assistantMsg } from "./harness.mjs";

const EXT = new URL("../index.ts", import.meta.url).pathname;
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const section = (s) => console.log(`\n=== ${s} ===`);

const errorContinuations = (sent) =>
  sent.filter((s) => s.msg.customType === "auto-continue-error");

/** A retryable provider error: the host will retry it internally. */
const retryableMsg = () => {
  const m = assistantMsg({ stopReason: "error", text: "", toolCalls: 0 });
  m.errorMessage = "terminated";
  return m;
};

section("Defer while the host has budget, step in after exhaustion");
{
  const { emit, sent, notifications } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  // Attempts 1..3 are the host's own retries (hostRetryBudget = 3).
  for (let i = 0; i < 3; i++) {
    await emit({ type: "agent_end", messages: [retryableMsg()] });
  }
  check("no continuation during host budget", errorContinuations(sent).length === 0, `${errorContinuations(sent).length}`);
  check("no notice during host budget", notifications.length === 0, `${notifications.length}`);
  // Attempt 4 is the exhaustion signal — pi-vigilant steps in.
  await emit({ type: "agent_end", messages: [retryableMsg()] });
  const cont = errorContinuations(sent);
  check("one continuation after exhaustion", cont.length === 1, `${cont.length}`);
  check("state-aware instruction used", (cont[0]?.msg.content ?? "").includes("none of its tool calls were executed") && (cont[0]?.msg.content ?? "").includes("point of interruption"), cont[0]?.msg.content?.slice(0, 70) ?? "none");
  check("notice shown once", notifications.length === 1, `${notifications.length}`);
  check("notice mentions automatic resume", (notifications[0]?.message ?? "").includes("Resuming the interrupted turn automatically"));
}

section("Exhaustion notice is once per streak, not per continuation");
{
  const { emit, sent, notifications, queue } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  // Streak 1: 4 failures → continuation + notice.
  for (let i = 0; i < 4; i++) {
    await emit({ type: "agent_end", messages: [retryableMsg()] });
  }
  check("streak 1 continuation queued", errorContinuations(sent).length === 1, `${errorContinuations(sent).length}`);
  check("streak 1 notice shown", notifications.length === 1, `${notifications.length}`);
  // Drain the queued continuation (host would consume it) and recover.
  queue.followUp.length = 0;
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Done." })] });
  check("recovery resets the notice", true);
  // Streak 2: 4 failures → continuation + notice again.
  for (let i = 0; i < 4; i++) {
    await emit({ type: "agent_end", messages: [retryableMsg()] });
  }
  check("streak 2 continuation queued", errorContinuations(sent).length === 2, `${errorContinuations(sent).length}`);
  check("streak 2 notice shown again", notifications.length === 2, `${notifications.length}`);
}

section("Non-retryable error keeps the generic instruction (unchanged)");
{
  const { emit, sent, notifications } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  const m = assistantMsg({ stopReason: "error", text: "", toolCalls: 0 });
  m.errorMessage = "400 invalid_request_error";
  await emit({ type: "agent_end", messages: [m] });
  const cont = errorContinuations(sent);
  check("one-off non-retryable error still resumes", cont.length === 1, `${cont.length}`);
  check("generic instruction used", (cont[0]?.msg.content ?? "").includes("re-read the user's last message and try again"));
  check("no exhaustion notice for non-retryable", notifications.length === 0, `${notifications.length}`);
}

section("Circuit breaker still bounds a long outage");
{
  const { emit, sent, queue } = await loadExtension(EXT);
  await emit({ type: "agent_start" });
  // Three exhaustion episodes (each: 4 failures → 1 continuation), then a
  // fourth episode must be stopped by the circuit breaker.
  for (let episode = 0; episode < 4; episode++) {
    for (let i = 0; i < 4; i++) {
      await emit({ type: "agent_end", messages: [retryableMsg()] });
    }
    queue.followUp.length = 0;
  }
  check("at most 3 continuations per streak", errorContinuations(sent).length === 3, `${errorContinuations(sent).length}`);
}

console.log("");
const failed = results.filter((r) => !r.cond);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:");
  failed.forEach((f) => console.log("  - " + f.name));
}
process.exit(failed.length === 0 ? 0 : 1);
