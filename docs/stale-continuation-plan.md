# Stale-continuation on connectivity loss — analysis & mitigation plan

**Status:** implemented and verified (v0.1.4). Plan approved; the three-layer
mitigation (L1 host-retry deferral, L2 circuit breaker, L3 run-id + epoch
stamping with a context filter) is in place. See the verification section for
the evidence: 69/69 harness checks and a live A/B against the shipped 0.1.3
(36 stale instructions in context → 0).
**Reported:** continuity breaks → pi-vigilant retries "resume work" over and over →
connectivity restores → after the work is finished, the earlier pi-vigilant prompts
keep telling the agent it was interrupted and should proceed.

Everything below marked *verified* was reproduced mechanically, not reasoned about.
Repro harness: `/tmp/pv-outage/` (`repro-outage.mjs`, `repro-loop.mjs`, `proto-fix.mjs`,
`retry-budget.mjs`), loading the real shipped `index.ts` with a mocked `ExtensionAPI`.

---

## 1. How it actually works

### 1.1 The continuation paths

`pi.on("agent_end")` in `index.ts` has four continuation cases. Two of them fire on
connectivity loss:

| Case | Line | Condition | Guard |
|---|---|---|---|
| 0 — provider abort | 1483 | no assistant message at all | `hasPendingMessages()` only |
| 3 — error stop | 1571 | `stopReason === "error"` | `hasPendingMessages()` only |

Cases 1 (length) and 2 (premature) are guarded by one-shot latches
(`lengthQueued` / `prematureQueued`) that reset on `agent_start`.
**Cases 0 and 3 have no latch at all** — verified.

### 1.2 Why the existing guard does not hold

`ctx.hasPendingMessages()` is `pendingMessageCount > 0`
(`agent-session.js:2071` → `_steeringMessages.length + _followUpMessages.length`).

During an outage the cycle is:

1. turn fails → `agent_end` (`stopReason: "error"`)
2. pi-vigilant queues one `auto-continue-error` follow-up
3. **the agent loop drains that follow-up** and starts a new turn
   (`runLoop`: `pendingMessages = await config.getFollowUpMessages?.()`)
4. the queue is now empty again
5. the new turn also fails → back to 1

So the queue is empty at every `agent_end`, and the guard never suppresses anything.

**Verified** (`repro-loop.mjs`): 13 failed turns → **13 continuations queued**,
growing 1:1 with outage duration, no cap.

```
sendMessage calls during outage: 13
stale "resume" messages now in LLM context: 12
still queued (delivered AFTER restore): 1
```

The guard *does* work when the queue is not drained — verified in `repro-outage.mjs`
(two failures without a drain → 1 message). That is why the bug looks intermittent.

### 1.3 Why the prompts persist after the work is done

A drained continuation is not transient. `sendCustomMessage` pushes it into
`agent.state.messages` and persists it as a `custom_message` session entry
(`agent-session.js:1133`). `convertToLlm` then maps `role: "custom"` → **`role: "user"`**
(chunk-JVUZSMYM.js).

So each continuation becomes a permanent, user-authored-looking turn in the context
that says:

> "Your previous response stopped due to an error. Please re-read the user's last
> message and try again. Do not repeat completed work from earlier turns."

After recovery the model sees N of those interleaved with its own work. They read as
standing instructions to resume — which is exactly the reported symptom. **Verified**:
13 stale messages survive task completion.

### 1.4 Two compounding factors

**(a) The host is already retrying.** `_handlePostAgentRun` calls `_prepareRetry` for
retryable errors with exponential backoff (default `maxRetries: 3`,
`settings-manager.js:595`). pi-vigilant's continuation is therefore a *second*,
uncoordinated retry layer stacked on the host's.

**(b) Extensions are blind to it.** The host computes `willRetry` and attaches it for
its own listeners — but the extension event is emitted **without** it:

```js
// agent-session.js:474
await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
// vs, for internal listeners, line 386:
this._emit(event.type === "agent_end" ? { ...event, willRetry: ... } : event);
```

**Verified.** pi-vigilant cannot see that a retry is already scheduled.

### 1.5 Not the cause

- `agent_settled` verification is **correct** behaviour — it fires once after real
  completion and is properly cooldown-gated. Verified: exactly 1 on settle.
- The compaction path is well guarded (`lastResponseConclusive`, `isIdle`,
  `compactionQueued`).
- The `staleMessage` field in `runner.js` is about invalidated ctx after session
  replacement — unrelated.

---

## 2. Root cause

> pi-vigilant treats every failed turn as an independent, retry-worthy interruption,
> and its continuations are **permanent context messages with no notion of when they
> stop being true**. There is no failure-streak state, no cap, and no expiry.

Three distinct defects:

- **D1 — no coordination with the host retry layer** (duplicate retries)
- **D2 — no cap on consecutive failure continuations** (unbounded growth)
- **D3 — no staleness marker** (a continuation stays "live" forever once the
  interruption it describes is over)

D3 is the one the user actually observes. D1/D2 determine how many stale messages
accumulate.

---

## 3. Mitigation

Three layers, each addressing one defect. Prototyped and tested in `proto-fix.mjs`
(**7/7 passing**).

