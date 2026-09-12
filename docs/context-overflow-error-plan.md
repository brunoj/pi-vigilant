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

## Tests (test/test-context-overflow.mjs)

- Case 3 overflow (error message matches a provider pattern) → no
  auto-continue-error queued, compact called, notify sent.
- Case 3 overflow + compact onComplete → continuation queued (resume).
- Case 3 overflow + compact onError → notify, no continuation.
- Case 3 non-overflow error (e.g. "fetch failed") → continuation queued
  (unchanged behavior).
- Case 3 context-nearly-full (getContextUsage override) + non-overflow error →
  compact instead of continuation.
- Cap: second overflow in a streak → notify, no compact, no continuation.
- Cooldown: overflow within 60s of a Case 1a compact → notify, no compact.
- Length path unchanged (regression: Case 1a still compacts; Case 1 overflow
  still defers).
- Live E2E: proxy returns the exact 400 overflow error → assert compact +
  resume; then proxy accepts → turn completes. Negative: transient error →
  continuation (unchanged).

## Release

0.3.1 (patch): test suite green → live E2E green → version + CHANGELOG +
annotated tag → push + publish → verify published artifact → update local
install.
