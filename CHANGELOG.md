# Changelog

All notable changes to pi-vigilant are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.2] - 2026-10-14

### Fixed

- **The typecheck now types against the real host API.** The 0.7.1 gate was real
  but still weak: `node_modules` in this repo resolves
  `@earendil-works/pi-ai` to a `0.0.0-test` stub with no declarations, so the
  host API typed as `any` — exactly the class of error that sat here unnoticed
  for the project's whole life (seven `registerTool` signature mismatches).
  - `tsconfig.typecheck.json` is committed and maps the pinned peer packages
    into gitignored `.tools/`, with `strict` on. The check prints both the
    compiler version and the host-types version it ran.
  - **devDependencies were stale**: pinned at pi `0.83.0` while the extension
    runs against pi `1.2.0`. The old pin made the gate *reject working code*
    — `session_compact_failed` does not exist in 0.83.0. Now pinned to `1.2.0`,
    and `typebox` to the `1.3.27` the host actually ships.
  - `ProviderHeaders` is `Record<string, string | null>`, where a null means
    "do not send this header", and `generateSummaryWithUsage` wants
    `Record<string, string>`. The two were being passed as if identical; they
    are now converted by `headerRecord()`, which drops the nulls — the
    meaning-preserving reading.


## [0.7.1] - 2026-10-14

### Fixed

