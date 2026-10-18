/**
 * Capturing OpenAI-compatible proxy for the live E2E runs.
 *
 * Why this exists in the repo: the live E2E that proves the compaction fallback
 * and the Loop Guardian is the one evidence a mock cannot supply — only the real
 * host honouring a CompactionEntry, or a real provider request carrying the
 * steer, counts. That harness used to live in /tmp, where it was run once and
 * then cleaned away, leaving two MUST specs citing paths that no longer exist.
 * It lives here now so it can be re-run.
 *
 * It records every request body to $E2E_LOG (one JSON object per line) so a test
 * can assert on what the model actually received — not on what the extension
 * claims it injected.
 *
 * Modes (env E2E_MODE):
 *   loop        every answer is the SAME tool call with the SAME args, until
 *               E2E_LOOP_TURNS answers, then a final text answer. Reproduces the
 *               production "tail back to the head" loop.
 *   negative    varied tool calls, then a final text answer. Real work: the
 *               guardian must stay silent.
 *   compaction  any request whose body exceeds E2E_FAIL_ABOVE bytes gets the
 *               400 the provider gives when the prompt outgrows the window;
 *               smaller ones (the fallback's bounded slices) succeed.
 *   prefix-cut  as compaction, but the budget binds so only the halved-span
 *               mechanism can complete.
 *
 * Env: E2E_PORT_FILE (write the bound port), E2E_LOG (request journal),
 *      E2E_FAIL_ABOVE, E2E_LOOP_TURNS, E2E_TOOL_NAME, E2E_TOOL_ARGS.
 */
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const MODE = process.env.E2E_MODE || "loop";
const LOG = process.env.E2E_LOG || "/tmp/e2e-requests.jsonl";
const FAIL_ABOVE = Number(process.env.E2E_FAIL_ABOVE || 0);
const LOOP_TURNS = Number(process.env.E2E_LOOP_TURNS || 6);
// Harness hygiene: a scripted provider that never lets the agent finish would
// otherwise spin until the wall-clock timeout with a megabyte of context. The
// cap ends the run and says so, so a stuck run fails loudly instead of slowly.
const MAX_REQUESTS = Number(process.env.E2E_MAX_REQUESTS || 60);
const TOOL_NAME = process.env.E2E_TOOL_NAME || "read";
const TOOL_ARGS = process.env.E2E_TOOL_ARGS || '{"path":"README.md"}';

writeFileSync(LOG, "");

// A summary with real weight. A 37-character stub made "the context strictly shrank"
// pass no matter what the fallback did — the post-compaction context is ~0 tokens
// against any tokensBefore, so the assertion had no teeth. Size is configurable so a
// scenario can make the summary big enough to matter.
function summaryText(label) {
  const chars = Number(process.env.E2E_SUMMARY_CHARS || 4000);
  const unit = "E2E_SUMMARY " + label + " covering the summarized span with representative content. ";
  let s = "";
  while (s.length < chars) s += unit;
  return s.slice(0, chars);
}

let turns = 0;
// Agent turns only (summaries excluded): a scripted sequence must not have its
// tool-call slots consumed by summarization requests, or a scenario silently runs
// fewer steps than it asserts (this happened and made the TTL one-shot check vacuous).
let agentTurns = 0;

function log(entry) {
  appendFileSync(LOG, JSON.stringify(entry) + "\n");
}

// pi trusts the usage the provider reports, so a proxy that returns toy numbers
// never looks full and the host never compacts. Estimate from body size (chars/4
// is pi's own rough ratio; /10 keeps the ~58KB system prompt under the window at
// first, so the run crosses the threshold after a turn or two).
function usageFor(bytes) {
  return { prompt_tokens: Math.round(bytes / 10), completion_tokens: 20, total_tokens: Math.round(bytes / 10) + 20 };
}

function sse(res, chunks, finishReason, usage) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const base = { id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 0, model: "e2e-model" };
  for (const delta of chunks) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function toolCallChunks(id, name, args) {
  return [
    { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] },
    { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] },
  ];
}

