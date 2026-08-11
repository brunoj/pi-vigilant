---
name: spec-memory
description: Capture hard specifications (requirements, constraints, acceptance criteria, formats, deliverables) the user states during a task, store them hierarchically, and verify them at task end. Use this for deliverable/constraint requirements — behavior criticism stays in feedback-memory.
---

# Spec-Memory

This skill lets you **capture hard specifications** (requirements, constraints, acceptance criteria, formats, deliverables) that the user states during a task execution, **store them hierarchically**, and **verify them** at task end before declaring completion.

The auto-continue extension provides these tools:

- **`capture_spec`** — Document a new hard specification
- **`get_task_specs`** — Retrieve all specs for the current task as a hierarchical tree
- **`update_spec_status`** — Mark a spec as met/not-met with evidence
- **`/clear-specs`** — User-only command to clear all spec memory

## When to Capture Specifications — Use Your Judgment

This skill is for **hard specifications** — requirements, constraints, acceptance criteria, formats, deliverables — that the user explicitly states and that you can **objectively verify** against the delivered work.

### Signs it's a specification (use reasoning, not pattern matching):

- **Explicit requirement**: "the API must return 401 for unauthenticated requests", "must be in TypeScript", "must validate input"
- **Constraint / don't-do**: "no external runtime dependencies", "must not require sudo", "must work offline", "don't touch the auth module"
- **Acceptance criterion**: "tests must pass", "must handle empty input gracefully", "error messages must be user-friendly"
- **Format / contract**: "output JSON with exactly `{id, name}` fields", "ISO-8601 timestamps", "must return 200 OK"
- **Deliverable**: "write a README with install + usage sections", "include a CHANGELOG.md"
- **Quality bar**: "keep it under 500 lines", "must not have console.log statements in production code"
- **Priority**: "this is a must-have", "should do this but nice-to-have"

### Signs it's NOT a specification:

- **Behavior criticism**: "you keep stopping at the first solution" → use `capture_feedback`
- **Context / background**: "the user base is 10k people" — unless it changes a requirement
- **Casual conversation, praise, opinions**
- **Vague uncheckable preferences**: "make it nice" — or capture only with the concrete interpretation written down
- **Meta-questions about the system**: "how does spec-memory work?"
- **Specs from other projects/sessions**: only capture specs stated in the current session for the current task
- **Task instruction**: "build me a REST API" — that's the task; the *requirements* within it are specs

### The litmus test

Ask yourself: **"Will the user check the deliverable against this statement? Can I objectively verify it?"**

- **Yes to both** → **CAPTURE** as a spec
- **No** → don't capture (may be context, opinion, or behavior criticism)

### Examples (not exhaustive — use your judgment):

**DO capture (these are verifiable deliverables/constraints):**
- "The API must return 401 for unauthenticated requests" (can be tested)
- "Output must be JSON with exactly `id` and `name` fields" (can be inspected)
- "No external runtime dependencies" (can be checked with `npm list`)
- "Must handle empty input gracefully" (can be tested)
- "Write a README with install + usage sections" (can be inspected)
- "Keep it under 500 lines" (can be counted)
- "Error messages must be user-friendly, not stack traces" (can be reviewed)

**DO NOT capture (these are not verifiable or are behavior):**
- "Build me a REST API" (task instruction, not a spec)
- "The user base is 10k people" (context, not a requirement)
- "Make it nice" (vague, uncheckable)
- "You keep stopping at the first solution" (behavior criticism → use `capture_feedback`)
- "Great work on this!" (praise)
- "How does spec-memory work?" (meta question)
- "In my other project, you did X wrong" (different session)

## How to Use

### 1. Capture specifications immediately

When the user states a hard requirement/constraint, call `capture_spec` **before responding**. Do not argue or deflect. The user is defining what the deliverable must be.

```tool
capture_spec
  requirement: "The API must return 401 for unauthenticated requests"
  area: "functionality"
  priority: "must"
  sourceQuote: "\"The API must return 401 for unauthenticated requests\""
```

**How to determine area:**
- **functionality**: core features, endpoints, business logic
- **ui-ux**: user interface, user experience
- **performance**: speed, latency, throughput
- **security**: authentication, authorization, encryption
- **error-handling**: error messages, graceful degradation
- **testing**: test coverage, test requirements
- **documentation**: README, docs, comments
- **compatibility**: browser support, version compatibility
- **constraints**: don't-dos, limitations, must-nots
- **format**: output formats, input formats, data schemas
- **data**: data storage, data validation
- **deployment**: server requirements, dependencies
- **other**: anything else

