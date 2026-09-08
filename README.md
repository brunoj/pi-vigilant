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
  "specMemoryIntegration": true
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