function isSummaryRequest(body, hasTools) {
  // The host's whole-span summarization and the fallback's bounded slices both
  // ask for a summary and neither declares tools; a normal agent turn always
  // does. Matching on the word "summarize" alone is wrong — the user's own
  // prompt can contain it.
  const t = JSON.stringify(body).toLowerCase();
  return !hasTools && (t.includes("summar") || t.includes("conversation so far"));
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const entry = {
      at: Date.now(),
      method: req.method,
      url: req.url,
      bytes: Buffer.byteLength(raw),
      mode: MODE,
      messages: Array.isArray(body.messages) ? body.messages.length : 0,
      lastRole: Array.isArray(body.messages) ? body.messages.at(-1)?.role : null,
      summary: isSummaryRequest(body, hasTools),
      hasTools,
      // The whole point of the journal: what the model was actually shown.
      text: raw.slice(0, 4000),
      // The tail matters more than the head for loop/steer assertions.
      tail: Array.isArray(body.messages)
        ? body.messages.slice(-4).map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content.slice(0, 600) : JSON.stringify(m.content)?.slice(0, 600),
            toolCalls: m.tool_calls?.map((tc) => `${tc.function.name}(${tc.function.arguments})`),
          }))
        : undefined,
    };
    log(entry);
    turns += 1;
    if (!entry.summary) agentTurns += 1;

    if (turns > MAX_REQUESTS) {
      sse(res, [{ role: "assistant" }, { content: "E2E_MAX_REQUESTS reached" }], "stop",
        { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 });
      return;
    }

    if (MODE === "overflow") {
      // The production signature, replayed: a big agent turn gets the provider's
      // 400, pi-vigilant's overflow recovery asks the host to compact, and the
      // host's whole-span summary gets the same 400 until the fallback's bounded
      // slices (well under the limit) are the only ones left standing.
      if (entry.summary && FAIL_ABOVE > 0 && entry.bytes > FAIL_ABOVE) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Summarization failed: generation hit the token cap and the summary is incomplete", type: "BadRequestError", code: 400 } }));
        return;
      }
      if (entry.summary) {
        sse(res, [{ role: "assistant" }, { content: summaryText(`slice ${turns}`) }], "stop", usageFor(entry.bytes));
        return;
      }
      // Build the context the way a real session does — many medium tool results,
      // not one giant message. A single oversized message cannot be sliced below
      // the failure threshold, so the fallback could only ever reach drop-only.
      if (!entry.summary && turns <= Number(process.env.E2E_WORK_TURNS || 12)) {
        sse(res, toolCallChunks(`call_${turns}`, "read", '{"path":"log.txt"}'), "tool_calls", usageFor(entry.bytes));
        return;
      }
      // The 400 belongs on the summarization, which is what the spec forces to
      // fail. 400-ing the agent turn too drives pi down its own overflow-recovery
      // path, where it crashes on an internal accounting bug that reproduces
      // without pi-vigilant loaded at all (verified by control) — that would test
      // pi, not the fallback. Set E2E_FAIL_AGENT=1 to reproduce it deliberately.
      if (FAIL_ABOVE > 0 && entry.bytes > FAIL_ABOVE && process.env.E2E_FAIL_AGENT === "1") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `This model's maximum context length is ${process.env.E2E_CTX || 168000} tokens. However, you requested 1 output tokens and your prompt contains at least ${entry.bytes} input tokens, for a total of at least ${entry.bytes + 1} tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=${entry.bytes})`, type: "BadRequestError", param: "input_tokens", code: 400 } }));
        return;
      }
      sse(res, [{ role: "assistant" }, { content: "E2E_OK overflow recovered" }], "stop", usageFor(entry.bytes));
      return;
    }

    if (MODE === "compaction" || MODE === "prefix-cut") {
      // A single-turn session never gives the host a reason to compact, so the
      // scenario does real tool work first; usage grows until it crosses the
      // window and the host starts summarizing.
      if (!entry.summary && turns <= Number(process.env.E2E_WORK_TURNS || 4)) {
        sse(res, toolCallChunks(`call_${turns}`, "read", '{"path":"README.md"}'), "tool_calls", usageFor(entry.bytes));
        return;
      }
      if (FAIL_ABOVE > 0 && entry.bytes > FAIL_ABOVE && entry.summary) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            message: `This model's maximum context length is 168000 tokens. However, you requested 1 output tokens and your prompt contains at least ${entry.bytes} input tokens.`,
            type: "BadRequestError", param: "input_tokens", code: 400,
          },
        }));
        return;
      }
      if (entry.summary) {
        sse(res, [{ role: "assistant" }, { content: summaryText(`slice ${turns}`) }], "stop",
          usageFor(entry.bytes));
        return;
      }
      sse(res, [{ role: "assistant" }, { content: "E2E_OK" }], "stop", usageFor(entry.bytes));
      return;
    }

    if (MODE === "hang") {
      // Drives the tool-call timeout ceiling. pi-vigilant does not kill the tool
      // itself — it caps `input.timeout` on the shell tool call and pi's own bash
      // enforces it, so the observable evidence is the tool RESULT (aborted vs
      // completed) plus wall-clock, not a message from us.
      if (!entry.summary) {
        if (agentTurns === 1 && process.env.E2E_TTL_SECONDS) {
          sse(res, toolCallChunks("call_ttl", "set_next_tool_timeout",
            `{"seconds":${process.env.E2E_TTL_SECONDS}}`), "tool_calls", usageFor(entry.bytes));
          return;
        }
        // Explicit slots: the TTL call occupies agent turn 1 when asked for, so the
        // hangs start after it. Deriving this from a single count silently dropped the
        // second hang (and made the one-shot assertion vacuous) — caught by the
        // enforcement-off control, which is exactly what controls are for.
        const firstHang = process.env.E2E_TTL_SECONDS ? 2 : 1;
        const hangCount = Number(process.env.E2E_SECOND_HANG || 0) ? 2 : 1;
        if (agentTurns >= firstHang && agentTurns < firstHang + hangCount) {
          const arg = process.env.E2E_REQUESTED_TIMEOUT
            ? `{"command":"sleep ${process.env.E2E_SLEEP || 12}","timeout":${process.env.E2E_REQUESTED_TIMEOUT}}`
            : `{"command":"sleep ${process.env.E2E_SLEEP || 12}"}`;
          sse(res, toolCallChunks(`call_hang_${agentTurns}`, "bash", arg), "tool_calls", usageFor(entry.bytes));
          return;
        }
        sse(res, [{ role: "assistant" }, { content: "E2E_OK hang done" }], "stop", usageFor(entry.bytes));
        return;
      }
      sse(res, [{ role: "assistant" }, { content: "E2E_SUMMARY hang" }], "stop", usageFor(entry.bytes));
      return;
    }

    if (MODE === "negative") {
      if (turns <= 3) {
        const names = ["read", "grep", "read"];
        const args = ['{"path":"a.md"}', '{"pattern":"needle"}', '{"path":"b.md"}'];
        const i = turns - 1;
        sse(res, toolCallChunks(`call_${turns}`, names[i], args[i]), "tool_calls",
          { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
        return;
      }
      sse(res, [{ role: "assistant" }, { content: "E2E_OK real work done" }], "stop",
        { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
      return;
    }

    // loop: the identical call, over and over, then a final answer.
    if (turns <= LOOP_TURNS) {
      sse(res, toolCallChunks("call_same", TOOL_NAME, TOOL_ARGS), "tool_calls",
        { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
      return;
    }
    sse(res, [{ role: "assistant" }, { content: "E2E_OK loop broken" }], "stop",
      { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  if (process.env.E2E_PORT_FILE) writeFileSync(process.env.E2E_PORT_FILE, String(port));
  console.log(`PROXY_READY ${port} mode=${MODE} failAbove=${FAIL_ABOVE}`);
});
