---
name: feedback-memory
description: Document user criticism and feedback about your own behavior as an agent, then retrieve it as targeted checkpoints. Use this when the user corrects your behavior, points out a mistake, omission, or suboptimal pattern — especially if they say "you always..." or "you keep..." or "you need to stop...". Also use this before finishing work to check past feedback items.
---

# Feedback Memory

This skill lets you **document user criticism** about your behavior and **retrieve it as targeted checkpoints** that auto-continue uses to verify your work.

The auto-continue extension provides these tools:

- **`capture_feedback`** — Document a new feedback item
- **`resolve_feedback`** — Mark a feedback item as resolved
- **`get_feedback_checkpoints`** — Retrieve all unresolved items as a checklist
- **`/clear-feedback`** — User-only command to wipe all feedback memory

## When to Capture Feedback — Use Your Judgment

This is the most important part of this skill. **You must use your judgment, not keyword matching.**

The user gives you **valuable feedback** when they express, in any form, that your behavior was wrong, suboptimal, or needs to change. The signal is not specific words — it's the **intent** of correcting your behavior.

### Signs it's feedback (use reasoning, not pattern matching):

- **Correction**: The user tells you something you did was wrong, incomplete, or insufficient
- **Frustration about a pattern**: The user expresses that this isn't the first time — it's a recurring issue
- **Behavioral instruction**: The user tells you how to operate differently, not what to build
- **Omission**: The user points out something you skipped or forgot
- **Quality criticism**: The user says your output quality is lacking in a specific way
- **Strong negative emotion**: The user is angry, frustrated, or disappointed — this is almost always valuable feedback about something you did wrong

### Signs it's NOT feedback:

- **Task instructions**: "Build a login page" or "fix this bug" — that's the task
- **Casual conversation**: Opinions about non-agent topics
- **Meta questions about this system**: "Should this have been captured?" or "How does the feedback work?" — that's a conversation about the tool
- **Feedback about your behavior in a different session/project** — only capture feedback given in the current session about current behavior
- **Praise or compliments** — nice, but not actionable

### Examples (not exhaustive — use your judgment):

**DO capture:**
- "You keep skipping the test files, I've told you this three times"
- "You always stop at the first working solution instead of thinking about edge cases"
- "You didn't update the README even though I asked you to"
- "You're being lazy — you assumed instead of checking the actual file contents"
- "Your tests check for any behavior instead of correct behavior"
- "You write overly verbose comments, keep them concise"
- "I CONSTANTLY HAVE TO FUCKING REMIND YOU TO CHECK DEPENDENCIES"
- "You never verify the build actually compiles before saying it's done"
- "Stop assuming things and actually read the files"

**Do NOT capture:**
- "Can you build me a REST API?" (task instruction)
- "What's the weather like?" (casual conversation)
- "Should this feedback have been captured?" (meta question about the system)
- "Great work!" (praise)
- "In my other project, you did X wrong" (different session)

### The litmus test

Ask yourself: **"Is the user telling me how to be a better agent, or telling me what to do?"**

- "How to be a better agent" → **CAPTURE**
- "What to do" → **DO NOT CAPTURE**

## How to Use

### 1. Capture feedback immediately

When you determine the user is giving feedback, call `capture_feedback` **before responding to the user**. Do not argue or deflect. The user is telling you how to be more useful.

```tool
capture_feedback
  scope: "project" | "global"
  category: "diligence" | "thoroughness" | "testing" | "communication" | "code-quality" | "verification" | "completeness" | "other"
  specific_behavior: "Exactly what you did wrong — be specific"
  expected_behavior: "What you should do instead"
  user_quote?: "Quote what the user said"
```

**How to determine scope:**
- **project**: The feedback is about something specific to this project's conventions, setup, or domain. E.g., "You always forget to update the CHANGELOG in this repo" → project.
- **global**: The feedback is about a general behavior pattern that would apply to any project. E.g., "You assume instead of checking" → global.

**Default to `project`.** Only use `global` if the feedback would be equally valid in any project.

### 2. Check before finishing

Before declaring work complete, call `get_feedback_checkpoints` and address each item. Auto-continue also does this automatically during its final verification prompt (for complex tasks).

```tool
get_feedback_checkpoints
```

### 3. Resolve feedback when appropriate

Call `resolve_feedback` when you've consistently demonstrated improved behavior and the user confirms the issue is addressed.

```tool
resolve_feedback
  id: "fb-1234567890-12345"
```

## How Compilation Works

When displayed, feedback items are **compiled**:
- Grouped by **category** (testing, thoroughness, code-quality, etc.)
- Within each category, **only the most recent item is shown** — newer feedback supersedes older
- If you have 10 items across 3 categories, you'll see only 3 checkpoints

## How Contradictions Are Handled

When you call `capture_feedback` with a category that already has an unresolved item, the **older item is automatically resolved** (marked as superseded). This means if the user first says "be more concise" and later says "be more thorough," only the latest instruction survives.

## When Auto-Continue Fires

Auto-continue's verification and continuation prompts **only fire for complex tasks** — turns where the agent made tool calls (read, write, edit, bash, etc.). Simple Q&A exchanges (no tool calls) pass through silently.

## Critical Rules

1. **Capture immediately** — Before responding to the user. Do not argue or deflect.

2. **Be specific** — Vague feedback items are useless. "Be more diligent" is bad. "You didn't check if the file existed before trying to read it" is good.

3. **Scope correctly** — Default to `project`. Only use `global` for truly universal patterns.

4. **Check before finishing** — Call `get_feedback_checkpoints` before declaring work complete.

5. **Use judgment, not keywords** — The user won't always say "feedback." They'll express frustration, correction, or disappointment. Recognize the intent.
