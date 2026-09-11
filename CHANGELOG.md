# Changelog

All notable changes to pi-vigilant are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  continues.

### Added

- Config keys `lengthContinuationMaxConsecutive`,
  `lengthContinuationTinyOutputTokens`, `contextPressureRatio`,
  `contextPressureCompaction`, `maxContextPressureCompactions` (documented in
  `README.md` and shipped in `pi-vigilant.json`).
- Test suite `test/test-length-loop.mjs` (40 checks) covering the fix doc's §6
  plan, including a replay of the 16-starved-stop production trace
  (`test/fixtures/length-loop-trace.json`). Against the pre-fix build the replay
  reproduces the bug exactly: 16 continuations, 0 compactions.

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
