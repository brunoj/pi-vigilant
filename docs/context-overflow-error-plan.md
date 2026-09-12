# Context-overflow error recovery (Case 3) — plan

Status: implementing (bugfix, shipped as 0.3.1)

## Evidence (from Betamaxx session 01a08d07, 2026-09-10T20:34 → 09-12T13:14)

A session ran 2.5 days with 33 successful host compactions. At 11:49:55 the
provider rejected a request: input 152,951 + requested output 15,050 = 168,001
> 168,000 context window. pi-vigilant queued 3× auto-continue-error; each
re-requested and re-failed (input grew ~38 tokens/retry). After the circuit
breaker tripped, nothing happened: no compaction, no fallback, no
notification. The session stayed dead until the user typed "." at 13:14
(which 400'd again).

## Root cause (verified in index.ts)

- Case 3 (error stop, ~line 2698) calls `shouldQueueFailureContinuation`,
  which only bounds retry count. It never checks `isContextOverflow` and never
  compacts or notifies. Re-queueing the same overflowing request is strictly
  self-reinforcing.
- Case 1 (length stop, line 2544) DOES check `isContextOverflow` and Case 1a
  compacts on context pressure — but only for `stopReason === "length"`.
- The compaction fallback arms only after 2 `session_compact_failed` events and
  only fires when the host asks for a compaction (`session_before_compact`).
  In this scenario nothing triggers a compaction round after the failure, so
  the fallback can never engage. The host's own overflow recovery tries once
  per turn and gives up (its whole-span summarization is itself rejected when
  the span is at the limit — and even when it is not, one attempt is all it
  makes).
- The error message's usage is all zeros (request failed), so the
  context-pressure check must use `ctx.getContextUsage()` (host estimates from
  the last valid response) rather than `assistant.usage`.

## Fix

In Case 3, before queueing a failure continuation:

1. If `isContextOverflow(assistant, ctx.model?.contextWindow)` OR the context
   is nearly full (`ctx.getContextUsage().tokens >= contextWindow *
   contextPressureRatio`) — a continuation cannot help (it re-requests the same
   overflowing input; the effective limit is `contextWindow - output budget`,
   which the host's threshold does not account for):
   - Do NOT queue a continuation.
   - Compact via `ctx.compact({ customInstructions, onComplete, onError })`,
     reusing the Case 1a budget (`contextPressureCompactionsQueued`,
     `maxContextPressureCompactions`, `CONTEXT_PRESSURE_COMPACTION_COOLDOWN_MS`).
   - On `onComplete` (context now fits): queue the auto-continue-error
     continuation so the interrupted turn resumes automatically.
   - On `onError`: notify the operator (no continuation — the request would
     still overflow).
   - When the cap or cooldown blocks: notify the operator (never silent).
2. Otherwise: existing behavior unchanged (queue the bounded continuation).

The compaction goes through `session_before_compact`, so the compaction
fallback supplies a size-bounded chunked summary when the host's whole-span
summary is itself rejected — the two mechanisms compose: overflow error →
compact → host summary fails → fallback arms → retry compact → fallback
summary succeeds → continuation resumes the turn.

## Final design (shipped in 0.3.1)

The compact cannot run from `agent_end` (the emission is fire-and-forget and
races the host's overflow recovery → stale ctx) and cannot run from inside the
run loop (`ctx.compact()` → `abort()` → `waitForIdle()` deadlocks while
`_isAgentRunActive` is true). The retry therefore runs from `agent_settled`:

1. `agent_end` (overflow) → notify + return. No continuation (self-reinforcing),
   no compact (races the host).
2. Host's overflow recovery → `session_before_compact` (reason=overflow) →
   whole-span summary rejected → `session_compact_failed` (reason=overflow).
3. `session_compact_failed` handler arms the bounded-slice fallback immediately
   (overflow bypasses the general 2-failure threshold) and notifies.
4. `agent_settled` (session idle, not yet disposed) → retry compact. The
   handler blocks on the callbacks; on success it queues the continuation with
   `triggerTurn: true` (starts a new run) and blocks until that run's own
   `agent_settled` releases it — so the print mode cannot dispose the session
   mid-run. On failure it returns (the host's `session_compact_failed` counts
   it; the operator was already notified when the fallback armed).
5. The cap/cooldown (`maxContextPressureCompactions`, 60s cooldown) set
   `overflowRetryBlocked`, which gates the retry; a successful compact clears
   it.

## Tests (test/test-context-overflow.mjs, 32/32)

- Overflow at agent_end → no continuation, no compact, notify (the core fix).
- Overflow + successful retry compact → continuation queued (resume), fresh
  run, epoch+runId on the continuation.
- Overflow + failed retry compact → no continuation, no hang, operator
  notified.
- Non-overflow error → continuation queued (unchanged).
- Context-nearly-full + non-overflow → no continuation, retry compacts.
- Cap: second overflow → no second compact, no second continuation, warn.
- Cooldown: overflow within 60s → no second compact, no second continuation,
  warn.
- Length path unchanged (regression: Case 1a still compacts).
- Disabled (`contextPressureCompaction: false`) → continuation (unchanged).
- Live E2E (proxy rejects the exact 400 overflow + the host's whole-span
  summary): positive → `E2E_OK`, turn resumed, exit 0; negative (all summaries
  rejected) → no hang, no deadlock, exit 0.

## Release

0.3.1 (patch): test suite green (263/263) → live E2E green (positive +
negative) → version + CHANGELOG + annotated tag → push + publish → verify
published artifact (32/32 via PV_EXT) → update local install.
