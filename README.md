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
pi install git:github.com/AiAppliedNL/pi-vigilant
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

Test suites used during development live in the repo history; see `PLAN.md` and `SPEC-MEMORY-PLAN.md` for the design and the 11-scenario test matrix.

### Releasing (auto-versioning)

```bash
npm run release patch   # 0.1.0 → 0.1.1
npm run release minor   # 0.1.0 → 0.2.0
npm run release major   # 0.1.0 → 1.0.0
```

This bumps the version, updates `CHANGELOG.md`, commits, tags `v0.1.x`, pushes to GitHub, and publishes to npm.

## License

MIT © Bruno Jakic — [Ai Applied](https://ai-applied.nl)