- **`npm run check` now checks.** It was `tsc --noCheck …`, which parses the
  file and verifies nothing — and `tsc` was not even resolvable in this
  environment: `node_modules` is a hand-built symlink tree pointing at the
  global pi install (so the extension resolves the host's own modules), which
  `npm install` cannot reconcile, so the declared devDependency was never
  installed. The script reported success while **9 real type errors** sat in
  `index.ts`. Mutation-checked: a deliberate type error now exits 2, while the
  old `--noCheck` command exits 0 on the same file.
  - `scripts/typecheck.sh` resolves the compiler from `node_modules`, then
    gitignored `.tools/`, then `PATH`, installing `typescript@<devDependency>`
    into `.tools/` when nothing is found — and prints the version it used, so a
    gate never silently runs a different compiler than the one declared.
  - `index.ts`: relative `lib/` imports carry `.js` as NodeNext requires (jiti
    resolves them; the suite confirms), the seven `registerTool` `execute`
    signatures now type `onUpdate` with the host's `AgentToolUpdateCallback`
    (it *is* the callback, not a function taking an update object), and
    `set_next_tool_timeout` returns the `details` field the host's
    `AgentToolResult` requires.

### Changed

- **Releases are gated.** `scripts/release.sh` runs the typecheck and the full
  suite before anything is versioned, tagged or published. Both used to live
  only in habit, so a release could ship red.


## [0.7.0] - 2026-10-14

### Added

- **Spec status integrity.** The completion gate keys off spec status — only
  `open`/`in-progress` MUST specs block, and only those two keep the
  verification checklist from being silenced by the cooldown — but
  `update_spec_status` accepted every transition unconditionally. Two one-call
  paths therefore cleared the gate as cleanly as real verification: `met` with
  nothing behind it, and `obsolete` with no stated superseder. Neither path was
  tested.
  - `met` / `not-met` are now **rejected** when `evidence` is missing or blank.
    Presence only: no length or vocabulary heuristics, because those get worked
    around and make a guard untrustworthy rather than stronger.
  - `obsolete` is now **rejected** without a `reason` naming the requirement that
    supersedes it or the user decision that retires it. The reason is stored on
    the spec.
  - `get_task_specs` shows what a verdict rests on — evidence for terminal
    statuses, `retired because:` for obsolete — clipped to one line, so a
    checklist that prints only a status can no longer pass a verified spec and an
    unverified one off as the same thing.
  - `partial` and `in-progress` deliberately require nothing. Making the honest
    way out of a spec cost an argument would push agents either into a retry
    loop or into pinging the user about things they need not ask about.

### Tests

- `test/test-spec-integrity.mjs` (29 checks): rejection per status, whitespace
  and empty-string evidence, a rejection that does not persist (the spec stays
  `open` — the guard is the handler refusing, not the schema description
  hoping), evidence persisted on success, obsolete with and without a reason,
  already-obsolete specs still frozen, `partial`/`in-progress` still free,
  evidence and reasons surfaced in the checklist. Mutation-checked: with the
  guard removed, `met` without evidence persists as `met` and `obsolete`
  persists unattributed.


## [0.6.3] - 2026-10-05

### Fixed

- **Overflow recovery no longer deadlocks after a successful fallback compaction.**
  When the host's own context-overflow recovery gave up and pi-vigilant's
  last-resort compaction succeeded, the agent loop hung instead of resuming the
  interrupted turn. The `agent_settled` handler queued the resume with
  `triggerTurn: true` and then blocked on a promise that only a *second*
  `agent_settled` could resolve — but pi core defers that `triggerTurn` action
  until every `agent_settled` handler has returned (`_isEmittingAgentSettled`
  gates `sendCustomMessage`), so the handler waited forever on an event that
  could not fire until it released. Core already awaits the deferred action to
  completion before `_emitAgentSettled()` returns to its caller, so the resumed
  turn was already kept alive without any help from this extension; the extra
  wait is removed. This is the failure behind a context-overflow 400 repeating
  with no recovery: once the handler hung, nothing further was processed.

### Tests

- **The test harness now matches the real host's compaction contract.**
  `ctx.compact()` previously fired `onComplete` directly, skipping the
  `session_before_compact` and `session_compact` events that pi core emits and
  awaits before the wrapper's callback runs. That gap is exactly why the
  deadlock above went unnoticed: the extension's own `session_compact` handler
  (which disarms the fallback and resets the length budget) never ran in tests.
  The mock now drives both events in the real order, and `test-length-loop.mjs`
  drains them between stops so the streak/budget arithmetic matches the host.
- **New regression check** (`test-context-overflow.mjs` §1b): the
  `agent_settled` retry handler must release on its own, without a second
  `agent_settled` being emitted — with a hard timeout, so a recurrence fails
  fast instead of hanging the suite. Verified to actually catch the bug (fails
  when the old wait is restored).

## [0.6.2] - 2026-10-04

### Added

- **Completeness guard at final verification** — newer models increasingly settle
  for work that *looks* finished: a function whose body is a placeholder, a screen
  populated with invented records, a report citing a limit nobody checked. Green
  tests do not disprove it, because the tests were written against the stub. At
  completion the extension now scans the files this session changed for stub,
  fabricated-data and unverified-fact markers (`TODO`, `not implemented`, `coming
  soon`, lorem ipsum, `example.com`, placeholder people/phones, `TBD`, `???`,
  `YOUR_API_KEY`, …) and injects the concrete `file:line` evidence into the
  verification prompt.
- **The call-out is unconditional.** Findings variant (the evidence), scan-failure
  variant (says plainly that the deliverable could not be checked — never implies a
  check that did not happen), or a clean-scan variant that still asks the two
  questions a scan cannot answer: was anything asked-for silently deferred, and is
  every part wired to a user-reachable entry point? Built-but-never-wired is the
  stub no marker reveals.
- **Finish it, or say so.** The agent must either complete the work or state the
  discrepancy to the user — what is missing, why, what remains. A stub or
  placeholder is legitimate only when the user asked for exactly that, and then it
  is declared out loud, never left silent.
- **Changed files, not the whole repo.** Git baseline diff (captured at session
  start) plus the current worktree, so work the agent already committed is still
  covered — the ASF commits per phase, so the tree is clean exactly when
  verification runs; outside git, files modified since the session started. Tests,
  fixtures, docs, dependencies and generated code are excluded (mocks at a test
  seam are correct practice), findings are capped and the cap is disclosed.
- Config: `completenessGuard` (default `true`), `completenessMaxFindings` (default
  25). The guard never blocks a run — it is prompt-based.
- New suite `test/test-completeness.mjs` (35 checks): what the scanner catches,
  what it must not flag (`placeholder="Search"`, clean source), what it excludes,
  that capping and scan failures are disclosed, and that the completion hook
  injects real findings — including stub work the agent already committed.

Pairs with the ASF-side rule `aia-asf` `references/06i-completeness.md` (P24).


## [0.6.1] - 2026-09-27

### Fixed
- **Host-retry exhaustion is now resumed with a state-aware instruction.** When
  the host's own auto-retry budget is exhausted on a retryable provider error
  (the TUI shows `Retry failed after N attempts: ...`, e.g. `terminated`), the
  continuation pi-vigilant queues now tells the model that the interrupted
  response never completed and that none of its tool calls were executed, and
  points it at the real state of the work (files written, tool results from
  earlier turns) so it continues from the point of interruption instead of
  re-reading the user's request as if starting over.
- **Operator notice on exhaustion.** When pi-vigilant steps in after the host
  gave up, it notifies the operator once per failure streak that the session is
  resuming automatically, so the `Retry failed` error is not mistaken for a
  dead session.

## [0.6.0] - 2026-09-13

### Added
- **Tool-call timeout enforcement.** A tool call can no longer hang for hours.
  Shell tools (`bash`, `powershell`) accept an optional `timeout` in seconds;
  pi-vigilant now heeds the tool's own timeout setting and applies an implicit
  maximum:
  - a call with **no timeout** gets the ceiling injected
    (`toolTimeoutCeilingSeconds`, default 1800 = 30 min), so the host's own
    timeout mechanism kills the process tree and the agent receives a
    `Command timed out after N seconds` error instead of hanging;
  - a call with a **timeout above the ceiling** is clamped down (with a warning
    notification);
  - a call with a **timeout within the ceiling** is left untouched;
  - non-shell tools are never touched (they carry no timeout parameter and are
    local operations that don't hang for 30 minutes).
- **`set_next_tool_timeout` tool (one-shot TTL).** The agent can raise the
  ceiling for exactly one shell call that legitimately needs longer than 30
  minutes: `set_next_tool_timeout(seconds: 3600)` applies to the very next
  `bash`/`powershell` call (non-shell calls don't consume it) and then reverts
  to the default ceiling. Capped at 86400s (24h) so a typo can't turn the
  ceiling into a multi-day hang.

### Configuration
- `toolTimeoutEnforcement` (default `true`) — disable the whole mechanism.
- `toolTimeoutCeilingSeconds` (default `1800`) — implicit maximum in seconds;
  `0` disables injection.

## [0.5.0] - 2026-09-13

### Fixed
- **A compaction that succeeds but does not shrink the context no longer
  dead-ends the session.** Reported from a real session where compaction kept
  "working" while the retry kept being rejected: the fallback reported success
  but *appended* its summary next to the previous one instead of replacing it,
  so each compaction freed almost nothing and the loop continued until the
  session gave up. Two causes, both fixed:
  - **The cut could land on the previous compaction entry.** The new summary is
    now placed strictly *after* the newest compaction entry on the path, so it
    always supersedes the previous summary — the context can only shrink.
  - **The fold stopped at half the span** and sized everything with Pi's
    `chars / 4` estimate, which undercounts real tokens by 1.5–2.2× on
    reasoning-heavy sessions. The fold now summarizes its whole budget, and the
    cut is chosen so the post-compaction context fits the *real* prompt limit
    (`contextWindow − maxOutput − 2048`, with the real/estimate ratio measured
    from the host's own anchored usage and clamped to 1.75–3×). Whatever the
    fit pushes past the summarized region is summarized too — or the summary
    says explicitly that it was dropped.
- **The context-pressure cap could block the last-resort fallback entirely.**
  After two context-overflow turns, `maxContextPressureCompactions` set a flag
  that also gated the fallback's retry, so the fallback never ran and the
  session dead-ended with "Context remains exhausted after automatic
  compaction." The cap (and its cooldown) now only stop pi-vigilant's *own*
  recovery; the fallback's own `maxCompactionFallbackAttempts` bounds the loop.
  That budget resets when a turn completes normally — not on a successful
  compaction, which the host reports even when the real context still
  overflows.
- **A failed split-turn prefix summary no longer fails the whole fallback.**
  The fold is marked incomplete instead, so the cut stays before the prefix and
  those messages are kept verbatim rather than dropped unsummarized.

### Added
- `details.fitRatio`, `details.suffixTokens`, `details.fitLimitTokens` and
  `details.uncoveredTokens` on fallback compaction entries record how the cut
  was chosen and what the fit cost.

### Changed
- Mechanism B (prefix-cut) now moves the cut *later* than the host's own cut
  when the fit requires it. Previously the cut could only move earlier, which is
  why an over-limit context could not be repaired by a partial compaction.

## [0.4.0] - 2026-09-12

### Added
- **The compaction fallback can no longer dead-end.** When every
  summarization attempt fails — including the case where the provider rejects
  or caps *every* request — the fallback now drops the oldest part of the
  span (Mechanism C, "drop-only") and supplies a placeholder summary that
  tells both the model and the operator that the earlier conversation is gone.
  The operator error "pi-vigilant's compaction fallback could not summarize the
  context … run /compact manually" is unreachable while drop-only is enabled.
  Set `compactionFallbackDropOnly: false` to restore the old behaviour
  (report the failure once and leave the host path alone).
- **Split and retry.** A slice whose summary hits the output token cap is
  split in half at a message boundary and both halves are summarized
  recursively (depth ≤ 3, floor one chunk), folding the first half forward as
  the second half's context. This turns a first-slice failure into a partial
  or full compaction instead of an error.
- `details.requests` on the fallback's compaction entries records how many
  provider requests the fold actually spent, split retries included.

### Fixed
- **Slice sizing was blind to the summary output cap** — the root cause of
  the reported first-slice failure: a ~150K-token span was sliced into
  ~25K-token chunks to cover it in six requests, and the summary of such a
  chunk hit the 11004-token output cap (`stopReason "length"`).
  `planChunkTokens` now also bounds a slice by the summarization output budget
  (`min(0.8 × reserveTokens, model.maxTokens)`), so a slice is small enough
  that its summary can actually be produced. Previously only the *input*
  window bounded a slice.
- A compaction aborted by the user (`event.signal.aborted`) never drops or
  summarizes content: the abort propagates to the host.
- Every fallback cut point stays at or before the host's `firstKeptEntryId`,
  so the most recent `keepRecentTokens` of conversation stay verbatim exactly
  as the standard compactor keeps them. A split-turn prefix that the fold
  never summarized is never cut into either.

## [0.3.2] - 2026-09-12

### Fixed
- The compaction fallback no longer fails the whole compaction when a slice
  fails partway (provider error, or the summary generation hit the output
  token cap — `stopReason "length"`). It now falls back to Mechanism B
  (prefix cut): the summary covers the successfully summarized prefix and the
  cut point moves to the end of it, so a partial compaction is always
  possible once any slice succeeded. Previously a single length-capped slice
  surfaced the operator error "could not summarize the context … run /compact
  manually" even though a partial compaction was possible.

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
