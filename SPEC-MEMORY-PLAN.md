# Spec-Memory — Plan: capture, store, and verify hard specifications

**Status:** Plan (not implemented)
**Context:** Extends the auto-continue extension and parallels the existing feedback-memory system.
**Design principle:** Same architecture as feedback-memory — *skill teaches judgment, extension provides mechanism*. No keyword matching; capture is agent-driven via a tool, guided by a skill's reasoning rules.

---

## 1. Concept

**Spec-memory** captures **hard specifications** (requirements, constraints, acceptance criteria, formats, deliverables) the user states while a task is being executed — especially during software building — stores them **hierarchically** (task → area → spec → sub-spec), and **injects them into auto-continue's prompts** so that:

1. **After compaction**, the agent gets a spec recap (compaction destroys detail — this is the highest-value injection point).
2. **At final verification** (`agent_settled`), the agent must check each spec against the actual deliverable, record evidence, and **continue working until every MUST spec is met** before declaring completion.

### Division of labor with feedback-memory

| Statement type | System |
|---|---|
| "You keep stopping at the first solution" (behavior) | feedback-memory |
| "The API must return 401 for unauthenticated requests" (deliverable/constraint) | **spec-memory** |

The litmus test: **"Is this about how I should behave, or about what the deliverable must be?"** Behavior → feedback. Deliverable/constraint → spec.

---

## 2. What counts as a hard specification (skill judgment)

### CAPTURE (signs of a hard spec)
- **Explicit requirement**: "the endpoint must validate input", "must be in TypeScript"
- **Constraint / don't-do**: "no external runtime dependencies", "must not require sudo", "must work offline"
- **Acceptance criterion**: "tests must pass", "must handle empty input gracefully"
- **Format / contract**: "output JSON with exactly `{id, name}` fields", "ISO-8601 timestamps"
- **Deliverable**: "write a README with install + usage sections"
- **Quality bar**: "error messages must be user-friendly, not stack traces"
- **Explicit scope boundary**: "don't touch the auth module", "keep it under 500 lines"

### DO NOT capture
- **Context / background** ("the user base is 10k people") — unless it changes a requirement
- **Casual conversation, praise, opinions**
- **Vague uncheckable preferences** ("make it nice") — or capture only with the concrete interpretation written down
- **Behavior criticism** → feedback-memory, not here
- **Meta-questions about the system**
- **Specs from other projects/sessions**

### Litmus test
**"Will the user check the delivered work against this statement? Can I objectively verify it?"** — If yes to both, it's a spec. Priority marking handles force: `must` = user checks it / blocker; `should` = important but not blocking; `nice-to-have` = report only.

---

## 3. Data model (hierarchical)

**Flat JSON storage, hierarchical display.** Specs are stored flat (easy tool updates) and rendered as an indented tree at injection time.

### File: `~/.pi/agent/skills/spec-memory/projects/<project-name>/current-task.json`

```jsonc
{
  "taskId": "tsk-1752...",            // set on rotation
  "title": "Build REST API for todo app",   // free-text, first spec's context
  "startedAt": "2026-07-29T...",
  "verificationSentAt": null,          // set when agent_settled verification fires
  "areas": {
    "functionality": [
      {
        "id": "spc-1752-48391",
        "requirement": "POST /todos returns 401 for unauthenticated requests",
        "priority": "must",            // must | should | nice-to-have
        "status": "open",              // open | in-progress | met | partial | not-met | obsolete
        "source": "\"The API must return 401 for unauthenticated requests\"",
        "parentId": null,              // sub-spec link
        "supersedes": null,            // ids this spec replaces (contradictions)
        "evidence": null,              // how verification was done
        "verifiedAt": null
      },
      { "id": "spc-...", "requirement": "...401 body is JSON {\"error\":\"unauthorized\"}", "parentId": "spc-1752-48391", ... }
    ],
    "constraints": [ ... ],
    "testing": [ ... ]
  }
}
```

