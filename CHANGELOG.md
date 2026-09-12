# Changelog

All notable changes to pi-vigilant are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-09-12

### Fixed
- Context-overflow error recovery (Case 3a) no longer re-queues a
  self-reinforcing continuation and no longer compacts from `agent_end` (the
  emission is not awaited by the run loop, so the compact raced the host's
  overflow recovery and hit a stale ctx). The retry compact now runs from
  `agent_settled`, where the session is idle and not yet disposed; the handler
  blocks until the resumed run settles, so the print mode cannot dispose the
  session mid-run. The cap/cooldown block further overflow retries, and a
  failed retry notifies the operator without hanging.
- `session_compact_failed` with `reason: "overflow"` arms the bounded-slice
  fallback immediately (the host's whole-span summary is itself rejected when
  the span is at the limit) instead of waiting for the general 2-failure
  threshold.

## [0.3.0] - 2026-09-12

### Added

- **Loop Guardian** — detects an agent stuck in an endless loop and steers it
  out. Three detectors, all requiring the *result* to be identical too (polling
  loops whose results change are legitimate and never fire):

  - **Identical repeat** — the same tool call (canonical args + result) seen
    `loopRepeatThreshold` (default 3) times within the window.
  - **Cycle** — the last `loopCycleRepeats` (default 2) passes of a period-`p`
    sequence are identical (the "tail → head" case); periods up to
    `loopMaxCycleLength` (default 32).
  - **Analysis stall** — `loopStallCalls` (default 24) consecutive calls with no
    file modification and ≥ `loopStallRepeatRatio` (default 0.5) repeated
    results.

  Intervention is a real user-role steering message injected into the current
  turn (`sendUserMessage` with `deliverAs: "steer"`) — the faithful reproduction
  of a human typing "YOU ARE LOOPING ENDLESSLY! STOP THAT AND START
  IMPLEMENTING IMMEDIATELY". It never hard-blocks: a false positive costs one
  message, not a halted run. Escalation: steer 1 → steer 2 → one operator
  notification (`loopSteerMax`, default 2), with `loopCooldownMs` (default
  90000) suppressing repeat detections of the same episode. Progress resets the
  episode: any write/edit tool, new result, genuine user input, model change,
  or compaction. Auto-continue (extension-sourced input) does **not** reset.
  `loopGuardian: false` disables the whole mechanism. Text-only loops are out
  of scope for v1. Pure logic lives in `lib/loop-guardian.ts` (now shipped in
  the package).

## [0.2.0] - 2026-09-11

### Added

- **Compaction fallback** — compaction is the one operation a session cannot
  route around. Pi summarizes the whole span in a single request, so a session
  that has grown past what the provider accepts can never compact, never
  shrinks its context, and fails every later turn the same way; the only exit is
  a new session. The fallback keeps that from being fatal. It stays dormant
  until compaction has actually failed (`compactionFallbackAfterFailures`,
  default 2 consecutive non-aborted failures), then summarizes the span itself
  in size-bounded slices and supplies the host with a compaction it accepts:

  - **Chunked fold** — the span is split into slices of at most
    `compactionFallbackChunkTokens` (default 8192) estimated tokens, each
    summarized in its own request and chained forward through the previous
    summary, so the result is one summary rather than a pile of fragments.
    Nothing is dropped and the host's own cut point is kept. This is the gap
    the fallback fills: a retry loop that shrinks the request by discarding the
    oldest messages loses their content silently, and the summary it produces
    then claims to describe a conversation it never saw.
  - **Prefix cut** — when the span needs more slices than
    `maxCompactionFallbackChunks` (default 6) allows, the fold covers a prefix
    (about half the span by size, and only as far as the cut it will move to)
    and moves the cut point to the end of what the summary actually saw. The
    cut is derived from the host's `branchEntries` at a legal message boundary,
    never by mapping message indices back onto entries and never onto a tool
    result. Less faithful than a full fold, but the context always shrinks and
    the next compaction usually fits again.

  The slice size adapts to the model: it is raised to cover the span within the
  chunk budget when the window allows, and clamped to what the model can accept
  when it does not. Every request stays bounded, which is the property Pi's
  single whole-span request does not have.

- Config keys `compactionFallback`, `compactionFallbackAfterFailures`,
  `maxCompactionFallbackAttempts`, `compactionFallbackChunkTokens`,
  `maxCompactionFallbackChunks`, `compactionFallbackModel` (documented in
  `README.md` and shipped in `pi-vigilant.json`).
