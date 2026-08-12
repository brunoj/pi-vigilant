# Changelog

All notable changes to pi-vigilant are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
