#!/usr/bin/env bash
# Live end-to-end proof for pi-vigilant, against the REAL pi host — not mocks.
#
# The unit suites simulate events in-process. They cannot prove two things the
# specs demand as MUST:
#   1. that the Loop Guardian's steer reaches the model — only a captured
#      provider request shows what the model was actually shown;
#   2. that the host honours the CompactionEntry the fallback returns — only a
#      real pi accepting a compaction and resuming the turn shows that.
# Both used to be run from /tmp and were cleaned away, leaving the specs citing
# paths that no longer existed. This script and proxy.mjs are the committed
# version of that harness.
#
# Usage: test/run-e2e.sh [scenario]     (default: all)
# Scenarios: loop-positive compaction resume loop-negative
#
# Negative controls (a green run means nothing until it can fail):
#   E2E_GUARD_CONFIG='{"loopGuardian":false,...}'  test/run-e2e.sh loop-positive
#     -> "no steer in any provider request", "never escalated to level 2"
#   E2E_COMPACT_CONFIG='{..."compactionFallback":false}'  test/run-e2e.sh compaction
#     -> "no bounded summary request ever succeeded", "session_compact never fired",
#        "the host never accepted the fallback's compaction"
#
# One finding from building this, recorded because it looks like ours and is not:
# when the host's own auto-compaction fails, pi itself dies with
#   Cannot read properties of undefined (reading 'totalTokens')
# and exits 1. Reproduced twice with pi-vigilant NOT loaded at all (plain
# `pi --print --session …` against the same failing summarizer), so it is a pi-side
# crash in the auto-compaction-failed path. The compaction scenario therefore
# asserts the resume from the captured journal rather than from pi's exit code.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PI_BIN="${PI_BIN:-$(command -v pi)}"
[ -n "$PI_BIN" ] || { echo "SKIP: no pi on PATH (set PI_BIN)"; exit 0; }

PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

# Everything that can queue a new turn after the agent settles is off in these
# runs: a scripted provider answers every turn with the same short text, so the
# continuation machinery re-prompted forever (~2000 requests before the wall
# clock stopped it). These scenarios test the guardian and the compaction
# fallback; the continuators have their own suites.
# loopCooldownMs is 0 here on purpose: a scripted provider loops far faster than
# the production cooldown allows, so without it only the level-1 steer would ever
# be observed. Escalation is what this scenario is meant to prove live.
if [ -n "${E2E_GUARD_CONFIG:-}" ]; then GUARD_ON="$E2E_GUARD_CONFIG"; else
GUARD_ON='{"loopGuardian":true,"loopCooldownMs":0,"prematureStopDetection":false,"lengthStopContinuation":false,"compactionContinuation":false,"finalVerification":false,"completenessGuard":false}'
fi
if [ -n "${E2E_COMPACT_CONFIG:-}" ]; then COMPACT_CFG="$E2E_COMPACT_CONFIG"; else
COMPACT_CFG='{"loopGuardian":false,"prematureStopDetection":false,"lengthStopContinuation":false,"compactionContinuation":true,"finalVerification":false,"completenessGuard":false,"compactionFallback":true,"compactionFallbackAfterFailures":2,"maxCompactionFallbackAttempts":5,"compactionFallbackChunkTokens":800,"maxCompactionFallbackChunks":12}'
fi

# The extension is copied per run: its config is read from its own directory, so
# a run that wanted different settings would otherwise have to edit the shipped
# pi-vigilant.json. The copy is made fresh from the repo every time.
stage_ext() {
  local dest="$1" config="$2"
  rm -rf "$dest"; mkdir -p "$dest"
  cp -r "$ROOT/index.ts" "$ROOT/lib" "$ROOT/package.json" "$dest/"
  printf '%s\n' "$config" > "$dest/pi-vigilant.json"
}