- Test suite `test/test-compaction-fallback.mjs` (63 checks) covering both
  mechanisms, the arming and attempt budgets, config parsing, provider-outage
  behaviour, ownership, and re-entrancy.

### Fixed

- **Output-length continuation loop** — a starved output-length stop (the input
  had consumed the window, so the model could only emit a token or two) queued a
  continuation that made the input larger while the output stayed tiny, until the
  request overflowed. A production session
  (`2026-09-07T21-26-34-232Z_01a07dc4`) ran 16 consecutive starved stops, adding
  ~79 input tokens each time, 166,660 → 167,924 against a 168,000 window. Three
  defects, all in the length path:

  1. **`lengthQueued` was reset on every `agent_start`** — including the run the
     continuation itself started, so the guard was cleared immediately after it
     was used and Case 1 was eligible again on the next starved stop. The field
     only ever prevented double-queueing within a single run; it was never a loop
     bound.
  2. **The only context guard was `isContextOverflow`** — which detects a
     provider-reported overflow *error*. A context-starved *length* stop is not an
     error (the request succeeded and returned a token), so the guard never fired
     in the failing case.
  3. **The failure circuit breaker did not cover length stops** — the streak
     counter that bounds error continuations never saw them.

  The length path now classifies every stop and bounds the streak:

  - **Starvation detection** — a length stop with `output <=
    lengthContinuationTinyOutputTokens` (default 64) is context-starved.
  - **Compaction instead of continuation** — a starved stop while the input is at
    least `contextPressureRatio` (default 0.9) of the window, or after
    `lengthContinuationMaxConsecutive` starved stops, calls `ctx.compact()`
    rather than continuing, so the work resumes on a fresh window.
  - **Compaction cap** — at most `maxContextPressureCompactions` (default 2) per
    streak, with a 60s cooldown; the cap deliberately survives a successful
    compaction, otherwise each compaction would re-arm its own bound.
  - **Surviving circuit breaker** — at most `lengthContinuationMaxConsecutive`
    (default 3) continuations per unbroken streak, counted across run
    boundaries. It resets only on real progress: a turn that did not stop on the
    output limit, or a new user message.

  Productive output-cap stops are unchanged: a real 32K-token response still
  continues. The loop is now bounded by `lengthContinuationMaxConsecutive`,
  `lengthContinuationTinyOutputTokens`, `contextPressureRatio`,
  `contextPressureCompaction` and `maxContextPressureCompactions` (documented in
  `README.md` and shipped in `pi-vigilant.json`), and covered by
  `test/test-length-loop.mjs` (40 checks) including a replay of the
  16-starved-stop production trace (`test/fixtures/length-loop-trace.json`).
  Against the pre-fix build the replay reproduces the bug exactly: 16
  continuations, 0 compactions.

### Verification

- 172/172 harness checks pass against the real `index.ts` (regression 29, stale
  30, resume 10, length loop 40, compaction fallback 63).
- Live end-to-end against real pi with a capturing provider proxy that rejects
  any summarization request above a byte limit — i.e. Pi's whole-span
  summarization can never succeed:
  - **Mechanism A** — two rejected whole-span summaries (118,831 bytes) armed the
    fallback; four accepted bounded slices (33,844 / 34,367 / 34,367 / 22,226
    bytes) produced a compaction with `fromHook=true`, `mechanism=chunked-fold`,
    `coveredTokens=29,165`; the session recorded the compaction entry and the
    turn completed.
  - **Mechanism B** — with a window too small to cover the span in one budget
    (8,000), the fallback produced `mechanism=prefix-cut`,
    `coveredTokens=16,087`, `partial=true`, `fromHook=true`; the reduced span
    then fit Pi's own summarization, which completed normally
    (`fromHook=false`) and the turn completed.

## [0.1.4] - 2026-09-08

### Fixed

- **Stale-continuation bug** — when connectivity drops, every failed turn
  queued a continuation. Each one was drained into the session, persisted, and
  converted to a `user`-role message, so after recovery the model saw N standing
  instructions to resume work that was already finished. Three cooperating
  mechanisms now bound and expire them:

  1. **Host-retry deferral (L1)** — Pi already retries retryable errors with
     backoff, so the extension stays out of the way for the first
     `hostRetryBudget` (default 3) consecutive retryable failures. It defers
     rather than suppresses: `isRetryableAssistantError` cannot distinguish
     "host will retry" from "retries exhausted", so suppressing outright would
     mean never resuming after the host gives up.
  2. **Circuit breaker (L2)** — at most `maxConsecutiveFailureContinuations`
     (default 3) continuations per unbroken failure streak, so a long outage
     costs a constant number of messages instead of one per failed turn.
  3. **Run-id + epoch stamping with a context filter (L3)** — every
     continuation carries the run id and epoch it was queued in. A `context`
     handler (fires before each LLM call) drops continuations that are stale:
     queued by a previous process (different run id) or in a superseded epoch
     (a later turn succeeded). The filter is scoped to the five
     `auto-continue-*` customTypes, never touches other extensions' custom
     messages, and keeps un-stamped messages from older versions.

