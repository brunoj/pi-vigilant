# auto-continue Extension

## Problem

Three scenarios where pi stops mid-task without auto-continuing:

1. **Output-length stop** — Model hits `maxTokens` limit (`stopReason === "length"`). Pi shows "Model stopped because it reached the maximum output token limit."

2. **Threshold auto-compaction** — Context window fills up, pi compacts mid-task. The agent stops after compaction instead of resuming.

3. **Premature stop** — Model stops with `stopReason === "stop"` but the text ends mid-sentence or mid-thought. Provider flakiness causes the model to stop generating for no clear reason. Example: "Actually, let me just kill the orchestrator and restart. Let me restart everything:" — then nothing.

## Solution

A focused, minimal extension. No summarization logic, no sub-agents, no temp files.

### Architecture

```
~/.pi/agent/extensions/auto-continue/
├── index.ts              # Extension entry point (events + feedback tools)
├── package.json          # Minimal, just for pi.extensions field
├── auto-continue.json    # Config (tunable)
└── PLAN.md               # This plan

~/.pi/agent/skills/feedback-memory/
├── SKILL.md              # Instructions for when/how to capture feedback
├── global-feedback.json  # Global-level feedback items
└── projects/
    └── <project>/feedback.json  # Project-level feedback items
```

### Events Handled

#### 1. `agent_end` with `stopReason === "length"`

Detect when the assistant message was truncated due to max output tokens.

**Guards:**
- `state.lengthQueued` — one per run
- `ctx.hasPendingMessages()` — user already queued work
- `isContextOverflow()` — context overflow disguised as length stop

#### 2. `agent_end` with `stopReason === "stop"` (premature detection)

Detect when the model stopped but the text is clearly incomplete.

**Heuristics** (checked on trailing ~120 chars):
- Ends with `:` (hanging colon — about to list/explain/do something)
- Ends with `,` (mid-list or mid-clause)
- Ends with `-`, `–`, `—`, `…` (trailing off)
- Ends with conjunction/preposition: `and`, `but`, `or`, `because`, `so`, `then`, `if`, `when`, etc.
- Ends with lowercase letter (sentence cut off mid-word)
- Ends with unclosed ` ``` ` (code block opener)
- Ends with unclosed `` ` `` (inline code)
- Ends with unclosed `(`, `[`, `{`, `"`, `'`
- Ends with unclosed HTML tag `<tag`
- Ends with unclosed markdown link `[text`