**Default to `must` priority.** Only use `should` if the user explicitly says it's important but not blocking; `nice-to-have` for optional features.

**When to use `parentId`:** Decompose broad specs into sub-specs. E.g., "the API must be secure" → parent; then "all endpoints must require authentication" and "passwords must be hashed" → sub-specs with `parentId` set.

**When to use `supersedes`:** The user changes a requirement. Mark the old spec as `obsolete` and set `supersedes` to its ID.

### 2. Check specs before finishing

Before declaring work complete, call `get_task_specs` and verify each spec against the actual deliverable.

```tool
get_task_specs
```

### 3. Update spec status with evidence

For each spec with a terminal status (`met` or `not-met`), provide concrete evidence:

```tool
update_spec_status
  id: "spc-1752-48391"
  status: "met"
  evidence: "npm test passes; build log line 12 shows 401 response for unauthenticated requests"
```

**CRITICAL:** If a spec cannot be objectively verified, mark it as `partial` with note "needs user confirmation" and **ask the user**. Never self-certify unverifiable specs.

### 4. Clear specs manually

When a task is complete and you want to start fresh, use the user command:

```
/clear-specs
```

## How Hierarchy Works

Specs are stored **flat** in JSON (easy to update) and displayed **hierarchically** (tree structure):

- **Task** — one file per task (`current-task.json`), archived on rotation
- **Area** — 12 fixed categories (functionality, security, testing, constraints, format, etc.)
- **Spec** — one checkable requirement with priority, status, evidence
- **Sub-spec** — arbitrary depth via `parentId` chains, rendered indented

Example tree:
```
=== TASK SPECIFICATIONS ===
[functionality]
  [must][open]  POST /todos returns 401 for unauthenticated requests
    [should][met] 401 body is JSON {"error":"unauthorized"}
[constraints]
  [must][open]  no external runtime dependencies
```

## When Auto-Continue Fires

Auto-continue injects specs at two points:

1. **Post-compaction** — After context compaction, the continuation prompt includes a spec recap so requirements survive context loss.
2. **Final verification** — At `agent_settled`, the verification prompt includes a spec checklist. The agent must verify each spec, record evidence, and continue working until all MUST specs are met.

**Simple Q&A** (no tool calls) skips verification entirely.

## Critical Rules

1. **Capture immediately** — When a hard requirement is stated, capture before responding.

2. **Be specific and checkable** — Vague specs are useless. "Make it secure" is bad. "All endpoints must require authentication" is good.

3. **Correct priority** — Default to `must`. Only use `should` or `nice-to-have` when the user explicitly says so.

4. **Provide evidence** — Terminal statuses (`met`/`not-met`) require concrete evidence (test output, build result, code inspection).

5. **Ask the user for unverifiable specs** — If you can't objectively verify a spec, mark it `partial` and ask the user.

6. **Use judgment, not keywords** — The user won't always say "specification." They'll state requirements naturally. Recognize the intent.

## Tools Reference

| Tool | Purpose |
|------|---------|
| `capture_spec` | Capture a new hard specification |
| `get_task_specs` | Retrieve all specs for the current task |
| `update_spec_status` | Mark a spec as met/not-met with evidence |
| `/clear-specs` | User-only command to clear all specs |

## Relationship to Feedback-Memory

| Statement type | System |
|---|---|
| "You keep stopping at the first solution" (behavior) | feedback-memory |
| "The API must return 401 for unauthenticated requests" (deliverable/constraint) | **spec-memory** |

**Behavior criticism** → feedback-memory. **Deliverable/constraint requirements** → spec-memory.

## Anti-Patterns

- **Don't capture context or background** — unless it changes a requirement (e.g., "user base is 10k" becomes "must handle 10k concurrent users" → capture the latter).
- **Don't capture vague preferences** — "make it nice" → either reject or capture with concrete interpretation.
- **Don't capture behavior criticism** — that's `capture_feedback`, not here.
- **Don't invent specs** — only capture what the user explicitly states.
- **Don't self-certify unverifiable specs** — ask the user.
- **Don't use keyword matching** — use judgment. The user won't always say "specification."
