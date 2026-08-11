# Changelog

All notable changes to pi-vigilant are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-11

### Added

- **Auto-continue** after output-length stops, premature stops, and threshold auto-compaction, with `deliverAs: "steer"` for compaction continuations (fixes queued-message race).
- **Spec-memory**: `capture_spec`, `get_task_specs`, `update_spec_status` tools; hierarchical task storage (area → spec → sub-spec), dedup guard, `supersedes` contradiction handling, task rotation after verified tasks, `/clear-specs` user command.
- **Feedback-memory**: `capture_feedback`, `resolve_feedback`, `get_feedback_checkpoints`; project/global scope, category compilation, auto-resolve contradictions, `/clear-feedback` user command.
- **Final verification** prompt injection on `agent_settled` for complex tasks (15-min cooldown, only after tool calls).
- **Compaction recap** injection: spec tree + feedback checkpoints survive context loss.
- Config via `pi-vigilant.json` (all features toggleable, defaults on).