### Added

- Config keys `staleContinuationFiltering`, `maxConsecutiveFailureContinuations`,
  `hostRetryBudget` (all defaulted on, documented in `pi-vigilant.json`).
- Durable test suite in `test/` (69 checks across regression, stale-mitigation,
  and resume suites; `npm test` runs them; `test/setup.sh` prepares the jiti
  harness against the installed pi).

### Verification

- 69/69 harness checks pass against the real `index.ts`.
- Live A/B with a capturing provider proxy on an identical resumed session:
  shipped 0.1.3 sent **36** stale "stopped due to an error" instructions to the
  provider; 0.1.4 sent **0** (only the system prompt and the user's real
  message).
- Live outage: 16 failed turns produced 3 continuations instead of 16.

## [0.1.3] - 2026-08-25

### Added

- **Spec-to-code traceability (`trace` field)** — every spec can now carry a
  trace `{ outcome, codePath, testFile, assertion }`: the operator-facing
  outcome it delivers, the concrete code path that delivers it, and the test
  that asserts it. `capture_spec` and `update_spec_status` accept it;
  `get_task_specs` renders it. Backward compatible (optional field). This is
  the M1 mechanism from the verification-integrity plan, consumed by
  pi-aia-asf's `/asf verify` mechanical gate (0.3.0).
- **External planning doc ingestion (M6)** — `capture_spec` prompt guidelines
  and the spec-memory skill now instruct the agent to ingest actionable items
  from external planning documents (IMPROVEMENT-PLAN.md, PLAN.md, delivery
  logs, ticket lists) as their own specs with `sourceQuote` pointing at the
  doc. The doc's own ✅/delivered markers are treated as claims, not evidence
  — each item is traced and verified like any other spec (the Betamaxx
  delivery-log trap).


## [0.1.2] - 2026-08-12

### Fixed

- **Only the first task of a session was ever verified.** The 15-minute verification cooldown used a session-scoped timestamp that was never reset when the user started a new task, so specs and feedback captured in every subsequent task were silently skipped. A genuine user message now resets the cooldown, making it per-task as intended.
- **Global feedback masked project feedback in the same category.** Checkpoint compilation kept only the most recent item per category across both scopes combined, so a newer global item dropped the project-specific item in that category (seen live in 2 of 3 projects). Items are now keyed by scope + category, so project and global checkpoints both survive.
- **Specs could remain `open` indefinitely without re-verification.** If a verification checklist was ignored, nothing re-asserted it and the task could still be archived unchecked. Verification now re-fires (bypassing the cooldown) while any spec is `open`/`in-progress`, and the prompt states how many MUST specs are still unresolved.

### Changed

- **Verification instruction is now specific rather than generic.** It previously asked a vague "have you finished everything?". It now instructs the agent to verify that work was actually implemented as requested — "not just attempted or assumed" — checked against the real deliverable instead of memory, with the concrete spec tree and real feedback checkpoints appended whenever available.


## [0.1.1] - 2026-08-11

### Changed

- Removed internal planning docs (`PLAN.md`, `SPEC-MEMORY-PLAN.md`) from the repository and the npm package — the tarball now ships only runtime files and skills.


## [0.1.0] - 2026-08-11

### Added

- **Auto-continue** after output-length stops, premature stops, and threshold auto-compaction, with `deliverAs: "steer"` for compaction continuations (fixes queued-message race).
- **Spec-memory**: `capture_spec`, `get_task_specs`, `update_spec_status` tools; hierarchical task storage (area → spec → sub-spec), dedup guard, `supersedes` contradiction handling, task rotation after verified tasks, `/clear-specs` user command.
- **Feedback-memory**: `capture_feedback`, `resolve_feedback`, `get_feedback_checkpoints`; project/global scope, category compilation, auto-resolve contradictions, `/clear-feedback` user command.
- **Final verification** prompt injection on `agent_settled` for complex tasks (15-min cooldown, only after tool calls).
- **Compaction recap** injection: spec tree + feedback checkpoints survive context loss.
- Config via `pi-vigilant.json` (all features toggleable, defaults on).