**Not premature** (conclusive endings):
- Ends with `.`, `!`, `?`
- Ends with closing ` ``` `
- Ends with `)`, `]`, `}`
- Has tool calls (model intentionally handed off)

**Guards:**
- `state.prematureQueued` — one per run
- `state.lengthQueued` — don't double-fire
- `ctx.hasPendingMessages()`

#### 3. `session_compact` (threshold auto-compaction)

After auto-compaction (not manual, not overflow-recovery), the agent was mid-task and got interrupted.

**Guards:**
- `event.reason === "manual"` — skip
- `event.willRetry` — overflow recovery has its own retry path
- `ctx.isIdle()` — compaction before user prompt
- `ctx.hasPendingMessages()` — work already queued

#### 4. `agent_settled` (final verification with feedback checkpoints)

After the agent fully settles, send a verification prompt. If feedback memory integration is enabled, the prompt includes specific checkpoints from past user criticism instead of a generic "did you do everything?".

**Guards:**
- `config.finalVerification` — feature toggle
- `state.lastResponseConclusive` — only if last response was complete (not a continuation case)
- Cooldown: never sent more than once per 15 minutes unless a continuation fired in between

### Feedback Memory Tools

The extension registers three custom tools for the feedback memory system:

#### `capture_feedback`

Documents user criticism as a structured feedback item. The agent calls this when the user corrects its behavior.

**Parameters:**
- `scope`: `"project"` or `"global"`
- `category`: One of diligence, thoroughness, testing, communication, code-quality, verification, completeness, other
- `specific_behavior`: What the agent did wrong
- `expected_behavior`: What it should do instead
- `user_quote` (optional): What the user said

**Storage:** JSON files in `~/.pi/agent/skills/feedback-memory/`

#### `resolve_feedback`

Marks a feedback item as resolved. Called when the behavior has improved or the item is no longer relevant.

#### `get_feedback_checkpoints`

Returns all unresolved items formatted as a checklist. The agent can call this proactively, and auto-continue calls it automatically during verification.

### State Management

```typescript
interface ContinuationState {
  lengthQueued: boolean;
  compactionQueued: boolean;
  prematureQueued: boolean;
  lastResponseConclusive: boolean;
  lastVerificationTime: number;
  continuationSinceLastVerification: boolean;
}
```

Reset length/compaction/premature flags on `agent_start`. Verification cooldown persists across runs.

### Configuration

`auto-continue.json`:
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

### Spec-Memory (hard specification tracking)

Parallels feedback-memory but for **deliverable/constraint requirements** instead of behavior criticism. Three tools:

#### `capture_spec`

Captures a hard specification (requirement, constraint, acceptance criterion, format, deliverable) the user explicitly states. Stored hierarchically: task → area → spec → sub-spec.

**Parameters:**
- `requirement`: The checkable spec text
- `area`: functionality, ui-ux, performance, security, error-handling, testing, documentation, compatibility, constraints, format, data, deployment, other
- `priority`: must (default), should, nice-to-have
- `parentId` (optional): attach as sub-spec
- `sourceQuote` (optional): what the user said
- `supersedes` (optional): spec IDs this replaces (old specs marked obsolete)

**Storage:** `~/.pi/agent/skills/spec-memory/projects/<project>/current-task.json` (one task at a time; archived on rotation).

**Guards:** near-duplicate detection (token overlap > 0.8 within same area → rejected); supersedes marks old specs obsolete.

#### `get_task_specs`

Returns the current task's specs as a formatted hierarchical tree. Called mid-task for awareness, after compaction for recap, and before declaring completion.

#### `update_spec_status`

Marks a spec met/not-met/partial/in-progress/obsolete with evidence. Terminal statuses (met/not-met) require concrete evidence; unverifiable specs must be marked partial and asked to the user (never self-certified).

#### `/clear-specs` command (user-only)

Archives the current task to `archived/<taskId>.json` and starts a fresh task. Confirm dialog.

### Spec Injection Points

1. **Post-compaction continuation** (`session_compact`): appends the spec tree recap so requirements survive context loss.
2. **Final verification** (`agent_settled`): prepends the spec checklist — verify each spec with evidence, continue until every MUST spec is met.

### Task Rotation

On a genuine user input: if the current task's verification already ran (`verificationSentAt` set) AND no MUST spec is open/in-progress → archive the task and start fresh. Mid-task clarifications accumulate into the same task.

### State Management

```typescript
interface ContinuationState {
  lengthQueued: boolean;
  compactionQueued: boolean;
  prematureQueued: boolean;
  lastResponseConclusive: boolean;
  lastVerificationTime: number;
  continuationSinceLastVerification: boolean;
  lastRunToolCallCount: number;
  taskToolCallCount: number;
  sessionTotalToolCalls: number;
  currentTaskId?: string;
  currentTaskPath?: string;
  currentTaskTitle?: string;
}
```

### Edge Cases Handled

| Case | Behavior |
|------|----------|
| Multiple `agent_end` events before next `agent_start` | State flags prevent duplicates |
| User types "continue" manually | `hasPendingMessages()` returns true → skip |
| Compaction + length stop in same turn | Both flags set, only first continuation fires |
| Manual `/compact` | `reason === "manual"` → skip |
| Overflow recovery (`willRetry=true`) | Skip — pi's built-in retry handles it |
| Context overflow disguised as length stop | `isContextOverflow()` check → skip |
| Compaction before user prompt (idle) | `ctx.isIdle()` → skip |
| Agent already has queued messages | `hasPendingMessages()` → skip |
| Model stops with tool calls | Has tool calls → not premature |
| Model ends with conclusive punctuation | `.` `!` `?` → not premature |
| No feedback items exist | Verification prompt falls back to generic text |
| Feedback file is corrupted/missing | Gracefully returns empty checkpoints |
| No active spec task | Spec sections omitted from prompts |
| Spec file corrupted/missing | `loadSpecTask` returns null → tools return graceful messages |
| Near-duplicate spec capture | Token overlap > 0.8 → rejected with existing spec reference |
| User changes a requirement | `supersedes` marks old spec obsolete |
| Updating an obsolete spec | Rejected — cannot change obsolete specs |
| Unverifiable spec | Must be marked partial + asked to the user |
| Task verified + new user input | Auto-rotation archives task, fresh task starts |
| MUST spec still open mid-task | No rotation — specs accumulate in same task |
| `/clear-specs` with no task | Informational notice, nothing happens |
| `/clear-specs` cancelled | Task preserved |

### Testing

1. **Length stop**: Trigger a long task that produces enough output to hit the token limit → verify auto-continuation fires
2. **Premature stop**: If model stops mid-sentence → verify auto-continuation fires
3. **No duplicates**: Verify only one continuation per `agent_start`
4. **Manual `/compact`**: Verify does NOT trigger continuation
5. **Auto-compaction**: Verify DOES trigger continuation during active work
6. **Feedback capture**: Call `capture_feedback` tool → verify item appears in JSON file
7. **Feedback checkpoints**: Call `get_feedback_checkpoints` → verify compiled checklist (grouped by category, most recent only)
8. **Verification with checkpoints**: After capturing feedback, let agent settle → verify verification prompt includes checkpoints
9. **Simple Q&A skip**: Ask a simple question with no tool calls → verify NO verification prompt fires
10. **Contradiction resolution**: Capture feedback in same category twice → verify old item auto-resolved
11. **Compilation**: Capture 5 items across 2 categories → verify only 2 checkpoints shown
12. **Spec capture**: Call `capture_spec` → verify spec appears in current-task.json with correct area/priority
13. **Spec hierarchy**: Capture sub-spec with parentId → verify parentId stored, tree shows indentation
14. **Spec dedup**: Capture near-identical requirement in same area → verify rejected with existing spec reference
15. **Spec supersede**: Capture with `supersedes: [oldId]` → verify old spec marked obsolete
16. **Spec verification**: Call `update_spec_status` met with evidence → verify status + evidence stored
17. **Spec rotation**: Mark all MUST met + verification ran + new user input → verify task archived, fresh task created
18. **No rotation mid-task**: MUST spec still open → verify same task accumulates specs
19. **Compaction recap**: Trigger threshold compaction during complex task → verify continuation includes spec tree
20. **Verification with specs**: Complex task with specs → verify verification prompt includes spec checklist + MUST instructions
21. **Spec config off**: `specMemoryIntegration: false` → verify no spec sections in prompts
22. **Corrupt spec file**: Write invalid JSON to current-task.json → verify tools return graceful messages
