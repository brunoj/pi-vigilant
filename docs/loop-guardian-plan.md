# Loop Guardian — Plan

> Status: **awaiting approval** (do not implement until approved)
> Feature: detect an agent stuck in an endless analysis loop and forcefully steer it out
> Target: pi-vigilant (next minor after 0.2.0)

## 1. Problem statement

The agent (LLM-driven) sometimes enters an endless loop: it works on **one task
(usually analysis) that has many steps**, but **always returns from its tail to
its head** and **never progresses to the next step**. The user's manual fix —
injecting `"YOU ARE LOOPING ENDLESSLY! STOP THAT AND START IMPLEMENTING
IMMEDIATELY"` — reliably resolves it. pi-vigilant should detect this pattern and
inject an equivalent steer automatically.

Requirements (from the user):
- Detect the loop (rock-solid, no false negatives for the described scenario).
- Forcefully steer the agent to stop looping — the same mechanism as the manual
  injection.
- **Not overeager** — a guardian, not a nag: legitimate work must never be
  interrupted.
- Good guardian: calibrated, escalates, never spams.

## 2. Research findings

### 2.1 External (industry consensus)

The failure signature is well documented across agent frameworks:

1. **Identical repeated calls** — same tool, same arguments, **same result**,
   repeated. The result must be identical, not just the call: polling loops
   (result changes from "running" to "done") are legitimate and must not fire.
   (Particula Tech, "Stop AI Agents Looping on the Same Failed Tool Call";
   LangChain issue #26019; LangGraph issue #6731.)
2. **Cyclic tool-call patterns** — the agent oscillates through the same
   sequence of tools (the classic "tail → head" death spiral). Detected by
   repeating-sequence analysis over a window of recent calls.
3. **Idle/status-only loops** — repeated calls to read-only/status tools with
   no mutation. (Princeu3/agent-loop-detector; DEFAULT_IDLE_ONLY_TOOLS.)

Claude Code's built-in "doom loop detector" uses three guards: `maxTurns`
(divergence), stop hooks (premature convergence), and **repetition detection**
(oscillation) — the last is the model for this feature.

Key insight from the literature: **a step limit is a backstop, not a detector**.
Recursion limits / iteration caps only cap total steps; they never inspect
whether steps make progress. The detector must hash `(tool, canonical(args),
result)` and act on repeats — and it must **change the observation** (inject a
steer) because "an identical result carries no new information for the model to
correct against."

Also relevant: lossy context summarization can erase the record that a tool was
already called, re-triggering loops (the model re-derives the same action from
scratch). This is a *cause* the loop guardian should still catch — after
compaction the same `(tool, args, result)` tuple recurs, and the guardian fires.

### 2.2 Internal (pi host API, verified against 0.84.2)

The extension API exposes exactly what we need:

| Event | Payload | Use |
|---|---|---|
| `tool_execution_start` | `toolCallId, toolName, args` | capture args |
| `tool_execution_end` | `toolCallId, toolName, result, isError` | capture result |
| `input` | `{text, source}` | reset on genuine user input (`source !== "extension"`) |
| `model_select` | `model, previousModel` | reset (new model may legitimately redo) |
| `session_compact` | — | reset (context changed; re-derivation is recovery, not loop) |
| `agent_start` / `agent_end` | — | no reset (loop spans turns; auto-continue must not clear state) |

**Intervention mechanism (verified)**: `pi.sendUserMessage(text, { deliverAs:
"steer" })` sends a **real user-role message**. While the agent is streaming
(mid-loop), `deliverAs: "steer"` queues it into the agent's **steering queue**,
which the loop pulls between tool calls — i.e. the message reaches the model
**inside the current turn**, exactly like the user typing it. This is the
faithful reproduction of the manual fix. (`sendUserMessage` → `prompt(text,
{streamingBehavior: "steer"})` in agent-session.js; `steer()` enqueues to
`steeringQueue` in pi-agent-core.)

Notes:
- `sendUserMessage` "always triggers a turn" when idle — acceptable: if the
  agent just stopped and the detector fires, starting a turn with the steer is
  the desired behavior.
- The steer arrives as `source: "extension"` in `input` — pi-vigilant's own
  `input` handler already ignores extension-sourced input, so the loop guardian
  must explicitly reset its counters when it sends a steer (see §3.4).
- Extension loader uses jiti (`jiti.import(extensionPath)`), so relative
  imports from `index.ts` work — a `lib/` module is feasible.

## 3. Design

### 3.1 Signature

For every completed tool execution:

```
sig = hash(toolName, canonicalArgs, resultHash, isError)
canonicalArgs = JSON.stringify(args, sorted keys, whitespace-normalized)  // bounded to 4 KB
resultHash = hash(JSON.stringify(result).slice(0, 64 KB))
```

Canonicalization matters: `{"q": "SELECT 1"}` and `{"q":"SELECT 1"}` must hash
identically. Result hashing is what separates a loop from a poll: same call +
**same result** = no new information.

### 3.2 Detectors (three, all conservative)

**D1 — identical-repeat** (the tight loop): the same `sig` appears ≥
`loopRepeatThreshold` (default **3**) times within the last
`loopWindowSize` (default **64**) calls, with **no progress marker** between the
first and last occurrence. Catches: re-reading the same file, re-running the
same failing command, re-grepping the same query.

**D2 — cycle** (the user's exact case: "returns from its tail to its head"):
the last `p * loopCycleRepeats` calls form `loopCycleRepeats` (default **2**)
identical blocks of period `p`, for any `p` in `[2, loopMaxCycleLength]`
(default **32**), with no progress marker inside. Catches: a long analysis
sequence (read A → grep B → read C → …) that restarts from the top. Fires after
2 full passes — enough to be certain, without waiting for a third.

**D3 — analysis stall** (no exact repetition, but no progress): the last
`loopStallCalls` (default **24**) calls contain **no write/edit** AND at least
`loopStallRepeatRatio` (default **0.5**) of them returned a result hash already
seen in the window (low information gain — re-reading the same information).
Catches: analysis that wanders (different args each time) but keeps re-reading
what it already read. A first-pass analysis reading *new* files never fires.

### 3.3 Progress markers (reset the repeat counters)

- `write` / `edit` tool executions — file mutation, the strongest signal.
- Any tool result whose hash is **new** in the window (information gain) —
  resets D1/D2 counters (they only care about exact repeats anyway).
- Genuine user input (`input`, `source !== "extension"`).
- `model_select` — the model changed; re-derivation is legitimate.
- `session_compact` — context changed; re-reading is recovery, not a loop.
- The guardian's own steer (see §3.4).

### 3.4 Intervention ladder

| Level | Trigger | Action |
|---|---|---|
| 1 | D1/D2/D3 fires, no steer in the last `loopCooldownMs` (default **90 s**) | `sendUserMessage(steer1, {deliverAs: "steer"})`; reset counters; `steerCount = 1` |
| 2 | Fires again after level 1 (post-cooldown, same task) | `sendUserMessage(steer2, {deliverAs: "steer"})` (stronger, names the pattern); reset counters; `steerCount = 2` |
| 3 | Fires again after level 2, or `steerCount >= loopSteerMax` (default **2**) | `ctx.ui.notify` the operator: agent is stuck, manual intervention may be needed. No more steers. |

Steer 1 (specific, calm but firm):
> ⚠️ Loop detected: you have called `{tool}` {n} times with identical arguments
> and received the same result. You are not making progress. Stop this analysis
> now and take the next concrete action — if the task requires implementation,
> start writing code; if you are done analyzing, state your conclusion and
> proceed. Do not repeat work you have already done.

Steer 2 (matches the user's manual fix in spirit):
> ⚠️ You are STILL looping. You repeated {pattern} after being told to stop.
> STOP. Do not call `{tool}` again. Take the next concrete action now: implement
> or report. If you cannot proceed, say so instead of repeating.

The steer is a **nudge, never a hard block** — a false positive costs one
message, not a halted run. That is the "not overeager" trade-off: detection is
conservative, intervention is cheap.

### 3.5 Configuration (all in pi-vigilant.json, with safe defaults)

```jsonc
{
  "loopGuardian": true,               // master switch (default ON)
  "loopRepeatThreshold": 3,           // D1: identical (tool,args,result) repeats
  "loopCycleRepeats": 2,              // D2: full passes of the cycle
  "loopMaxCycleLength": 32,           // D2: max period p
  "loopWindowSize": 64,               // calls to remember (must hold 2 passes of the longest cycle)
  "loopStallCalls": 24,               // D3: no-mutation budget
  "loopStallRepeatRatio": 0.5,        // D3: min fraction of repeated results
  "loopSteerMax": 2,                  // steers before operator notify
  "loopCooldownMs": 90000             // min gap between interventions
}
```

Defaults are deliberately conservative: D1 needs 3 identical results, D2 needs
2 full passes, D3 needs 24 no-mutation calls with ≥50% repeated results. All
values tunable; `loopGuardian: false` is the hard off switch.

### 3.6 Modularity

`index.ts` is 2,917 lines. The loop guardian adds ~500 lines. Per the standing
rule ("split when it starts fighting back"), extract to
**`lib/loop-guardian.ts`** (pure logic: signature, window, detectors — no pi
API), imported by `index.ts` (jiti supports relative imports). The event wiring
stays in `index.ts`. Tarball `files` array gains `lib/`; `npm pack --dry-run`
must be re-verified.

## 4. Adversarial analysis

### 4.1 False positives (must NOT fire)

| Scenario | Why it does not fire |
|---|---|
| Polling a status endpoint (result changes) | result hash differs → no repeat |
| Running the same test twice | 2 < threshold 3 |
| Re-reading a file after an edit | write/edit = progress marker → counters reset |
| Long first-pass research (new files) | D3 requires ≥50% repeated results |
| Retry with backoff (error changes) | result differs |
| Model re-reads once after a steer | counters reset on steer; 1 < 3 |
| User says "continue" | `input` reset |
| Auto-continue (extension input) | `source === "extension"` → no reset (same task) |
| Subagent with same prompt, different output | result hash differs |
| Compaction then re-read | `session_compact` reset (recovery, not loop) |

### 4.2 False negatives (limits, documented honestly)

- **Text-only loops** (model writes long analysis with no tool calls): no
  events → no signal. Out of scope for v1; future work = message-similarity
  detection (Jaccard on word sets of consecutive assistant messages), off by
  default.
- **Varying cycles** (each pass reads a different file): D1/D2/D3 all miss if
  results are always new. D3 catches it only once ≥50% of results repeat.
  Accepted: a genuinely wandering analysis with all-new information is
  indistinguishable from legitimate research without task semantics.
- **Very long cycles** (p > 32): D2 misses; D1 may still catch repeated
  sub-steps. `loopMaxCycleLength` is tunable, and `loopWindowSize` must be
  raised alongside it (it must hold `loopMaxCycleLength * loopCycleRepeats`
  calls).

### 4.3 Meta-safety

- The guardian itself must not loop: cooldown between steers, `loopSteerMax`
  cap, counters reset on its own steer, no re-fire within the cooldown.
- `sendUserMessage` wrapped in try/catch (agent may reject messages mid-state).
- No interaction with the compaction fallback (separate state) and no
  `ctx.compact()` calls.
- The steer is a user message → the host's per-turn overflow-recovery state
  resets (role "user"), which is harmless here.

## 5. Test plan

### 5.1 Unit (test/test-loop-guardian.mjs, wired into run-all.sh)

Harness additions: fake `pi.sendUserMessage` capture (assert content +
`deliverAs: "steer"`), event emitters for `tool_execution_start/end`, `input`,
`model_select`, `session_compact`.

- D1: fires at threshold 3; not at 2; not when result differs; not when args
  differ; not when a write/edit intervenes; not when a new result intervenes.
- D2: fires for A,B,C,A,B,C (period 3, 2 passes); not for A,B,C,A,B,D; not when
  a write/edit is inside; period-1 is D1's job; long period (p=30) fires.
- D3: fires at 24 no-mutation calls with ≥50% repeated results; not with all-new
  results; not when a write occurs at call 23.
- Resets: user input, model_select, session_compact, own steer.
- Escalation: steer1 → steer2 → notify; no 3rd steer; cooldown respected
  (second detection within 90 s → no steer).
- Config: all 9 keys parsed; garbage falls back; `loopGuardian: false` → silent;
  master switch off → no sendUserMessage, no notify.
- Signature: canonicalization (key order, whitespace); result truncation bound;
  isError included.
- Meta: no double-fire on one event; try/catch on sendUserMessage.

### 5.2 Live E2E (reuse /tmp/pv-compact-e2e pattern)

- **Loop E2E**: provider proxy that always answers with the same tool call
  (same args) → real pi runs the loop → guardian fires → **assert the steer
  text appears in the provider request** (proxy logs requests) → proxy then
  returns a final text answer → turn completes, exit 0.
- **Negative E2E**: proxy that answers with real work (varied tool calls +
  final answer) → no steer in any request.
- Both run against the real extension via `-e`, private agent dir, synthetic
  session — same rigor as the compaction E2E.

## 6. Release

Follows the ASF release workflow: full suite green (172 + ~50 new) → live E2E
green → `npm run release minor` → 0.3.0 (CHANGELOG, annotated tag, push, npm
publish) → re-verify published artifact against the installed copy → update
local install.

## 7. Open questions (for approval)

1. **Default ON or OFF?** Recommendation: **ON** with the conservative defaults
   above (it is a guardian; the user asked for it to work). `loopGuardian:
   false` remains the escape hatch.
2. **Steer only, or also notify on level 1?** Recommendation: no separate
   notify — the steer is a visible user message in the transcript; notify only
   at level 3 (give-up).
3. **Thresholds** — accept the defaults above, or start stricter (repeat 4,
   cycle 3 passes)?
4. **Text-only loops** — confirm out of scope for v1 (future work).