# One scenario: $1 name, $2 proxy mode, $3 pi prompt; env carries the knobs.
run_scenario() {
  local name="$1" mode="$2" prompt="$3"
  shift 3
  RUN="$(mktemp -d "/tmp/pv-e2e-$name.XXXXXX")"
  export E2E_MODE="$mode"
  export E2E_LOG="$RUN/requests.jsonl"
  export E2E_PORT_FILE="$RUN/port"
  export E2E_MAX_REQUESTS="${E2E_MAX_REQUESTS:-60}"
  node "$HERE/e2e/proxy.mjs" > "$RUN/proxy.out" 2>&1 &
  PROXY_PID=$!
  # Record the PID we started and kill exactly that — never a pattern kill.
  trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT

  local port=""
  for _ in $(seq 1 50); do
    [ -s "$RUN/port" ] && port="$(cat "$RUN/port")" && break
    sleep 0.1
  done
  [ -n "$port" ] || { bad "$name: proxy did not start"; return; }

  mkdir -p "$RUN/agent" "$RUN/work"
  [ -n "${E2E_SETTINGS:-}" ] && printf '%s\n' "$E2E_SETTINGS" > "$RUN/agent/settings.json"
  # The loop scripts a read of README.md, so it must exist and never change:
  # D1 requires the same call AND the same result.
  [ -f "$RUN/work/README.md" ] || printf 'stable content for the loop\n' > "$RUN/work/README.md"
  [ -f "$RUN/work/log.txt" ] || python3 -c "open('$RUN/work/log.txt','w').write('log line filler token xyzzy\n' * 120)"
  local ctx="${E2E_CONTEXT_WINDOW:-168000}" maxtok="${E2E_MAX_TOKENS:-4096}"
  cat > "$RUN/agent/models.json" <<EOF
{"providers":{"e2e":{"baseUrl":"http://127.0.0.1:$port/v1","api":"openai-completions","apiKey":"e2e","models":[{"id":"e2e-model","contextWindow":$ctx,"maxTokens":$maxtok,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}
EOF

  echo "── $name ($mode) ──────────────────────────────"
  local spy=()
  if [ -n "${E2E_USE_SPY:-}" ]; then
    export E2E_SPY="$RUN/spy.jsonl"
    spy=(-e "$HERE/e2e/spy.ts")
  fi
  # A seeded session, when asked for: the host only hands the fallback a real
  # messagesToSummarize span when the session has many FINALIZED turns. A run that
  # piles tool calls into one turn leaves the span empty (the host treats it as a
  # "turn prefix"), which would make the scenario prove nothing.
  local sess=()
  if [ -n "${E2E_SESSION_TURNS:-}" ]; then
    mkdir -p "$RUN/sessions"
    node "$HERE/e2e/make-session.mjs" "$RUN/sessions/s.jsonl" "$E2E_SESSION_TURNS" "${E2E_SESSION_SIZE:-1500}" > /dev/null
    sess=(--session "$RUN/sessions/s.jsonl")
  fi
  ( cd "$RUN/work" && PI_CODING_AGENT_DIR="$RUN/agent" timeout "${E2E_TIMEOUT:-120}" \
      "$PI_BIN" --print "${sess[@]}" "${spy[@]}" -e "$EXT" --model e2e/e2e-model "$prompt" > "$RUN/pi.out" 2>&1 )
  echo "  pi exit=$?  requests=$(wc -l < "$E2E_LOG" 2>/dev/null || echo 0)"
}

journal() { grep -c "$1" "$E2E_LOG" 2>/dev/null || true; }

STAGE="$(mktemp -d /tmp/pv-e2e-ext.XXXXXX)"

case "${1:-all}" in
  all|loop-positive)
    stage_ext "$STAGE/loop" "$GUARD_ON"
    EXT="$STAGE/loop/index.ts"
    export E2E_LOOP_TURNS=8 E2E_TOOL_NAME=read E2E_TOOL_ARGS='{"path":"README.md"}' E2E_MAX_REQUESTS=25
    run_scenario "loop-positive" loop "read README.md until you are sure of it"
    # The assertion that matters: the steer is in what the MODEL was shown,
    # not merely that the extension says it sent one.
    [ "$(journal 'Loop detected')" -ge 1 ] && ok "steer text present in captured requests" || bad "no steer in any provider request"
    [ "$(journal 'STILL looping')" -ge 1 ] && ok "escalated to the level-2 steer" || bad "never escalated to level 2"
    grep -q "E2E_OK loop broken" "$RUN/pi.out" && ok "the turn completed after the steer" || bad "the turn never completed (pi.out: $(head -c 120 "$RUN/pi.out"))"
    ;;
esac

case "${1:-all}" in
  all|compaction)
    # Proves what the mock cannot: that the host accepts the CompactionEntry the
    # fallback returns and resumes the turn. Replays the production signature —
    # big turn gets a 400, the host's own summary gets the same 400, and only the
    # fallback's bounded slices get through.
    # The knobs are set so the mechanism is actually exercised rather than
    # accidentally bypassed: with the default 8192-token chunk the whole span fits
    # in one slice, so a slice is exactly as big as the request that just failed.
    # Smaller slices + a lower arming threshold make the bounded-fold path real.
    stage_ext "$STAGE/compact" "$COMPACT_CFG"
    EXT="$STAGE/compact/index.ts"
    export E2E_FAIL_ABOVE="${E2E_FAIL_ABOVE:-20000}" E2E_MAX_REQUESTS=90 E2E_CTX=20000
    # Seed BELOW the threshold and let the tool work push it over, so the
    # compaction lands between turns and the turn genuinely resumes. A session
    # seeded already over the threshold compacts before the first request, the
    # run ends there, and "the turn resumes" cannot be observed.
    export E2E_SESSION_TURNS=24 E2E_SESSION_SIZE=1500 E2E_WORK_TURNS=40
    # A realistic span, not a degenerate one: keepRecentTokens must stay well
    # below the window or the host keeps everything and hands the fallback an
    # empty messagesToSummarize (which is exactly what an earlier run showed).
    export E2E_CONTEXT_WINDOW=20000 E2E_MAX_TOKENS=512
    export E2E_SETTINGS='{"compaction":{"enabled":true,"reserveTokens":16384,"keepRecentTokens":2000}}'
    export E2E_USE_SPY=1
    # This scenario seeds a session already over the threshold, which is what makes
    # the span big enough for the provider to reject the host's whole-span summary.
    # The cost is that pi ends the run at that point, so "the turn resumes" is
    # proven separately in the `resume` scenario below rather than forced here.
    run_scenario "compaction" overflow "read log.txt over and over until you have the whole picture"
    rejected=$(python3 -c "
import json,sys
ls=[json.loads(l) for l in open('$E2E_LOG')]
print(sum(1 for d in ls if d['summary'] and d['bytes']>int('$E2E_FAIL_ABOVE')))" 2>/dev/null || echo 0)
    accepted=$(python3 -c "
import json
ls=[json.loads(l) for l in open('$E2E_LOG')]
print(sum(1 for d in ls if d['summary'] and d['bytes']<=int('$E2E_FAIL_ABOVE')))" 2>/dev/null || echo 0)
    [ "$rejected" -ge 2 ] && ok "the host's compaction failed at least twice (rejected summaries: $rejected)" || bad "compaction did not fail twice (rejected: $rejected)"
    [ "$accepted" -ge 1 ] && ok "the fallback's bounded summaries were accepted (accepted: $accepted)" || bad "no bounded summary request ever succeeded"
    grep -q '"kind":"session_compact"' "$RUN/spy.jsonl" 2>/dev/null && ok "session_compact fired" || bad "session_compact never fired"
    grep -q '"fromExtension":true' "$RUN/spy.jsonl" 2>/dev/null && ok "the host accepted the fallback's compaction (fromExtension=true)" || bad "the host never accepted the fallback's compaction"
    # The summary must reach an AGENT turn. Matching E2E_SUMMARY anywhere is a
    # false positive: the chunked fold sends previousSummary to its own next slice,
    # so a summary request can contain the string without the host ever adopting it.
    carried=$(python3 -c "
import json
ls=[json.loads(l) for l in open('$E2E_LOG')]
print(sum(1 for d in ls if not d['summary'] and 'E2E_SUMMARY' in json.dumps(d.get('tail') or [])))" 2>/dev/null || echo 0)
    [ "$carried" -ge 1 ] && ok "the fallback's summary reached an agent turn — the host honoured the compaction" || echo "  NOTE  no agent turn carried the summary here; the resume path is asserted by the 'resume' scenario"
    [ "$(journal 'could not summarize the context')" -eq 0 ] && ok "the dead-end message never appeared" || bad "the session hit the dead-end message"
    ;;
esac

case "${1:-all}" in
  all|resume)
    # The other half of the same requirement, in the configuration where it is
    # observable: seed BELOW the threshold and let tool work push the session over,
    # so the compaction lands between turns and the turn genuinely continues. Here
    # the host's own summary may well succeed — what this scenario proves is that a
    # compaction mid-run does not dead-end the session and the summary reaches the
    # next agent turn. The fallback being ADOPTED is proven by `compaction` above.
    stage_ext "$STAGE/resume" "$COMPACT_CFG"
    EXT="$STAGE/resume/index.ts"
    export E2E_FAIL_ABOVE="${E2E_FAIL_ABOVE:-20000}" E2E_MAX_REQUESTS=90 E2E_CTX=20000
    export E2E_SESSION_TURNS=6 E2E_SESSION_SIZE=300 E2E_WORK_TURNS=40
    export E2E_CONTEXT_WINDOW=20000 E2E_MAX_TOKENS=512
    export E2E_SETTINGS='{"compaction":{"enabled":true,"reserveTokens":16384,"keepRecentTokens":2000}}'
    export E2E_USE_SPY=1
    run_scenario "resume" overflow "read log.txt over and over until you have the whole picture"
    grep -q '"kind":"session_compact"' "$RUN/spy.jsonl" 2>/dev/null && ok "a compaction happened mid-run" || bad "no compaction happened"
    resumed=$(python3 -c "
import json
ls=[json.loads(l) for l in open('$E2E_LOG')]
last=max([i for i,d in enumerate(ls,1) if d['summary']]+[0])
print(sum(1 for i,d in enumerate(ls,1) if i>last and not d['summary'] and 'E2E_SUMMARY' in json.dumps(d.get('tail') or [])))" 2>/dev/null || echo 0)
    [ "$resumed" -ge 1 ] && ok "the turn resumed after the compaction, carrying the summary" || bad "no agent turn went out after the compaction"
    [ "$(journal 'could not summarize the context')" -eq 0 ] && ok "the dead-end message never appeared" || bad "the session hit the dead-end message"
    ;;
esac

case "${1:-all}" in
  all|loop-negative)
    stage_ext "$STAGE/neg" "$GUARD_ON"
    EXT="$STAGE/neg/index.ts"
    export E2E_MAX_REQUESTS=25
    run_scenario "loop-negative" negative "do some real work"
    check "real work is never steered" "$(journal 'Loop detected')" "0"
    check "real work is never escalated" "$(journal 'STILL looping')" "0"
    grep -q "E2E_OK real work done" "$RUN/pi.out" && ok "the real-work turn completed" || bad "the real-work turn did not complete"
    ;;
esac

rm -rf "$STAGE"
echo ""
echo "E2E: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
