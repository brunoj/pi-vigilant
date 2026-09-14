/**
 * Compaction-fallback test plan (docs/compaction-fallback-plan.md §6).
 *
 * Every test drives the REAL shipped index.ts through the mocked ExtensionAPI
 * (harness.mjs). The summarizer is stubbed through the generated host shim, so
 * the fold, the chunk planning and the cut-point selection under test are the
 * same code production runs — only the provider call is replaced.
 *
 *   1  dormant until compaction fails            -> no summary, no model call
 *   2  arming after N consecutive failures       -> notified once, then engages
 *   3  aborted failures                          -> never arm
 *   4  successful compaction                     -> disarm + reset
 *   5  mechanism A (chunked fold)                -> host's cut point, full coverage
 *   6  chunking + folding                        -> one call per slice, folded in order
 *  6b  output budget                           -> a slice never exceeds the summary cap
 *   7  chunk budget exceeded                     -> mechanism B (prefix cut)
 *   8  mechanism B cut point                     -> ~50% by size, legal cut point
 *   9  coverage                                  -> nothing dropped unsummarized
 *  10  summarizer failure                       -> no retry, drop-only keeps the session alive
 * 10a  drop-only disabled                      -> fail fast, one message, no retry
 * 10b  slice fails partway                     -> partial compaction (prefix cut)
 * 10c  slice too large for one request         -> split in half, folded, complete
 * 10d  every slice size hits the cap           -> drop-only last resort
 * 10e  aborted compaction                      -> never drops content
 *  11  attempt cap                              -> refuses, says so, never loops
 *  12  config disabled                          -> hook never intervenes
 *  13  split turn                               -> turn prefix folded + merged
 * 13b  split turn, partial compaction           -> the turn prefix is never cut into
 *  15  config parsing                           -> values honoured, garbage ignored
 *  16  compactionFallbackModel                  -> summarizer uses that model
 *  17  ownership                                -> no ctx.compact(), one result/event
 *  18  re-entrancy                              -> a nested event cannot re-enter
 */
import { loadExtension } from "./harness.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { sessionEntryToContextMessages, buildContextEntries } from "@earendil-works/pi-coding-agent";

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

// ── Fixtures ────────────────────────────────────────────────────────────
// estimateTokens() is chars/4, so `chars` pins a message's token size exactly.

const CHARS_PER_TOKEN = 4;

/** A user/assistant message entry of a known token size. */
function messageEntry(id, role, tokens = 1024) {
  return {
    type: "message",
    id,
    message: {
      role,
      content: [{ type: "text", text: "x".repeat(tokens * CHARS_PER_TOKEN) }],
      timestamp: 1,
    },
  };
}

/** A tool-result entry — never a legal cut point. */
function toolResultEntry(id, tokens = 64) {
  return {
    type: "message",
    id,
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "t".repeat(tokens * CHARS_PER_TOKEN) }],
      timestamp: 1,
    },
  };
}

function usageOf(input, output) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Build a preparation the way the host does: entries in, messages out. */
function preparationFrom(entries, { firstKeptEntryId, reserveTokens = 16384, previousSummary } = {}) {
  const cutIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  const messagesToSummarize = [];
  for (let i = 0; i < cutIndex; i++) {
    if (entries[i].type === "compaction") continue; // Pi skips these
    const [first] = sessionEntryToContextMessages(entries[i]);
    if (first) messagesToSummarize.push(first);
  }
  return {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 4242,
    previousSummary,
    fileOps: {},
    settings: { enabled: true, reserveTokens, keepRecentTokens: 20000 },
  };
}

/** A span of `count` message entries plus a kept tail, as branch entries. */
function buildSession({ count = 4, tokensEach = 1024, withToolResults = false, tail = 2 } = {}) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push(messageEntry(`m${i}`, i % 2 === 0 ? "user" : "assistant", tokensEach));
    if (withToolResults) entries.push(toolResultEntry(`t${i}`));
  }
  for (let i = 0; i < tail; i++) {
    entries.push(messageEntry(`k${i}`, "assistant", 128));
  }
  return entries;
}

