import { loadExtension, assistantMsg } from "./harness.mjs";
const EXT = new URL("../index.ts", import.meta.url).pathname;
const results = [];
const check = (n,c,d="") => { results.push({n,c}); console.log(`${c?"PASS":"FAIL"}  ${n}${d?"  — "+d:""}`); };
const ctxOf = async (h, msgs) => (await h.get("context")[0]({type:"context",messages:msgs},{}))?.messages ?? msgs;
const cont = (epoch, content="c") => ({role:"custom",customType:"auto-continue-error",content,details:{kind:"error_continuation",epoch,runId:"previous-process-run"},display:false,timestamp:1});

console.log("=== R1: resume with stale continuations from a previous process ===");
{
  const { handlers } = await loadExtension(EXT);
  const out = await ctxOf(handlers, [{role:"user",content:"go",timestamp:1}, cont(0), cont(0), cont(0)]);
  check("inherited epoch-0 continuations are retired", out.filter(m=>m.role==="custom").length === 0);
}

console.log("\n=== R2: resume where previous process reached a higher epoch ===");
{
  const { handlers } = await loadExtension(EXT);
  const out = await ctxOf(handlers, [cont(0),cont(1),cont(2),cont(5),{role:"user",content:"go",timestamp:9}]);
  check("all inherited continuations retired regardless of epoch value", out.filter(m=>m.role==="custom").length === 0);
}

console.log("\n=== R3: baseline is taken ONCE — a fresh outage after resume still resumes ===");
{
  const { emit, sent, handlers, queue } = await loadExtension(EXT);
  const llm = [{role:"user",content:"go",timestamp:1}, cont(0), cont(0)];
  await ctxOf(handlers, llm);                       // baseline -> epoch becomes 1
  await emit({type:"agent_start"});
  const hard = () => { const m=assistantMsg({stopReason:"error",text:"",toolCalls:0}); m.errorMessage="400 err"; return m; };
  await emit({type:"agent_end",messages:[hard()]});
  check("a NEW failure after resume still queues a continuation", sent.length === 1, `${sent.length}`);
  // Under run-id semantics a new continuation legitimately starts at this
  // run's epoch 0; what distinguishes it from inherited ones is the run id.
  const d = sent[0]?.msg.details;
  check("new continuation carries THIS run's id", typeof d?.runId === "string" && d.runId !== "previous-process-run", `runId=${d?.runId}`);

  const llm2 = [...llm, {role:"custom",customType:sent[0].msg.customType,content:"new",details:sent[0].msg.details,display:false,timestamp:20}];
  const out2 = await ctxOf(handlers, llm2);
  check("the NEW continuation survives (not wrongly retired)", out2.some(m=>m.content==="new"));
  check("the inherited ones stay retired", out2.filter(m=>m.details?.runId==="previous-process-run").length === 0);
}

console.log("\n=== R4: fresh session (no history) is unaffected ===");
{
  const { handlers } = await loadExtension(EXT);
  const out = await ctxOf(handlers, [{role:"user",content:"hello",timestamp:1}]);
  check("no messages altered in a clean session", out.length === 1 && out[0].role === "user");
}

console.log("\n=== R5: resume then recover then fresh outage — full cycle ===");
{
  const { emit, sent, handlers, queue } = await loadExtension(EXT);
  const hard = () => { const m=assistantMsg({stopReason:"error",text:"",toolCalls:0}); m.errorMessage="400 err"; return m; };
  let llm = [{role:"user",content:"go",timestamp:1}, cont(0,"old")];
  await ctxOf(handlers, llm);
  await emit({type:"agent_start"});
  for (let i=0;i<5;i++){ queue.followUp.length=0; queue.steering.length=0; await emit({type:"agent_end",messages:[hard()]}); }
  check("new outage is capped at 3", sent.length === 3, `${sent.length}`);
  for (const s of sent) llm.push({role:"custom",customType:s.msg.customType,content:"new",details:s.msg.details,display:false,timestamp:30});
  await emit({type:"agent_end",messages:[assistantMsg({stopReason:"stop",text:"Done."})]});
  const out = await ctxOf(handlers, llm);
  check("after recovery, BOTH old and new continuations are retired", out.filter(m=>m.role==="custom").length === 0, `${out.filter(m=>m.role==="custom").length} left`);
  check("user message intact", out.some(m=>m.role==="user"));
}
console.log("");
const f = results.filter(r=>!r.c);
console.log(`${results.length-f.length}/${results.length} checks passed`);
process.exit(f.length?1:0);
