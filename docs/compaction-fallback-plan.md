# PLAN — Compaction fallback ("a session can never get permanently stuck")

Status: **awaiting approval** (ASF LARGE-work gate)
Requirement: `spc-1789136261640-11491`
Scope: `pi-vigilant` (extension), new subsystem. Not yet implemented.

---

## 1. The requirement, as stated

> When automatic compaction keeps failing, pi-vigilant must fall back to its own
> compactor: take the first ~50% of the messages to be compacted (by size),
> summarize that slice via a subagent, replace those messages in the canonical
> session with the subcompacted result, then call compaction again — repeating
> until compaction succeeds, so a session can never get permanently stuck.
> "Better than a stuck session" — diminished fidelity is acceptable.

---

## 2. Feasibility findings (verified against pi 0.84.2)

These are the facts the design has to live with. Each was checked in the
installed `@earendil-works/pi-coding-agent` dist, not assumed.

**F1 — The session is append-only; "replace those messages in the canonical
session" is not implementable through the supported API.**
`ExtensionContext.sessionManager` is a `ReadonlySessionManager`
(`core/extensions/types.d.ts:219`). Its complete method surface is
`appendMessage / appendCompaction / appendCustomEntry / appendCustomMessageEntry /
appendThinkingLevelChange / appendModelChange / appendSessionInfo /
appendLabelChange / branch / branchWithSummary / createBranchedSession /
buildContextEntries / buildSessionContext / getEntries / getTree / …` — there is
no replace, delete, truncate, splice, or rewrite. The source says so explicitly
(`core/session-manager.d.ts:97`): *"change the leaf pointer. Entries cannot be
modified or deleted."* The only rewrite is the private `_rewriteFile`, used for
migrations.

Rewriting the session JSONL directly would desync the live `SessionManager`
(its entry list and leaf pointer would no longer match the file) and is
unsupported. **Rejected.**

**F2 — The supported equivalent of "replace messages with a summary" is a
`CompactionEntry` supplied from `session_before_compact`.**
`SessionBeforeCompactEvent` carries `preparation` (`messagesToSummarize`,
`firstKeptEntryId`, `tokensBefore`, `previousSummary`, `isSplitTurn`,
`turnPrefixMessages`, `settings`), `branchEntries`, `reason`, `willRetry`,
`signal`. A handler may return
`{ compaction: { summary, firstKeptEntryId, tokensBefore, usage?, details? } }`,
in which case the host uses that summary and does **not** run its own
summarization (`docs/compaction.md`). The rebuilt context is
`[summary] + [messages from firstKeptEntryId onward]` — i.e. the summarized span
*is* replaced by the summary. This is the sanctioned primitive.

**F3 — The failure signal exists.** `session_compact_failed` fires on
failure/abort with `{ reason, errorMessage?, aborted, willRetry, fromExtension }`
(`core/extensions/types.d.ts:464`).

**F4 — The extension can summarize with the session's own model and auth.**
`ctx.modelRegistry.getApiKeyAndHeaders(model)` and
`ctx.modelRegistry.complete(model, context, options)` are first-class
(`core/model-registry.d.ts:30,33`). `generateSummaryWithUsage()` and
`serializeConversation()` are exported from the package root if we prefer the
host's own prompt/serialization. No subagent process is required for a bounded
summarization call.

**F5 — `pi-safe-compact` (v0.4.0, installed) already implements most of this.**
It hooks `session_before_compact`, has `summarizeWithRetry()` which *shrinks the
summarization input* (drops older messages) until the call fits, an agentic
subagent summarizer via `createAgentSession` + a `write_summary` tool, a
3-stop breaker, and context-starvation warnings. Duplicating it wholesale would
give the user two compactors racing on the same hook. The length-loop fix doc
already flags this (Appendix C): *"the two extensions should agree on one owner
for context-pressure compaction."*

---

## 3. What actually goes wrong when "compaction keeps failing"

Ranked by likelihood, because the design must target the real cause:

| # | Cause | Current behaviour | Our fallback can fix it? |
|---|---|---|---|
| 1 | The **summarization request itself is too large** (it re-sends the span being summarized, plus the previous summary, against the same window) | Fails; retried identically; fails again → stuck | **Yes** — bound the request size |
| 2 | Provider error/timeout/rate limit on the summary call | Fails; may succeed later | Partly — bounded retries with backoff |
| 3 | Provider entirely unreachable | Nothing can summarize | **No** — must fail cleanly, never loop |
| 4 | Session too large to even rebuild | Host-level | No |

Cause 1 is the one the requirement is really about, and the one where "summarize
a 50% slice" is the correct instinct: it makes each request smaller.

---

## 4. Proposed design

Two mechanisms, both delivered through `session_before_compact` (F2), armed only
after repeated failures (F3).

### 4.1 Trigger policy

- Count consecutive `session_compact_failed` events where `aborted === false`.
- Reset the counter on `session_compact` success.
- When the count reaches `compactionFallbackAfterFailures` (default **2**), arm
  the fallback and notify the operator once.
- `fromExtension === true` failures count too (our own attempt failed).
- Bounded attempts per session: `maxCompactionFallbackAttempts` (default **3**).
  When exhausted, stop and tell the operator plainly; never loop.

### 4.2 Mechanism A — chunked-fold summarization (primary)

Inside `session_before_compact`, when armed:

1. Split `preparation.messagesToSummarize` into slices whose serialized size
   fits `compactionFallbackChunkTokens` (default: half of `reserveTokens`,
   floor 8k) — measured with the host's `estimateTokens`/`serializeConversation`
   so the accounting matches pi's.
2. Summarize slice 1 → `S1`. Summarize slice 2 with `previousSummary: S1` → `S2`.
   … folding forward until the span is covered.
3. Return `{ compaction: { summary: Sn, firstKeptEntryId:
   preparation.firstKeptEntryId, tokensBefore, usage } }`.

Every LLM request is bounded, so cause 1 is removed. Coverage is complete (no
message is dropped unsummarized). Cost: N calls instead of 1, bounded by
`maxCompactionFallbackChunks` (default 6).

For a split turn, `turnPrefixMessages` is folded the same way and merged, as pi
itself does.

### 4.3 Mechanism B — halved-span compaction (last resort, the literal request)

If even a single bounded slice fails (provider refusing small requests), fall
back to the requirement's own shape, expressed in the supported primitive:

1. Pick the midpoint of the span and resolve it to a **valid cut point** entry id
   from `event.branchEntries` (user/assistant/custom message — never a tool
   result, per the cut-point rules in `docs/compaction.md`).
2. Summarize the first half (bounded chunks) → `S`.
3. Return `{ compaction: { summary: S, firstKeptEntryId: <midpoint>, … } }`.

Effect: the first half is replaced by a summary; the second half stays verbatim
as messages. That is the requirement's "take the first ~50%, compact that slice,
replace those messages with the subcompacted result" — but in **one** compaction
round instead of "then call compaction again", because the primitive already
does the replacement. If the second half is still too large, the next round
halves again; depth is bounded, so it terminates.

Fidelity is deliberately lower and the operator is told so. This is the "better
than a stuck session" path.

### 4.4 Subagent question — needs your decision

The requirement says "via a subagent". Three readings, with my recommendation:

| Option | What it is | Cost | Recommendation |
|---|---|---|---|
| **(i) Direct bounded call** | `ctx.modelRegistry.complete()` with the session's model | cheapest, no new process | **primary** |
| (ii) In-process agentic subagent | `createAgentSession` + `write_summary` tool (pi-safe-compact's pattern) | a second agent loop + tokens | optional mode |
| (iii) `pi -p` subprocess | ASF's delegation definition | heaviest; needs `pi` on PATH; fails in restricted environments | not recommended |

Note that the failure being defended against is *request size*, not summary
quality. A subagent does not make the request smaller — chunking does. So (i)
carries the guarantee, and (ii) can be an opt-in quality upgrade. **Your call.**

### 4.5 Ownership vs `pi-safe-compact` (F5)

- Dormant by default: our fallback only arms after `session_compact_failed`
  events. If pi-safe-compact (or the host) compacts successfully, we never
  engage — no double summarization in the happy path.
- Config `compactionFallback` (default **true**) to disable outright when the
  user prefers pi-safe-compact as the sole owner.
- We do **not** call `ctx.compact()` ourselves from `session_compact_failed`;
  we let the host's existing retry/overflow path re-enter
  `session_before_compact`. This avoids two extensions triggering compactions
  against each other.
- Document the recommended pairing in the README.

### 4.6 New config

```jsonc
"compactionFallback": true,                 // master switch
"compactionFallbackAfterFailures": 2,       // consecutive failures before arming
"maxCompactionFallbackAttempts": 3,         // per session, then stop and warn
"compactionFallbackChunkTokens": 8192,      // max size of one summarization request
"maxCompactionFallbackChunks": 6            // max calls per compaction
```

---

## 5. Adversarial analysis

| # | Failure mode | Mitigation |
|---|---|---|
| A1 | Infinite compaction loop (fallback triggers fallback) | Attempt counter per session; hard stop + operator message; no self-triggered `ctx.compact()` |
| A2 | Two compactors race (pi-safe-compact) | Dormant-until-failure policy; config kill switch; documented single-owner option |
| A3 | Provider down → every chunk fails → N×cost, then stuck | Fail fast on the first chunk error, do not iterate; explicit "compaction could not run, provider unreachable" message |
| A4 | `firstKeptEntryId` is not a valid cut point → corrupt compaction | Validate against `branchEntries`; fall back to the host's proposed id |
| A5 | Fidelity silently degraded | Operator notification on every fallback compaction, naming the mechanism used |
| A6 | Cost blow-up (6 chunks × long spans) | Chunk count cap; chunk size cap; usage recorded in the `CompactionEntry` |
| A7 | `willRetry`/overflow path expects a *smaller* context; a half-span compaction may not shrink enough | Verify the post-compaction size; if still over the threshold, allow the next round (bounded) |
| A8 | Recursion inside our own summarizer (summary of summary) | Fold prompt is a fixed template, never re-summarized |
| A9 | Aborted compaction (user pressed stop) counts as a failure and arms the fallback | `aborted === true` does not increment the counter |
| A10 | Interacts with the new context-pressure compaction from the length fix | Both are `ctx.compact()` callers; the length fix keeps its own cap/cooldown, and this subsystem only supplies summaries — one owner per path, documented |

---

## 6. Test plan (test-first)

Unit (harness, no network):
1. Failure counter: 1 failure → not armed; 2 → armed + notified; success resets.
2. Aborted failure does not arm.
3. Armed + `session_before_compact` → returns a compaction with our summary and
   the host's `firstKeptEntryId` (mechanism A).
4. Chunking: a span that serializes to 3× the chunk cap → exactly 3 summarizer
   calls, folded in order, `previousSummary` threaded.
5. Chunk cap: a span requiring more than `maxCompactionFallbackChunks` → stops
   at the cap and warns.
6. Summarizer error on chunk 1 → does not iterate; returns undefined (host path
   continues); warns.
7. Mechanism B: with the chunked path forced to fail, the returned
   `firstKeptEntryId` is a valid cut point from `branchEntries` and sits near the
   midpoint of the span.
8. Attempt cap: 3 fallback attempts → 4th is refused with a clear message.
9. Disabled config → hook never intervenes.
10. Split turn: `turnPrefixMessages` folded and merged.
11. Usage is propagated into the returned compaction.
12. Existing suites unchanged (109/109).

Live E2E (required — the mock cannot prove the host honours our compaction):
13. Force summarization failures with the capturing streaming proxy
    (`/tmp/pv-proxy/proxy.mjs`, already built for the outage work): reply 400 to
    requests above a byte threshold, succeed below it. Confirm: compaction fails
    twice → fallback arms → chunked summary succeeds → `session_compact` fires →
    the turn resumes. Then repeat with the threshold low enough that only
    mechanism B works.
14. Confirm no double compaction when pi-safe-compact is also installed.

---

## 7. Deliverables

- `index.ts`: fallback subsystem (trigger counter, two mechanisms, config).
- `pi-vigilant.json` + `README.md`: the five new keys, and a section explaining
  the fallback, its fidelity trade-off, and the pi-safe-compact ownership choice.
- `test/test-compaction-fallback.mjs` + live E2E evidence.
- `CHANGELOG.md` entry; version 0.3.0 (new feature), released only on your word.

---

## 8. Open questions — I need answers before implementing

1. **Mechanism**: A (chunked fold, full coverage, better fidelity, N calls) as
   primary with B (halved span) as last resort — or B only, as literally
   specified?
2. **Subagent**: (i) direct bounded call, (ii) in-process agentic subagent,
   (iii) `pi -p` subprocess?
3. **Ownership**: keep the fallback dormant-unless-failing alongside
   `pi-safe-compact` (my recommendation), or make pi-vigilant the sole owner and
   tell users to uninstall pi-safe-compact?
4. **Scope of the guarantee**: is "always succeeds while the provider answers a
   bounded request" acceptable, or do you want a fallback that also survives a
   total provider outage (which would mean a non-LLM summary, e.g. extracting
   file paths and tool results deterministically)?

---

## 9. v2 — the always-works ladder

The v1 guarantee was "succeeds while the provider answers a bounded request"
(§8 Q4). The operator hit the hole in it: the host's whole-span summary failed
with a 400 (`156997 input + 11004 output > 168000`), the fallback engaged — and
its *first* slice came back length-capped, so the attempt threw before a single
slice was covered and the session dead-ended on "could not summarize the
context … run /compact manually". Answer to §8 Q4: **yes** — the guarantee is
now "the session can always continue", provider outage included.

Three additions, in order of use:

1. **Output-aware slice sizing** (`planChunkTokens`). The even share could grow
   a slice to `span / maxChunks` (25k tokens in the reported case); a summary of
   that slice does not fit the host's output budget (`min(0.8 * reserveTokens,
   model.maxTokens)` = 11004 here), so the request is capped and the summary is
   incomplete. The slice size is now clamped by that budget as well, so the
   first request normally fits.
2. **Split-and-retry** (`summarizeSliceBounded`). A slice that still fails with
   a *size* error — output cap, or an input-too-long 400 — is halved at a
   message boundary and the halves are folded forward, recursively down to
   `MIN_COMPACTION_FALLBACK_CHUNK_TOKENS` and `MAX_FALLBACK_SLICE_SPLIT_DEPTH`.
   Non-size errors (provider down, network) are not retried: a smaller slice
   cannot fix them.
3. **Drop-only (mechanism C)**. When no slice could be summarized at all, the
   oldest ~half of the span is dropped *without* a summary and the cut moves to
   `findPrefixCut(span, spanTokens / 2)`. No model call is involved, so this is
   the one rung that works while every provider request is rejected. The
   placeholder summary states that earlier context was dropped; the operator
   gets a warning. `compactionFallbackDropOnly: false` restores the v1
   behaviour (report once, leave the host path alone). A user abort
   (`event.signal.aborted`) never drops content.

### 9.1 Invariants

- **The recent tail is never touched.** Pi's `firstKeptEntryId` is the boundary
  of the last `keepRecentTokens` — everything from there on is kept verbatim.
  Every cut the fallback makes lies inside the span that ends at that boundary,
  so a partial compaction only ever moves the cut *earlier* and keeps strictly
  more than the standard compactor. The cut is additionally rejected when it
  equals the host's own cut.
- **The split-turn prefix is never cut into** (`cuttableSpan`): the fold does
  not summarize it in mechanism B, so dropping it would discard content no
  summary ever saw. If the history region is empty the full span is used —
  readability beats a dead end.
- **A partial compaction is always possible once any slice succeeded** (v1
  §4.3, unchanged): a failure after the first slice yields a prefix cut, never
  a throw.

### 9.2 Tests added

`test/test-compaction-fallback.mjs` — 6b (a slice never exceeds the summary
output budget), 10 (provider failure → drop-only, warning, no retry), 10a
(drop-only disabled → report once), 10c (a capped slice is halved and folded),
10d (every slice size capped → drop-only, bounded attempts, no dead-end), 10e
(aborted compaction never drops), 10f (the verbatim tail is never cut into —
mechanisms A, B and C), 13b (a partial compaction never cuts into a split-turn
prefix). Suite: 103/103; full repo suite 303/303.