### Hierarchy levels
1. **Task** — the unit of work (file). One file per task, archived on rotation.
2. **Area** — 12 fixed keys: `functionality, ui-ux, performance, security, error-handling, testing, documentation, compatibility, constraints, format, data, deployment` + `other`. (`constraints` = don't-do specs; verification for these = confirm the deliverable does *not* do X.)
3. **Spec** — one checkable requirement (fields above).
4. **Sub-spec** — `parentId` chains decompose a spec ("the API must be secure" → per-endpoint sub-specs). Arbitrary depth, rendered indented.

### Archived tasks
`~/.pi/agent/skills/spec-memory/projects/<project-name>/archived/<taskId>.json` — history only, not injected. (Optional future: a `list_archived_specs` tool.)

---

## 4. Task lifecycle & rotation

Tracked in extension state: `state.currentTaskId`, `state.currentTaskPath`.

**Start:** lazily on first `capture_spec` when no active task file exists.

**Rotation rule (automatic, in the existing `input` handler):** on a *genuine* user input (`event.source !== "extension"`), if the active task exists AND `verificationSentAt` is set AND no `must` spec is `open`/`in-progress` → archive the file, clear state, next capture starts a new task. Rationale: user refines a task after verification → new requirement lands in a fresh task (the old one was already verified complete); user keeps clarifying mid-task → specs stay open → same task continues.

**Manual:** `/clear-specs` user command (confirm dialog) archives the current task and starts fresh. **User-only**, mirroring `/clear-feedback` — the agent never wipes specs.

---

## 5. Tools (registered by the extension)

### `capture_spec` (agent-driven capture — the analog of `capture_feedback`)
```ts
parameters: {
  requirement: string,            // the hard spec, written checkably
  area: StringEnum([...12 areas, "other"]),
  priority: StringEnum(["must", "should", "nice-to-have"]),  // default "must"
  parentId?: string,              // attach as sub-spec
  sourceQuote?: string,
  supersedes?: string[],          // ids of specs this replaces (contradiction)
  status?: "open" | "in-progress" // default "open"
}
```
Behavior:
- Creates/loads the current task file; appends to the area.
- **Dedup guard:** if an open spec in the same area already has near-identical text (normalized token overlap > 0.8), return the existing ID with a note instead of duplicating.
- **Contradiction handling:** for each id in `supersedes` → mark `obsolete`, set `supersededBy` to the new id (mirrors `autoResolveContradictory`).
- Returns the spec id + current task id + per-area counts.

### `get_task_specs` (recall — the analog of `get_feedback_checkpoints`)
No params. Returns the formatted hierarchical tree:
```
=== TASK SPECIFICATIONS (tsk-1752... — 4 open, 2 met) ===
[functionality]
  [must][open]  spc-001: POST /todos returns 401 for unauthenticated requests
    [should][met] spc-002: 401 body is JSON {"error":"unauthorized"}  (evidence: test suite)
[constraints]
  [must][open]  spc-003: no external runtime dependencies
=== END SPECIFICATIONS ===
```
Called by the agent mid-task (e.g., right after compaction) and during verification.

### `update_spec_status` (verification — new mechanism, no feedback analog)
```ts
parameters: {
  id: string,
  status: StringEnum(["met", "partial", "not-met", "obsolete", "in-progress"]),
  evidence: string,   // required for terminal statuses — concrete, e.g. "npm test passes; build log line 12"
  note?: string       // e.g. "cannot verify objectively — needs user confirmation"
}
```
Rules: `evidence` required for `met`/`not-met`; if the spec cannot be objectively verified, the agent must set `partial` with note "needs user confirmation" and **ask the user** rather than self-certify.

---

## 6. Injection into auto-continue prompts

### a) Post-compaction continuation (`session_compact` handler) — spec recap
Append to the existing prompt (which already appends feedback checkpoints):
```
=== TASK SPECIFICATIONS (recap from spec-memory) ===
<tree from get_task_specs>
=== END SPECIFICATIONS ===
Re-check these requirements as you resume the task.
```
This is the critical one: compaction deletes the detail the specs encode.

### b) Final verification (`agent_settled` handler) — spec checklist
The verification prompt becomes (specs section first, then feedback checkpoints):
```
Have you finished everything you were asked to do? ...
=== TASK SPECIFICATIONS ===
<tree>
=== END SPECIFICATIONS ===
Verify EACH specification against the actual deliverable: call update_spec_status
for every spec with concrete evidence (test output, build result, code inspection,
or ask the user when you cannot verify objectively). If any MUST spec is not met,
continue working until it is. SHOULD specs: note briefly. Only declare the task
complete when every MUST spec is met or explicitly obsolete.
<feedback checkpoints section, unchanged>
```
- Skip the section entirely when no active task/specs exist (keeps simple Q&A clean — the existing complexity gate already prevents verification for those).
- The `verificationSentAt` field is set when this prompt fires (drives rotation).

### c) Length / premature / abort / error continuations
**No spec injection.** Context is still intact in those paths; only compaction and task-end lose or need it.

---

## 7. Config

`auto-continue.json` gains:
```json
"specMemoryIntegration": true
```
read in `loadConfig()` with the same `!== false` default pattern.

---

## 8. Skill: `~/.pi/agent/skills/spec-memory/SKILL.md`

New skill (parallel structure to feedback-memory):
- **Overview** — what spec-memory is; relationship to feedback-memory (behavior → feedback, deliverable → specs)
- **When to capture — judgment section** — the CAPTURE / DO-NOT lists from §2, with examples mirroring the feedback-memory style ("DO capture: 'the API must return 401...' — DO NOT capture: 'can you build me a REST API?' (that's the task itself, though its *requirements* are specs)")
- **The litmus test** — "Will the user check the deliverable against this? Is it objectively verifiable?"
- **Hierarchy guidance** — how to pick areas; when to decompose into sub-specs (`parentId`); how to write checkable requirement text; constraints are don't-dos
- **Capture protocol** — capture immediately when a requirement is stated (at task start, on clarifications, on requirement changes — use `supersedes` when the user changes a requirement); check `get_task_specs` first to avoid duplicates
- **Verification protocol** — at task end (and after compaction): `get_task_specs` → verify each → `update_spec_status` with evidence → continue until all MUST specs met
- **Anti-patterns** — don't capture context/praise/opinions/vague preferences; don't capture behavior criticism (that's `capture_feedback`); don't invent specs; don't self-certify unverifiable specs — ask the user
- **Tool reference** — capture_spec / get_task_specs / update_spec_status / `/clear-specs`

---

## 9. Implementation steps (granular)

1. **Scaffold** — create `~/.pi/agent/skills/spec-memory/SKILL.md` + empty `projects/` dir (gitignore-friendly, no JSON until first capture).
2. **Extension: spec types + helpers** (in `index.ts`, new section after feedback-memory helpers):
   - `SpecItem`, `SpecTask` interfaces; `getSpecDir()`, `getCurrentTaskFile()`, `loadCurrentTask()`, `saveCurrentTask()`, `archiveCurrentTask()`, `generateSpecId()`, `formatSpecTree()` (flat → indented tree), `specsForPrompt()`.
3. **Extension: state** — add `currentTaskId`, `currentTaskPath`, `currentTaskTitle` to `ContinuationState`; reset on rotation.
4. **Extension: tools** — register `capture_spec`, `get_task_specs`, `update_spec_status` (signatures in §5, execution patterns copied from the feedback tools incl. try/catch-free storage but defensive file I/O).
5. **Extension: `/clear-specs` command** — confirm dialog → archive → clear state → notify.
6. **Extension: rotation** — extend the existing `input` handler (currently resets `taskToolCallCount`) with the §4 rule.
7. **Extension: compaction injection** — in `session_compact` handler, append spec recap after the feedback checkpoints block (guard: `config.specMemoryIntegration` && specs exist).
8. **Extension: verification injection** — in `agent_settled` handler, build the specs section before feedback checkpoints; set `verificationSentAt`; keep the simple-Q&A gate untouched.
9. **Config + docs** — `auto-continue.json` (`specMemoryIntegration: true`), update `PLAN.md`, add this file.
10. **Compile check** — `npx tsc --noEmit` filtered for the known external-type noise; bracket-balance check.

## 10. Test matrix (after `/reload`)

| # | Scenario | Expected |
|---|---|---|
| 1 | User gives a build task with 3 requirements | `current-task.json` created with specs in correct areas; tool output confirms capture |
| 2 | Mid-task clarification adds a spec | Same task file gains the spec |
| 3 | User changes a requirement | Old spec `obsolete`, new one `supersedes` it |
| 4 | Compaction mid-task | Compaction continuation prompt contains the spec recap tree |
| 5 | Task completes with unmet MUST spec | Verification prompt lists specs; agent continues working (does not declare done) |
| 6 | Task completes with all specs met | Agent calls `update_spec_status` with evidence per spec, then declares complete |
| 7 | Spec not objectively verifiable | Agent marks `partial` + "needs user confirmation" and asks the user |
| 8 | Simple Q&A | No spec section, no verification (existing gate) |
| 9 | Verified task + new user input | Auto-rotation archives task; new task starts fresh |
| 10 | `/clear-specs` | Confirm dialog → archive → empty state |
| 11 | Different project dir | Specs isolated per project |

## 11. Explicit non-goals (v1)

- No automatic/keyword parsing of user input for specs (rejected approach — same rationale as feedback-memory: unacceptably reductionist).
- No cross-task spec inheritance (a standing "project-wide" spec list is a possible v2 — e.g., recurring constraints merged into every task's verification).
- No archived-spec search tool (v2 candidate).
- No changes to length/premature/abort/error continuation prompts.
