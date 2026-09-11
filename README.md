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
  "maxContextPressureCompactions": 2
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
