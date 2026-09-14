# pi-vigilant

**A diligence layer for [pi](https://pi.dev).** Auto-continue after interruptions, track hard specifications, and keep agent behavior honest.

> ⚠️ **Security:** pi packages run with full system access. Extensions execute arbitrary code. Review the source before installing. See [pi package security](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md).

---

## What it does

| Feature | Description |
|---|---|
| **Auto-continue** | Resumes work after output-length stops, premature stops, and threshold auto-compaction — so long tasks don't die silently. |
| **Spec-memory** | Captures hard specifications (requirements, constraints, acceptance criteria) you state during a task, stores them hierarchically, and injects them for verification when the task finishes. |
| **Feedback-memory** | Captures user criticism of agent behavior (project or global scope) and surfaces it as checkpoints before declaring work complete. |
| **Final verification** | After a complex task, prompts the agent to verify every captured spec against the deliverable — and keeps working until every MUST spec is met. |

## Installation

```bash
pi install npm:pi-vigilant
```

Or from git:

```bash
pi install git:github.com/brunoj/pi-vigilant
```

Or locally during development:

```bash
pi install /path/to/pi-vigilant
```

Run `/reload` (or restart pi) after installing.

## Configuration

`pi-vigilant.json` (sits next to the extension; defaults to all features on):

```json
{
  "prematureStopDetection": true,
  "lengthStopContinuation": true,
  "compactionContinuation": true,
  "finalVerification": true,
  "feedbackMemoryIntegration": true,
  "specMemoryIntegration": true,

  "staleContinuationFiltering": true,
  "maxConsecutiveFailureContinuations": 3,
  "hostRetryBudget": 3,

  "lengthContinuationMaxConsecutive": 3,
  "lengthContinuationTinyOutputTokens": 64,
  "contextPressureRatio": 0.9,
  "contextPressureCompaction": true,
  "maxContextPressureCompactions": 2,

  "compactionFallback": true,
  "compactionFallbackAfterFailures": 2,
  "maxCompactionFallbackAttempts": 3,
  "compactionFallbackChunkTokens": 8192,
  "maxCompactionFallbackChunks": 6,
  "compactionFallbackModel": "",
  "compactionFallbackDropOnly": true,

  "loopGuardian": true,
  "loopRepeatThreshold": 3,
  "loopCycleRepeats": 2,
  "loopMaxCycleLength": 32,
  "loopWindowSize": 64,
  "loopStallCalls": 24,
  "loopStallRepeatRatio": 0.5,
  "loopSteerMax": 2,
  "loopCooldownMs": 90000
}
```

## Usage

- **Capturing specs:** just state requirements while building. The agent calls `capture_spec` automatically (or you can ask it to).
- **Viewing specs:** ask the agent to "show the task specs", or the agent calls `get_task_specs` mid-task.
- **Verification:** happens automatically at task end. The agent marks each spec met/not-met with evidence via `update_spec_status`.
- **Clearing:** `/clear-feedback` and `/clear-specs` are user-only commands (with confirmation).
- **Feedback:** when you criticize the agent ("you always..."), it should call `capture_feedback`. Checkpoints are injected automatically before the agent declares work complete.

## Tools & commands

| Tool | Purpose |
|---|---|
| `capture_spec` | Capture a hard spec (area, priority, parentId, supersedes, dedup guard) |
| `get_task_specs` | Show the current task's spec tree |
| `update_spec_status` | Mark specs met/not-met/partial with evidence |
| `capture_feedback` | Capture behavior criticism (project/global) |
| `resolve_feedback` | Mark a feedback item resolved |
| `get_feedback_checkpoints` | Compiled, categorized checkpoints |
| `/clear-specs` | User-only: archive current spec task + start fresh |
| `/clear-feedback` | User-only: clear all feedback |

## Development

```bash
npm install        # devDependencies for type-checking
npm run check      # tsc --noEmit
npm run release    # bump version + changelog + tag + publish (see below)
```

Test suites used during development live in the repo history (see the 0.1.0-era commits for the 11-scenario test matrix and design notes).

### Releasing (auto-versioning)

```bash
npm run release patch   # 0.1.0 → 0.1.1
npm run release minor   # 0.1.0 → 0.2.0
npm run release major   # 0.1.0 → 1.0.0
```

This bumps the version, updates `CHANGELOG.md`, commits, tags `v0.1.x`, pushes to GitHub, and publishes to npm.

## License

MIT © Bruno Jakic — [Ai Applied](https://ai-applied.nl)

## Stale-continuation control

When the provider is unreachable, every failed turn used to queue a
continuation. Each was drained into the session and persisted, so after
recovery the model saw several standing instructions to resume work that was
already finished. Three mechanisms bound and expire them:

- **Host-retry deferral** — the extension stays out of the way for the first
  `hostRetryBudget` (default 3) consecutive retryable failures, leaving them to
  Pi's own retry layer.
- **Circuit breaker** — at most `maxConsecutiveFailureContinuations` (default 3)
  continuations per unbroken failure streak.
- **Run-id + epoch stamping with a context filter** — continuations queued by a
  previous process or in a superseded epoch are dropped from the LLM context
  before each call. Scoped to the five `auto-continue-*` customTypes; other
  extensions' messages are never touched.

All three are configurable in `pi-vigilant.json` and can be disabled via
`staleContinuationFiltering: false`.

## Output-length loop control

A model that hits its output cap mid-response (`stopReason: "length"`) gets a
follow-up so it can finish. That is right for a *productive* stop — a real
32K-token answer that needs a second turn. It is a trap for a *starved* stop:
when the input has already consumed the window, the model can only emit a token
or two, and every continuation makes the input larger while the output stays
tiny. Left alone that loop runs until the request overflows.

Four settings bound it:

- **Tiny-output detection** — a length stop with `output <=
  lengthContinuationTinyOutputTokens` (default 64) counts as context-starved.
- **Context-pressure compaction** — a starved stop while the input is at least
  `contextPressureRatio` (default 0.9) of the window does not continue at all;
  the extension calls `ctx.compact()` instead, so the work resumes on a fresh
  window rather than a fuller one. Set `contextPressureCompaction: false` to
  fall back to the breaker below.
- **Consecutive-continuation breaker** — at most
  `lengthContinuationMaxConsecutive` (default 3) continuations per unbroken
  streak, counted across run boundaries (a `lengthQueued` flag reset on every
  `agent_start` is what made the original loop unbounded). The counter resets on
  real progress: any turn that does not stop on the output limit, or a new user
  message.
- **Compaction cap** — at most `maxContextPressureCompactions` (default 2)
  context-pressure compactions per streak, with a 60s cooldown between them.
  When the cap is reached the extension stops and warns instead of compacting in
  a loop; that budget deliberately survives a successful compaction, otherwise
  each compaction would re-arm its own cap.

Both counters are independent of Pi's own overflow recovery: a genuine
`isContextOverflow` stop is left to the core's compact-and-retry path, and if
another extension has already queued work the extension stays out of the way.

## Compaction fallback

Compaction is the one operation a session cannot route around: if the
summarization request cannot be served, the context never shrinks and every
later turn fails the same way. Pi sends the whole span to be summarized in a
single request, so a session that has grown past what the provider accepts can
never compact — it is stuck, and the only exit is a new session.

The fallback keeps that from being fatal. It stays dormant until compaction has
actually failed (`compactionFallbackAfterFailures`, default 2, counted on
consecutive non-aborted failures), then summarizes the span itself in
size-bounded slices and hands the host a compaction it accepts. It is a ladder —
each rung is tried before the next, less destructive one gives way to a more
destructive one, and the last rung always works:

- **Chunked fold** — the span is split into slices of at most
  `compactionFallbackChunkTokens` (default 8192) estimated tokens, each
  summarized in its own request, chained forward through the previous summary so
  the result is one summary, not a pile of fragments. Nothing is dropped: the
  summary covers the whole span, so the host's own cut point is kept.
- **Split and retry** — a slice whose summary hits the output token cap
  ("generation hit the token cap and the summary is incomplete") or is rejected
  as too long for the input is halved and retried, recursively down to the
  minimum slice size, folding the halves forward. A size limit never fails the
  compaction; only a genuinely broken provider does.
- **Prefix cut** — when the span needs more slices than
  `maxCompactionFallbackChunks` (default 6) allows, or a slice fails after
  earlier ones succeeded, the fold summarizes a prefix (about half the span by
  size) and moves the cut point to the end of what the summary actually saw.
  That is a real reduction in fidelity — the kept messages and the summary
  overlap less than they would otherwise — but the context always shrinks, and
  the next compaction usually fits again.
- **Drop-only (last resort)** — when no slice can be summarized at all
  (provider down, every request rejected, even the smallest slice capped), the
  oldest part of the span is dropped without a summary and the cut point moves
  to ~half the span. No model call is involved, so this works while every
  provider request fails. The summary entry says plainly that earlier context
  was dropped; the operator is warned. Disable with
  `compactionFallbackDropOnly: false` if you would rather be told to run
  `/compact` manually than lose context.

The recent tail is protected. Pi's cut point is the boundary of the last
`keepRecentTokens` — everything from there on is kept verbatim — and the fold
mechanisms keep that boundary. Only the fit guarantee may move the cut past it:
a context that still overflows after a compaction is the loop this exists to
break, so when the tail alone cannot fit the prompt, the cut moves into it — and
the messages it moves past are summarized by one more request first. Nothing is
ever dropped without a summary.

Two guarantees make the result trustworthy rather than merely successful:

- **The new summary replaces the previous one.** The cut is placed strictly
  after the newest compaction entry on the session path, so an earlier summary
  leaves the context instead of being stacked next to the new one. Without this
  a "successful" compaction can free almost nothing and the session compacts
  forever.
- **The result fits the model's real limit.** The cut is chosen so the
  post-compaction prompt fits `contextWindow − maxOutput − 2048`, using a
  conservative estimate calibrated against the host's own anchored token count
  (real prompts run 1.5–2.2× above Pi's `chars / 4` estimate on
  reasoning-heavy sessions). If fitting requires cutting past the region the
  fold summarized, that region is summarized too — or the summary says
  explicitly that it was dropped, and `details.uncoveredTokens` records how
  much. A compaction that "succeeds" while leaving the context over the limit
  is not a success: it is the loop this exists to break.

The slice size adapts to the model: it is raised to cover the span within the
chunk budget when the window allows, and clamped both to what the model can
accept as input (`contextWindow - output budget - slack`) and to what its
summary output can hold (`maxTokens`). A slice larger than the output budget is
exactly the request that comes back length-capped, so the clamp is what keeps
the first attempt from failing in the first place.

Ownership rules that keep it safe:

- It never calls `ctx.compact()` — it only supplies a compaction when the host
  asks for one, so it cannot race the host or double-compact.
- Attempts are capped (`maxCompactionFallbackAttempts`, default 3). When the cap
  is reached the extension stops and says so instead of burning requests. The
  budget resets when a turn completes normally — the proof the context fits
  again — not on a successful compaction, which the host can report even while
  the real context still overflows. The context-pressure cap
  (`maxContextPressureCompactions`) and its cooldown never block this last
  resort: they bound pi-vigilant's own recovery, and blocking the fallback there
  is exactly the dead end it exists to prevent.
- A provider outage does not dead-end the session: if the first slice cannot be
  summarized, the drop-only rung removes the oldest part of the span so the
  session can continue once the provider is back. Nothing in this path calls the
  model, so it cannot itself fail the way a summarization request can.
- `compactionFallback: false` disables the whole mechanism.
- `compactionFallbackDropOnly: false` keeps the fallback from dropping content
  without a summary: if summarization is impossible, it reports the failure and
  leaves the host path alone.
- `compactionFallbackModel` (e.g. `"anthropic/claude-sonnet-4-5"`) summarizes
  with a different model than the session uses — useful when the session model
  cannot take the span but another configured model can. Empty means the session
  model.

## Loop Guardian

An agent stuck in an endless loop — re-running the same analysis, returning from
the tail of a task to its head, never taking the next concrete step — burns
tokens and never finishes. The Loop Guardian detects that state and steers the
agent out of it, the same way a human would.

Detection (all signatures require the **result to be identical too**, not just
the call — polling loops whose results change are legitimate and never fire):

- **Identical repeat** — the same tool call (canonical arguments + result) seen
  `loopRepeatThreshold` (default 3) times within the window.
- **Cycle** — the last `loopCycleRepeats` (default 2) passes of a period-`p`
  sequence are byte-identical (the "tail → head" case). Periods up to
  `loopMaxCycleLength` (default 32) are checked; `loopWindowSize` (default 64)
  must hold two full passes.
- **Analysis stall** — `loopStallCalls` (default 24) consecutive calls with no
  file modification and at least `loopStallRepeatRatio` (default 0.5) repeated
  results (low information gain). First-pass research that reads new files
  never fires.

Intervention is a real user-role steering message injected into the current
turn (`sendUserMessage` with `deliverAs: "steer"`) — the faithful reproduction
of a human typing "YOU ARE LOOPING ENDLESSLY! STOP THAT AND START IMPLEMENTING
IMMEDIATELY". It never hard-blocks: a false positive costs one message, not a
halted run.

- Escalation: steer 1 (names the repeated pattern) → steer 2 (stronger) → one
  operator notification (`loopSteerMax`, default 2 steers; then silence).
- `loopCooldownMs` (default 90000) suppresses repeat detections of the same
  episode; after a steer the window is cleared, so only *new* looping escalates.
- Progress resets the episode: any write/edit tool, new result, genuine user
  input, model change, or compaction. Auto-continue (extension-sourced input)
  does **not** reset — it is the same task.
- `loopGuardian: false` disables the whole mechanism.
- Text-only loops (no tool calls) are out of scope for v1.