function compactEvent(entries, preparationOverrides = {}) {
  const firstKeptEntryId = entries.find((entry) => entry.id.startsWith("k"))?.id ?? entries[entries.length - 1].id;
  const preparation = {
    ...preparationFrom(entries, { firstKeptEntryId }),
    ...preparationOverrides,
  };
  return {
    type: "session_before_compact",
    preparation,
    branchEntries: entries,
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

// ── Summarizer stub ─────────────────────────────────────────────────────

/** Install a stub summarizer, returning the list of calls it receives. */
function installSummarizer(impl) {
  const calls = [];
  globalThis.__PV_SUMMARIZE__ = async (...args) => {
    const [messages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary] = args;
    const record = {
      messages,
      model,
      reserveTokens,
      apiKey,
      headers,
      customInstructions,
      previousSummary,
      tokens: messages.reduce((sum, message) => sum + Math.ceil((message.content?.[0]?.text?.length ?? 0) / 4), 0),
    };
    calls.push(record);
    if (impl) return impl(record, calls.length);
    return { text: `summary-${calls.length}`, usage: usageOf(100, 20) };
  };
  return calls;
}

function clearSummarizer() {
  delete globalThis.__PV_SUMMARIZE__;
}

// ── Extension loading ───────────────────────────────────────────────────

const tempDirs = [];
function extWithConfig(overrides = {}) {
  const base = path.join(REPO, "test");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, ".tmp-compact-"));
  tempDirs.push(dir);
  fs.copyFileSync(EXT, path.join(dir, "index.ts"));
  fs.cpSync(path.join(REPO, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pi-vigilant.json"),
    JSON.stringify(
      {
        // Hermetic: never touch the real agent-dir stores.
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

/** Drive `n` non-aborted compaction failures. */
async function failCompaction(h, n = 2, event = {}) {
  for (let i = 0; i < n; i++) {
    await h.emit({
      type: "session_compact_failed",
      reason: "threshold",
      errorMessage: "prompt is too long",
      aborted: false,
      willRetry: false,
      fromExtension: false,
      ...event,
    });
  }
}

function compactionOf(emitResults) {
  return emitResults.find((result) => result && result.compaction)?.compaction;
}

/**
 * Messages of `entries` that are neither in a summarizer request nor kept after
 * the compaction's cut — i.e. content the compaction silently threw away. The
 * compaction contract is that this set is always empty.
 */
function uncoveredOf(entries, compaction, calls) {
  const summarized = new Set(
    calls.flatMap((call) =>
      call.messages.map((message) => message.content?.[0]?.text),
    ),
  );
  const cutIndex = entries.findIndex(
    (entry) => entry.id === compaction?.firstKeptEntryId,
  );
  const kept = new Set(
    entries
      .slice(Math.max(0, cutIndex))
      .flatMap((entry) => sessionEntryToContextMessages(entry))
      .map((message) => message.content?.[0]?.text),
  );
  return entries
    .flatMap((entry) => sessionEntryToContextMessages(entry))
    .map((message) => message.content?.[0]?.text)
    .filter((text) => text && !summarized.has(text) && !kept.has(text));
}

/** Estimated size (chars/4) of the context Pi would send for these entries. */
function contextEstimate(entries) {
  let tokens = 0;
  for (const entry of buildContextEntries(entries)) {
    for (const message of sessionEntryToContextMessages(entry)) {
      tokens += Math.max(1, Math.ceil((message.content?.[0]?.text?.length ?? 0) / 4));
    }
  }
  return tokens;
}

// ════════════════════════════════════════════════════════════════════════
// 1 — dormant until compaction actually fails
// ════════════════════════════════════════════════════════════════════════
section("1. dormant while compaction is working");
{
  const h = await load();
  const calls = installSummarizer();
  const event = compactEvent(buildSession());
  const out = await h.emit(event);

  check("unarmed: hook returns nothing (Pi's own path stays in charge)", out.every((r) => r === undefined));
  check("unarmed: the summarizer is never called", calls.length === 0);
  check("unarmed: nothing is reported to the operator", h.notifications.length === 0);
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 2 — arming policy
// ════════════════════════════════════════════════════════════════════════
section("2. arming after consecutive failures");
{
  const h = await load();
  installSummarizer();

  await failCompaction(h, 1);
  check("one failure is not enough to arm", h.notifications.length === 0);

  const beforeArming = await h.emit(compactEvent(buildSession()));
  check("still dormant after one failure", beforeArming.every((r) => r === undefined));

  await failCompaction(h, 1);
  check("second consecutive failure arms the fallback", h.notifications.length === 1);
  check(
    "the operator is told why and what to expect",
    /failed 2× in a row/.test(h.notifications[0]?.message ?? "") &&
      /bounded slices/.test(h.notifications[0]?.message ?? "") &&
      h.notifications[0]?.type === "warning",
  );

  const out = await h.emit(compactEvent(buildSession()));
  check("armed: the fallback supplies the compaction", Boolean(compactionOf(out)));
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 3 — an abort is not a failure
// ════════════════════════════════════════════════════════════════════════
section("3. aborted compactions never arm the fallback");
{
  const h = await load();
  const calls = installSummarizer();

  await failCompaction(h, 5, { aborted: true });
  check("aborts do not arm", h.notifications.length === 0);
  const out = await h.emit(compactEvent(buildSession()));
  check("aborts leave the hook dormant", out.every((r) => r === undefined) && calls.length === 0);
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 4 — success resets everything
// ════════════════════════════════════════════════════════════════════════
section("4. a successful compaction disarms and resets");
{
  const h = await load();
  installSummarizer();

  await failCompaction(h, 2);
  await h.emit({
    type: "session_compact",
    compactionEntry: { type: "compaction", id: "c1", summary: "s", firstKeptEntryId: "m0", tokensBefore: 10 },
    fromExtension: false,
    reason: "threshold",
    willRetry: false,
  });

  const out = await h.emit(compactEvent(buildSession()));
  check("after success the hook is dormant again", out.every((r) => r === undefined));

  await failCompaction(h, 1);
  const afterOne = await h.emit(compactEvent(buildSession()));
  check("the failure counter restarted (one failure does not arm)", afterOne.every((r) => r === undefined));
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 5 — mechanism A
// ════════════════════════════════════════════════════════════════════════
section("5. mechanism A — chunked fold keeps the host's cut point");
{
  const h = await load({ compactionFallbackChunkTokens: 1024 });
  const calls = installSummarizer();
  await failCompaction(h, 2);

  const entries = buildSession({ count: 4, tokensEach: 1024 });
  const event = compactEvent(entries);
  const compaction = compactionOf(await h.emit(event));

  check("a compaction is returned to the host", Boolean(compaction));
  check(
    "the host's own cut point is kept when the whole span is covered",
    compaction?.firstKeptEntryId === event.preparation.firstKeptEntryId,
  );
  check("tokensBefore is passed through", compaction?.tokensBefore === 4242);
  check("the mechanism is recorded for diagnostics", compaction?.details?.mechanism === "chunked-fold");
  check("the summary is the folded result", compaction?.summary === `summary-${calls.length}`);
  check("the span is covered by more than one bounded request", calls.length > 1, `${calls.length} calls`);
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 6 — chunking and folding order
// ════════════════════════════════════════════════════════════════════════
section("6. chunking folds forward, one request per slice");
{
  const h = await load({ compactionFallbackChunkTokens: 1024 });
  const calls = installSummarizer();
  await failCompaction(h, 2);

  const entries = buildSession({ count: 3, tokensEach: 1024 });
  await h.emit(compactEvent(entries));

  check("three 1024-token messages produce exactly three requests", calls.length === 3, `${calls.length}`);
  check("every request carries exactly one slice", calls.every((call) => call.messages.length === 1));
  check("the first request has no previous summary", calls[0]?.previousSummary === undefined);
  check(
    "each later request folds the running summary forward",
    calls[1]?.previousSummary === "summary-1" && calls[2]?.previousSummary === "summary-2",
  );
  check(
    "no request exceeds the configured slice size",
    calls.every((call) => call.tokens <= 1024),
  );
  check("the model, key and reserve are passed to the host summarizer", calls[0]?.apiKey === "test-key" && calls[0]?.reserveTokens === 16384);
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 6b — the output budget bounds a slice
// ════════════════════════════════════════════════════════════════════════
section("6b. a slice never exceeds the summary output budget");
{
  const h = await load({ maxCompactionFallbackChunks: 1, compactionFallbackChunkTokens: 8192 });
  const calls = installSummarizer();
  await failCompaction(h, 2);

  // The harness model: contextWindow 200000, maxTokens 32000, reserve 16384 →
  // the host asks for min(0.8 * 16384, 32000) = 13107 output tokens. The even
  // share would be 20480 tokens per slice (span / budget); the output budget
  // must win, or the summary of that slice hits the token cap.
  const entries = buildSession({ count: 20, tokensEach: 1024 });
  await h.emit(compactEvent(entries));

  check(
    "no slice is larger than the summary output budget",
    calls.length > 0 && calls.every((call) => call.tokens <= 13107),
    `max ${Math.max(...calls.map((call) => call.tokens))}`,
  );
  check(
    "the slice is still larger than the configured chunk size (the span is covered)",
    calls[0]?.tokens > 8192,
    String(calls[0]?.tokens),
  );
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 7 + 8 + 9 — mechanism B
// ════════════════════════════════════════════════════════════════════════
section("7-9. mechanism B — prefix cut when the span exceeds the chunk budget");
{
  const h = await load({ compactionFallbackChunkTokens: 1024, maxCompactionFallbackChunks: 6 });
  const calls = installSummarizer();
  await failCompaction(h, 2);

  // 10 slices needed, budget of 6 → partial.
  const entries = buildSession({ count: 10, tokensEach: 1024 });
  const event = compactEvent(entries);
  const compaction = compactionOf(await h.emit(event));

  check("a partial compaction is still returned (progress, not a stuck session)", Boolean(compaction));
  check("the mechanism is recorded as a prefix cut", compaction?.details?.mechanism === "prefix-cut");
  // The fold spends the whole budget: every covered message is one the cut may
  // drop, and dropping summarized messages is the only way the context shrinks
  // enough to continue. (Stopping at half the span left the other half verbatim,
  // the context stayed at the limit and the next turn compacted again.)
  check("the fold uses the whole budget", calls.length === 6, `${calls.length} calls`);
  check("the fold never exceeds the chunk budget", calls.length <= 6, `${calls.length} calls`);
  check(
    "the cut point moves forward, away from the host's",
    compaction?.firstKeptEntryId !== event.preparation.firstKeptEntryId,
  );

  const cutIndex = entries.findIndex((entry) => entry.id === compaction?.firstKeptEntryId);
  const cutEntry = entries[cutIndex];
  check("the cut point is a real entry", cutIndex >= 0);
  check(
    "the cut point is legal — never a tool result",
    cutEntry?.message?.role === "user" || cutEntry?.message?.role === "assistant",
    `role=${cutEntry?.message?.role}`,
  );

  // ~50% of the span, measured by size (tokens), not message count.
  const spanTokens = event.preparation.messagesToSummarize.reduce(
    (sum, message) => sum + Math.ceil(message.content[0].text.length / 4),
    0,
  );
  const cutTokens = entries
    .slice(0, cutIndex)
    .flatMap((entry) => sessionEntryToContextMessages(entry))
    .reduce((sum, message) => sum + Math.ceil((message.content?.[0]?.text?.length ?? 0) / 4), 0);
  const share = cutTokens / spanTokens;
  check(
    "the cut lands at ~50% of the span by size",
    share >= 0.4 && share <= 0.6,
    `${(share * 100).toFixed(1)}%`,
  );

  // Coverage: everything the summary saw, plus everything kept, is the whole span.
  const summarized = new Set(calls.flatMap((call) => call.messages.map((message) => message.content[0].text)));
  const kept = new Set(
    entries
      .slice(cutIndex)
      .flatMap((entry) => sessionEntryToContextMessages(entry))
      .map((message) => message.content?.[0]?.text),
  );
  const uncovered = event.preparation.messagesToSummarize.filter(
    (message) => !summarized.has(message.content[0].text) && !kept.has(message.content[0].text),
  );
  check(
    "nothing is discarded that the summary never saw",
    uncovered.length === 0,
    `${uncovered.length} uncovered`,
  );
  clearSummarizer();
}

section("7b. a cut point is never placed on a tool result");
{
  const h = await load({ compactionFallbackChunkTokens: 1024, maxCompactionFallbackChunks: 4 });
  installSummarizer();
  await failCompaction(h, 2);

  const entries = buildSession({ count: 12, tokensEach: 1024, withToolResults: true });
  const compaction = compactionOf(await h.emit(compactEvent(entries)));
  const cutEntry = entries.find((entry) => entry.id === compaction?.firstKeptEntryId);

  check("partial compaction with interleaved tool results still yields a cut", Boolean(cutEntry));
  check(
    "the cut is on a message, not on the tool result that answers a tool call",
    cutEntry?.message?.role !== "toolResult",
    `role=${cutEntry?.message?.role}`,
  );
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 10 — provider failure: no retry, but the session still continues
// ════════════════════════════════════════════════════════════════════════
section("10. a failing summarizer is not retried — and the session still continues");
{
  const h = await load({ compactionFallbackChunkTokens: 1024 });
  const calls = installSummarizer(() => {
    throw new Error("provider exploded");
  });
  await failCompaction(h, 2);
  const before = h.notifications.length;

  const entries = buildSession({ count: 5, tokensEach: 1024 });
  const event = compactEvent(entries);
  const out = await h.emit(event);
  const compaction = compactionOf(out);

  check("the failure is not retried across slices", calls.length === 1, `${calls.length} calls`);
  check("a compaction is still returned (the session can continue)", Boolean(compaction));
  check(
    "the mechanism is recorded as a drop-only compaction",
    compaction?.details?.mechanism === "drop-only",
    String(compaction?.details?.mechanism),
  );
  check(
    "the cut point moves forward, away from the host's",
    compaction?.firstKeptEntryId !== event.preparation.firstKeptEntryId,
  );
  check(
    "the summary says the earlier context was dropped, not summarized",
    /could not be summarized/.test(compaction?.summary ?? "") &&
      /dropped without a summary/.test(compaction?.summary ?? ""),
  );
  check("exactly one message is shown", h.notifications.length - before === 1, `${h.notifications.length - before}`);
  check(
    "the message says what happened and that the session can continue",
    /could not summarize/.test(h.notifications.at(-1)?.message ?? "") &&
      /dropped the oldest part/.test(h.notifications.at(-1)?.message ?? "") &&
      h.notifications.at(-1)?.type === "warning",
  );
  clearSummarizer();
}

section("10a. compactionFallbackDropOnly:false — the failure is reported, not destructive");
{
  const h = await load({ compactionFallbackChunkTokens: 1024, compactionFallbackDropOnly: false });
  const calls = installSummarizer(() => {
    throw new Error("provider exploded");
  });
  await failCompaction(h, 2);
  const before = h.notifications.length;

  const out = await h.emit(compactEvent(buildSession({ count: 5, tokensEach: 1024 })));

  check("no compaction is returned (the host path is left alone)", out.every((r) => r === undefined));
  check("the failure is still not retried", calls.length === 1, `${calls.length} calls`);
  check("exactly one message is shown", h.notifications.length - before === 1, `${h.notifications.length - before}`);
  check(
    "the message says what happened and what to do",
    /could not summarize/.test(h.notifications.at(-1)?.message ?? "") &&
      /\/compact/.test(h.notifications.at(-1)?.message ?? "") &&
      h.notifications.at(-1)?.type === "error",
  );
  clearSummarizer();
}

section("10b. a slice failing partway still yields a partial compaction");
{
  const h = await load({ compactionFallbackChunkTokens: 1024, maxCompactionFallbackChunks: 6 });
  // Slice 1 succeeds; slice 2 hits the output token cap (the exact host error:
  // stopReason "length" — the summary is incomplete).
  const calls = installSummarizer((_record, n) => {
    if (n === 2) {
      throw new Error(
        "Summarization failed: generation hit the token cap and the summary is incomplete",
      );
    }
    return { text: `summary-${n}`, usage: usageOf(100, 20) };
  });
  await failCompaction(h, 2);

  const entries = buildSession({ count: 5, tokensEach: 1024 });
  const event = compactEvent(entries);
  const compaction = compactionOf(await h.emit(event));

  check("a partial compaction is still returned (progress, not a stuck session)", Boolean(compaction));
  check("the mechanism is recorded as a prefix cut", compaction?.details?.mechanism === "prefix-cut");
  check("the fold stopped at the failing slice (fail fast)", calls.length === 2, `${calls.length} calls`);
  check("the summary covers the successful prefix", compaction?.summary === "summary-1");
  check(
    "the cut point moves forward, away from the host's",
    compaction?.firstKeptEntryId !== event.preparation.firstKeptEntryId,
  );
  check(
    "no operator error about a stuck session",
    !h.notifications.some((n) => /may not be able to continue/.test(n.message)),
  );
  clearSummarizer();
}

section("10c. a slice too large for one request is split and retried");
{
  const h = await load({ compactionFallbackChunkTokens: 8192 });
  // The first slice hits the output token cap; the two halves succeed. This is
  // the exact failure shape the user hit: the summary of the slice is
  // incomplete, but the context itself is fine to summarize in smaller parts.
  const calls = installSummarizer((_record, n) => {
    if (n === 1) {
      throw new Error(
        "Summarization failed: generation hit the token cap and the summary is incomplete",
      );
    }
    return { text: `summary-${n}`, usage: usageOf(100, 20) };
  });
  await failCompaction(h, 2);

  // Four 2048-token messages = one 8192-token slice.
  const entries = buildSession({ count: 4, tokensEach: 2048 });
  const event = compactEvent(entries);
  const compaction = compactionOf(await h.emit(event));

  check("the compaction succeeds after the split", Boolean(compaction));
  check(
    "the whole span is covered as one slice (mechanism A)",
    compaction?.details?.mechanism === "chunked-fold" && compaction?.details?.chunks === 1,
    `${compaction?.details?.mechanism}/${compaction?.details?.chunks}`,
  );
  check("the slice became two requests after the failure", calls.length === 3, `${calls.length} calls`);
  check(
    "the halves are smaller than the original slice",
    calls[1]?.tokens < 8192 && calls[2]?.tokens < 8192,
    `${calls[1]?.tokens}/${calls[2]?.tokens}`,
  );
  check(
    "the second half folds the first half's summary forward",
    calls[2]?.previousSummary === "summary-2",
    String(calls[2]?.previousSummary),
  );
  check("the summary is the folded result", compaction?.summary === "summary-3");
  check(
    "the provider requests are counted for diagnostics",
    compaction?.details?.requests === 3,
    String(compaction?.details?.requests),
  );
  check(
    "the host's own cut point is kept (nothing extra dropped)",
    compaction?.firstKeptEntryId === event.preparation.firstKeptEntryId,
  );
  clearSummarizer();
}

section("10d. when even a split slice hits the cap, the oldest content is dropped");
{
  const h = await load({ compactionFallbackChunkTokens: 8192 });
  const calls = installSummarizer(() => {
    throw new Error(
      "Summarization failed: generation hit the token cap and the summary is incomplete",
    );
  });
  await failCompaction(h, 2);

  const entries = buildSession({ count: 4, tokensEach: 2048 });
  const event = compactEvent(entries);
  const compaction = compactionOf(await h.emit(event));

  check("a compaction is still returned (the session can continue)", Boolean(compaction));
  check(
    "the mechanism is recorded as a drop-only compaction",
    compaction?.details?.mechanism === "drop-only",
    String(compaction?.details?.mechanism),
  );
  check(
    "the cut point moves forward, away from the host's",
    compaction?.firstKeptEntryId !== event.preparation.firstKeptEntryId,
  );
  check(
    "the split attempts are bounded (no request loop)",
    calls.length >= 2 && calls.length <= 15,
    `${calls.length} calls`,
  );
  check(
    "the operator is warned about the drop",
    h.notifications.at(-1)?.type === "warning" &&
      /dropped the oldest part/.test(h.notifications.at(-1)?.message ?? ""),
  );
  check(
    "no 'could not summarize' dead-end is raised",
    !h.notifications.some((n) => /may not be able to continue/.test(n.message)),
  );
  clearSummarizer();
}

section("10e. an aborted compaction never drops content");
{
  const h = await load({ compactionFallbackChunkTokens: 1024 });
  installSummarizer(() => {
    throw new Error(
      "Summarization failed: generation hit the token cap and the summary is incomplete",
    );
  });
  await failCompaction(h, 2);

  const event = compactEvent(buildSession({ count: 5, tokensEach: 1024 }));
  const controller = new AbortController();
  controller.abort();
  event.signal = controller.signal;
  const out = await h.emit(event);

  check("no compaction is supplied for an aborted run", out.every((r) => r === undefined));
  clearSummarizer();
}

section("10f. the tail is protected — cut into only for the fit, and then summarized");
{
  // Pi's firstKeptEntryId is the boundary of the last keepRecentTokens: from
  // there on, messages are kept verbatim. Mechanisms A and B keep that
  // boundary; only the fit guarantee may move the cut past it (a context that
  // still overflows after the compaction is the loop this fallback exists to
  // break), and whatever it moves past is summarized by one more request —
  // dropping messages unsummarized is the one thing this fallback must never do.
  const entries = buildSession({ count: 8, tokensEach: 2048, tail: 3 });
  const event = compactEvent(entries);
  const hostCutIndex = entries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
  const tailTexts = new Set(
    entries
      .slice(hostCutIndex)
      .flatMap((entry) => sessionEntryToContextMessages(entry))
      .map((message) => message.content?.[0]?.text),
  );
  const summarizedTexts = (calls) =>
    new Set(calls.flatMap((call) => call.messages.map((message) => message.content[0].text)));

  // Mechanism A — the host's cut point is kept.
  {
    const h = await load({ compactionFallbackChunkTokens: 16384, maxCompactionFallbackChunks: 6 });
    const calls = installSummarizer();
    await failCompaction(h, 2);
    const compaction = compactionOf(await h.emit(event));
    check(
      "A: the host's cut point is kept",
      compaction?.firstKeptEntryId === event.preparation.firstKeptEntryId,
    );
    check(
      "A: no tail message is ever summarized",
      [...tailTexts].every((text) => !summarizedTexts(calls).has(text)),
    );
    clearSummarizer();
  }

  // Mechanism B — the cut moves to the deepest point the fold covered, and the
  // fit budget can push it further: a small context window forces the prefix cut
  // (the capacity binds, so the span needs more slices than the budget allows),
  // and when the covered prefix alone cannot bring the context under the limit
  // the cut moves past Pi's tail boundary. The messages it then drops are
  // summarized by one more request — dropping them unsummarized is the one thing
  // this fallback must never do.
  {
    const h = await load({ compactionFallbackChunkTokens: 1024, maxCompactionFallbackChunks: 4 });
    const calls = installSummarizer();
    await failCompaction(h, 2);
    const compaction = compactionOf(
      await h.emit(event, { model: { id: "small", provider: "test", contextWindow: 4096, maxTokens: 32000 } }),
    );
    const cutIndex = entries.findIndex((entry) => entry.id === compaction?.firstKeptEntryId);
    check(
      "B: the mechanism is a prefix cut",
      compaction?.details?.mechanism === "prefix-cut",
      String(compaction?.details?.mechanism),
    );
    check(
      "B: the cut moves forward, never back to the span start",
      cutIndex > 0,
      `cut=${cutIndex}`,
    );
    check(
      "B: everything the cut drops was summarized",
      uncoveredOf(entries, compaction, calls).length === 0,
      `${uncoveredOf(entries, compaction, calls).length} uncovered`,
    );
    clearSummarizer();
  }

  // Mechanism C — drop-only keeps everything from the cut on.
  {
    const h = await load({ compactionFallbackChunkTokens: 1024 });
    installSummarizer(() => {
      throw new Error("provider exploded");
    });
    await failCompaction(h, 2);
    const compaction = compactionOf(await h.emit(event));
    const cutIndex = entries.findIndex((entry) => entry.id === compaction?.firstKeptEntryId);
    check(
      "C: the cut stays before the host's tail boundary",
      cutIndex >= 0 && cutIndex < hostCutIndex,
      `cut=${cutIndex} host=${hostCutIndex}`,
    );
    check(
      "C: the kept tail is intact in the branch after the cut",
      entries.slice(hostCutIndex).length === 3 &&
        entries.slice(cutIndex).length > entries.slice(hostCutIndex).length,
    );
    clearSummarizer();
  }
}

// ════════════════════════════════════════════════════════════════════════
// 11 — attempt cap
// ════════════════════════════════════════════════════════════════════════
section("11. the attempt budget bounds the cost");
{
  const h = await load({ maxCompactionFallbackAttempts: 3 });
  installSummarizer();

  const attempts = [];
  await failCompaction(h, 2); // arm
  attempts.push(compactionOf(await h.emit(compactEvent(buildSession()))));
  for (let i = 0; i < 3; i++) {
    await failCompaction(h, 1);
    attempts.push(compactionOf(await h.emit(compactEvent(buildSession()))));
  }

  check(
    "the first three attempts supply a compaction",
    attempts.slice(0, 3).every((compaction) => Boolean(compaction)),
  );
  check("the fourth attempt is refused", !attempts[3]);
  check(
    "the operator is told that recovery stopped",
    /Stopping automatic recovery/.test(h.notifications.at(-1)?.message ?? "") &&
      h.notifications.at(-1)?.type === "error",
  );

  await failCompaction(h, 1);
  const afterExhaustion = await h.emit(compactEvent(buildSession()));
  check("it stays refused — no loop", afterExhaustion.every((r) => r === undefined));
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 12 — the kill switch
// ════════════════════════════════════════════════════════════════════════
section("12. compactionFallback:false is a hard off switch");
{
  const h = await load({ compactionFallback: false });
  const calls = installSummarizer();

  await failCompaction(h, 5);
  const out = await h.emit(compactEvent(buildSession()));

  check("no arming message", h.notifications.length === 0);
  check("no summarizer call", calls.length === 0);
  check("no compaction supplied", out.every((r) => r === undefined));
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 13 — split turns
// ════════════════════════════════════════════════════════════════════════
section("13. split turn — the turn prefix is folded and merged");
{
  const h = await load({ compactionFallbackChunkTokens: 1024 });
  const calls = installSummarizer();
  await failCompaction(h, 2);

  const entries = buildSession({ count: 2, tokensEach: 1024 });
  const event = compactEvent(entries, {
    isSplitTurn: true,
    turnPrefixMessages: [
      { role: "user", content: [{ type: "text", text: "y".repeat(2048) }], timestamp: 1 },
    ],
  });
  const compaction = compactionOf(await h.emit(event));

  check("history and turn prefix each get their own request", calls.length === 3, `${calls.length}`);
  check(
    "the turn prefix is summarized with the split-turn instruction",
    /PREFIX of a turn/.test(calls.at(-1)?.customInstructions ?? ""),
  );
  check(
    "the two summaries are merged the way Pi merges them",
    (compaction?.summary ?? "").includes("**Turn Context (split turn):**"),
  );
  check("the merged summary keeps both halves", (compaction?.summary ?? "").startsWith("summary-2"));
  clearSummarizer();
}

// ---------------------------------------------------------------------------
section("13c. split turn — a failed prefix summary keeps the prefix verbatim");
{
  const h = await load({ compactionFallbackChunkTokens: 1024 });
  const calls = installSummarizer((record, n) => {
    if (/PREFIX of a turn/.test(record.customInstructions ?? "")) {
      throw new Error("prefix summarization rejected");
    }
    return { text: `summary-${n}`, usage: usageOf(100, 20) };
  });
  await failCompaction(h, 2);

  const entries = buildSession({ count: 2, tokensEach: 1024 });
  const event = compactEvent(entries, {
    isSplitTurn: true,
    turnPrefixMessages: [
      { role: "user", content: [{ type: "text", text: "y".repeat(2048) }], timestamp: 1 },
    ],
  });
  const compaction = compactionOf(await h.emit(event));

  // A prefix-summary failure must not fail the whole fallback: the fold is
  // simply incomplete, so the cut stays before the prefix and those messages
  // are kept verbatim instead of being dropped.
  check("the fallback still supplies a compaction", !!compaction, `${compaction?.summary?.slice(0, 20)}`);
  check("no merge marker is emitted for the unsummarized prefix", !(compaction?.summary ?? "").includes("**Turn Context (split turn):**"));
  check(
    "the cut stays inside the summarized history, not at the host's cut",
    (compaction?.firstKeptEntryId ?? "").startsWith("m"),
    `${compaction?.firstKeptEntryId}`,
  );
  check(
    "nothing is dropped without being summarized",
    uncoveredOf(entries, compaction, calls).length === 0,
    `${uncoveredOf(entries, compaction, calls).length}`,
  );
  clearSummarizer();
}

section("13b. a partial compaction never cuts into a split-turn prefix");
{
  const h = await load({ compactionFallbackChunkTokens: 1024, maxCompactionFallbackChunks: 2 });
  installSummarizer();
  await failCompaction(h, 2);

  // history (4 x 1024) + a turn prefix (1 x 1024) + the kept tail. The host
  // summarizes the history, keeps the tail, and folds the prefix separately —
  // the fold under test only ever saw the history.
  const history = [];
  for (let i = 0; i < 4; i++) {
    history.push(messageEntry(`m${i}`, i % 2 === 0 ? "user" : "assistant", 1024));
  }
  const prefixEntry = messageEntry("p0", "user", 1024);
  const tail = messageEntry("k0", "assistant", 128);
  const entries = [...history, prefixEntry, tail];
  const event = compactEvent(entries, {
    isSplitTurn: true,
    messagesToSummarize: history.map((entry) => entry.message),
    turnPrefixMessages: [prefixEntry.message],
  });
  const compaction = compactionOf(await h.emit(event));

  check("a partial compaction is still produced", Boolean(compaction));
  check(
    "the mechanism is a prefix cut",
    compaction?.details?.mechanism === "prefix-cut",
    String(compaction?.details?.mechanism),
  );
  const cutIndex = entries.findIndex((entry) => entry.id === compaction?.firstKeptEntryId);
  const prefixIndex = entries.findIndex((entry) => entry.id === "p0");
  check(
    "the cut stays inside the summarized history, never the turn prefix",
    cutIndex >= 0 && cutIndex < prefixIndex,
    `cut=${cutIndex} prefix=${prefixIndex}`,
  );
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 14 — usage
// ════════════════════════════════════════════════════════════════════════
section("14. provider usage is reported on the compaction entry");
{
  const h = await load({ compactionFallbackChunkTokens: 1024 });
  installSummarizer((call, n) => ({ text: `s${n}`, usage: usageOf(1000 * n, 100) }));
  await failCompaction(h, 2);

  const compaction = compactionOf(await h.emit(compactEvent(buildSession({ count: 3, tokensEach: 1024 }))));

  check("input tokens are summed across the fold", compaction?.usage?.input === 6000, `${compaction?.usage?.input}`);
  check("output tokens are summed across the fold", compaction?.usage?.output === 300, `${compaction?.usage?.output}`);
  check("totalTokens is summed too", compaction?.usage?.totalTokens === 6300);
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 15 — config parsing
// ════════════════════════════════════════════════════════════════════════
section("15. configuration is read, and garbage is ignored");
{
  const one = await load({ compactionFallbackAfterFailures: 1 });
  installSummarizer();
  await failCompaction(one, 1);
  const armedAfterOne = compactionOf(await one.emit(compactEvent(buildSession())));
  check("compactionFallbackAfterFailures is honoured", Boolean(armedAfterOne));
  clearSummarizer();

  const garbage = await load({
    compactionFallbackAfterFailures: "nonsense",
    compactionFallbackChunkTokens: -5,
    maxCompactionFallbackChunks: null,
    compactionFallbackModel: "   ",
  });
  const garbageCalls = installSummarizer();
  await failCompaction(garbage, 1);
  const notYet = await garbage.emit(compactEvent(buildSession()));
  check("a malformed failure threshold falls back to the default (2)", notYet.every((r) => r === undefined));
  await failCompaction(garbage, 1);
  const nowArmed = await garbage.emit(compactEvent(buildSession({ count: 3, tokensEach: 1024 })));
  check("garbage values do not disable the fallback", Boolean(compactionOf(nowArmed)));
  check(
    "a blank model reference means 'use the session model'",
    garbageCalls[0]?.model?.id === "test-model",
    String(garbageCalls[0]?.model?.id),
  );
  clearSummarizer();

  // A chunk budget only binds when the window cannot hold an even share of the
  // span — otherwise the adaptive sizing covers the whole span in one go.
  const tiny = await load({ compactionFallbackChunkTokens: 1024, maxCompactionFallbackChunks: 2 });
  installSummarizer();
  await failCompaction(tiny, 2);
  const capped = compactionOf(
    await tiny.emit(compactEvent(buildSession({ count: 4, tokensEach: 1024 })), {
      model: { id: "small", provider: "test", contextWindow: 4096, maxTokens: 32000 },
    }),
  );
  check(
    "maxCompactionFallbackChunks is honoured",
    capped?.details?.mechanism === "prefix-cut",
    String(capped?.details?.mechanism),
  );
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 16 — compactionFallbackModel
// ════════════════════════════════════════════════════════════════════════
section("16. compactionFallbackModel selects the summarization model");
{
  const h = await load({ compactionFallbackModel: "other/model-x" });
  const calls = installSummarizer();
  await failCompaction(h, 2);

  const other = { id: "model-x", provider: "other", contextWindow: 200000, maxTokens: 32000 };
  await h.emit(compactEvent(buildSession()), {
    modelRegistry: {
      getAll: () => [other],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
  });

  check("the configured model is used", calls[0]?.model === other, `${calls[0]?.model?.provider}/${calls[0]?.model?.id}`);
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 17 — ownership: no self-triggered compaction, one result per event
// ════════════════════════════════════════════════════════════════════════
section("17. ownership — no ctx.compact(), one compaction per event");
{
  const h = await load();
  installSummarizer();
  await failCompaction(h, 3);

  check("the fallback never triggers a compaction itself", h.compacted.length === 0);

  const out = await h.emit(compactEvent(buildSession()));
  check("one event yields exactly one compaction", out.filter((r) => r && r.compaction).length === 1);
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 18 — re-entrancy
// ════════════════════════════════════════════════════════════════════════
section("18. the fallback cannot re-enter itself");
{
  const h = await load({ compactionFallbackChunkTokens: 1024 });
  let nested;
  installSummarizer(async () => {
    // A compaction event arriving while we are still summarizing must not start
    // a second fold on top of this one.
    const inner = await h.emit(compactEvent(buildSession()));
    nested = inner;
    return { text: "outer", usage: usageOf(1, 1) };
  });
  await failCompaction(h, 2);

  const out = await h.emit(compactEvent(buildSession({ count: 2, tokensEach: 1024 })));
  check("the nested event is refused", nested.every((r) => r === undefined));
  check("the outer fold still completes", Boolean(compactionOf(out)));
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 19 — replace, never stack
// ════════════════════════════════════════════════════════════════════════
section("19. the new summary replaces the previous one (never stacks)");
{
  // A previous fallback compaction cut early (fk=m6), so its summary sits in
  // the path BEFORE the host's cut. The next fallback must cut AFTER that
  // compaction entry: otherwise the old summary stays in the context and the
  // new one is appended next to it — the context grows by a whole summary and
  // the next turn overflows again (the compaction loop).
  const entries = [];
  for (let i = 0; i < 12; i++) {
    entries.push(messageEntry(`m${i}`, i % 2 === 0 ? "user" : "assistant", 1024));
  }
  const prevKept = entries.findIndex((entry) => entry.id === "m6");
  entries.push({
    type: "compaction",
    id: "c-prev",
    parentId: entries[prevKept - 1].id,
    timestamp: 1,
    summary: "P".repeat(4000),
    firstKeptEntryId: "m6",
    tokensBefore: 999,
    details: { source: "pi-vigilant-compaction-fallback", mechanism: "prefix-cut" },
  });
  for (let i = 0; i < 2; i++) entries.push(messageEntry(`k${i}`, "assistant", 128));

  const cutIndex = entries.findIndex((entry) => entry.id === "k0");
  const messagesToSummarize = [];
  for (let i = prevKept; i < cutIndex; i++) {
    const [first] = sessionEntryToContextMessages(entries[i]);
    if (first) messagesToSummarize.push(first);
  }
  const event = {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "k0",
      messagesToSummarize,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 4242,
      previousSummary: undefined,
      fileOps: {},
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    },
    branchEntries: entries,
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  };

  const h = await load({ compactionFallbackChunkTokens: 1024, maxCompactionFallbackChunks: 6 });
  const calls = installSummarizer();
  await failCompaction(h, 2);
  const compaction = compactionOf(await h.emit(event));
  const newCutIndex = entries.findIndex((entry) => entry.id === compaction?.firstKeptEntryId);
  const prevCompIndex = entries.findIndex((entry) => entry.id === "c-prev");

  check("a compaction is returned", Boolean(compaction));
  check(
    "the cut is after the previous compaction entry",
    newCutIndex > prevCompIndex,
    `cut=${newCutIndex} prevComp=${prevCompIndex}`,
  );
  check(
    "everything the cut drops was summarized",
    uncoveredOf(entries, compaction, calls).length === 0,
    `${uncoveredOf(entries, compaction, calls).length} uncovered`,
  );

  // The post-compaction context renders exactly one compaction summary.
  const after = [
    ...entries,
    {
      type: "compaction",
      id: "c-new",
      parentId: entries[entries.length - 1].id,
      timestamp: 2,
      summary: compaction.summary,
      firstKeptEntryId: compaction.firstKeptEntryId,
      tokensBefore: compaction.tokensBefore,
      details: compaction.details,
    },
  ];
  const context = buildContextEntries(after, "c-new");
  const summaries = context.filter((entry) => entry.type === "compaction");
  check(
    "the context holds exactly one compaction summary",
    summaries.length === 1 && summaries[0].id === "c-new",
    `${summaries.map((entry) => entry.id).join(",")}`,
  );
  const beforeEst = contextEstimate(entries);
  const afterEst = contextEstimate(after);
  check(
    "the context actually shrank",
    afterEst < beforeEst,
    `${afterEst} < ${beforeEst}`,
  );
  clearSummarizer();
}

// ════════════════════════════════════════════════════════════════════════
// 20 — the fit guarantee
// ════════════════════════════════════════════════════════════════════════
section("20. the post-compaction context fits the real prompt limit");
{
  // The session is exhausted: tokensBefore is close to the real limit, so the
  // measured ratio is high and the fit budget is tight. The fallback must cut
  // deep enough that the conservative estimate of the post-compaction context
  // stays under the limit — otherwise the retry is rejected again and the
  // session dead-ends (the exact failure this fallback exists to prevent).
  const entries = buildSession({ count: 10, tokensEach: 1024 });
  const event = compactEvent(entries, {
    tokensBefore: 160000,
  });

  const h = await load({ compactionFallbackChunkTokens: 1024, maxCompactionFallbackChunks: 6 });
  const calls = installSummarizer();
  await failCompaction(h, 2);
  const compaction = compactionOf(
    await h.emit(event, {
      model: { id: "big", provider: "test", contextWindow: 168000, maxTokens: 32000 },
    }),
  );

  check("a compaction is returned", Boolean(compaction));
  const details = compaction?.details ?? {};
  const summaryTokens = Math.ceil((compaction?.summary ?? "").length / 4);
  const conservative = (details.suffixTokens ?? 0) + summaryTokens;
  check(
    "the conservative post-context fits the limit",
    conservative * (details.fitRatio ?? 1) <= (details.fitLimitTokens ?? 0) + 1,
    `${conservative} * ${details.fitRatio} <= ${details.fitLimitTokens}`,
  );
  check(
    "everything the cut drops was summarized",
    uncoveredOf(entries, compaction, calls).length === 0,
    `${uncoveredOf(entries, compaction, calls).length} uncovered`,
  );
  check(
    "the fit ratio is conservative (never below the floor)",
    (details.fitRatio ?? 0) >= 1.75,
    String(details.fitRatio),
  );
  clearSummarizer();
}

// ── Summary ─────────────────────────────────────────────────────────────
for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });

const passed = results.filter((r) => r.cond).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) {
  console.log("\nFailures:");
  for (const r of results.filter((x) => !x.cond)) console.log(`  - ${r.name}`);
  process.exit(1);
}