### L1 — Defer to the host's retry budget (fixes D1)

On a failed turn, if `isRetryableAssistantError(assistant)` (already importable from
`@earendil-works/pi-ai/compat`, **verified available**), skip queuing while the
consecutive-failure streak is within the host's retry budget.

**Design correction found by testing** (`retry-budget.mjs`): the first draft
*suppressed* on retryable errors. That is wrong — the predicate returns `true`
identically on attempt 1 and on attempt 4, so the extension cannot distinguish
"host will retry" from "retries exhausted". Pure suppression would mean **never
resuming** after the host gives up. So L1 must **defer, not suppress**: skip the first
K failures (K = host `maxRetries`, default 3), then resume normally.

Verified deferral behaviour:

```
 1 consecutive failures -> 0 continuations
 3 consecutive failures -> 0 continuations   (host's job)
 4 consecutive failures -> 1 continuation    (host gave up; we step in)
12 consecutive failures -> 3 continuations   (capped by L2)
50 consecutive failures -> 3 continuations
```

### L2 — Circuit breaker (fixes D2)

Track `consecutiveFailures`; stop queuing above `MAX_CONSECUTIVE_FAILURE_CONTINUATIONS`
(propose **3**). Reset to 0 on any successful turn. Bounds the damage of a long outage
to a constant, independent of duration. Verified: 12 failures → 3 continuations.

### L3 — Epoch stamping + context filter (fixes D3 — the reported symptom)

1. Keep a monotonic `epoch` counter. Stamp every continuation:
   `details: { kind, epoch }`.
2. Increment `epoch` on the first **successful** turn that follows a failure streak —
   the moment every outage-era continuation stops being true.
3. Register a `pi.on("context")` handler (fires before each LLM call, may rewrite the
   message list — **verified**: `runner.emitContext` → `sdk.js:227 transformContext` →
   `streamAssistantResponse`) that drops `role: "custom"` messages whose `customType`
   is a pi-vigilant continuation **and** whose `epoch` is below the current one.

Verified: 3 stale continuations → 0 after recovery, while the real user message and a
current-epoch continuation are preserved, and other extensions' custom messages are
untouched.

L3 is the load-bearing layer: it is a filter on our own tagged messages, so it fixes
the symptom even if L1/L2 tuning is imperfect.

### Safety properties

- Filtering is **context-only** — the session transcript keeps the full history.
- Scoped to the five `auto-continue-*` `customType`s. Verified: unrelated custom
  messages pass through.
- Messages without an `epoch` (written by older versions) are always kept — no
  retroactive rewriting.
- All three layers are independently configurable and default-on.

---

## 4. Alternatives considered and rejected

| Option | Why rejected |
|---|---|
| Only cap continuations (L2 alone) | Bounds growth, but N stale messages still persist. Does not fix the reported symptom. |
| Delete stale entries from the session file | Destructive, racy against the writer, breaks the transcript. Filtering at context time is reversible. |
| `deliverAs: "nextTurn"` for failure continuations | Still permanent once flushed; no expiry. |
| Ask the host for `willRetry` on the extension event | Correct long-term (worth an upstream issue), but pi-vigilant must not depend on an unreleased host change. |
| Time-based expiry (drop after N minutes) | Wall-clock is the wrong signal; a legitimately slow turn would be discarded. Epoch tracks the actual state transition. |

---

## 5. Proposed changes

| File | Change |
|---|---|
| `index.ts` — `ContinuationState` | add `epoch`, `consecutiveFailures` |
| `index.ts` — `agent_end` cases 0 & 3 | apply L1 deferral + L2 cap; stamp `epoch` |
| `index.ts` — `agent_end` success path | on first success after a streak: `epoch++`, reset streak |
| `index.ts` — new `pi.on("context")` | drop stale-epoch continuations |
| `index.ts` — length/premature/compaction | stamp `epoch` for consistency |
| `pi-vigilant.json` + `loadConfig()` | `staleContinuationFiltering`, `maxConsecutiveFailureContinuations`, `hostRetryBudget` |
| `README.md`, `CHANGELOG.md` | document behaviour |

**Scale: small-to-medium**, one file, additive, existing behaviour unchanged on the
happy path.

## 6. Test plan

Promote `/tmp/pv-outage/` into a durable suite:

1. **Regression** — full existing suite must stay green (no change on happy paths).
2. **Outage repro** — 12-cycle outage: continuations bounded by the cap (was 13).
3. **Recovery** — after success, stale continuations are filtered from context.
4. **Non-regression on real interruption** — a current-epoch continuation still
   delivered and acted on (the feature must keep working).
5. **Retry-budget boundary** — 1/3/4/6/12/50 failures → expected counts.
6. **Isolation** — other extensions' custom messages never filtered.
7. **Backward compat** — un-stamped continuations always kept.
8. **Live E2E** — install the built package, force an outage
   (block the provider host), confirm bounded continuations and clean recovery.

All bounded with hard timeouts per QA Rule 15.

## 7. Upstream follow-up (separate, non-blocking)

File a pi issue: `agent_end` should carry `willRetry` for extensions, as it already
does for internal listeners (`agent-session.js:386` vs `:474`). That would let L1 be
exact instead of budget-estimated.
