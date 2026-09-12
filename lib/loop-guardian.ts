/**
 * Loop Guardian — detects an agent stuck in an endless loop and describes the
 * intervention to take.
 *
 * Pure logic: no pi API, no file I/O. The extension (index.ts) wires the tool
 * events and performs the intervention (steer / notify).
 *
 * Three detectors, all conservative:
 *   D1 identical-repeat — the same (tool, canonical args, result, isError)
 *      tuple appears `repeatThreshold` times in the window. The result must be
 *      identical too: a poll whose result changes is progress, not a loop.
 *   D2 cycle — the last `cycleRepeats` blocks of period p (2..maxCycleLength)
 *      are identical. This is the "returns from its tail to its head" case.
 *   D3 analysis stall — `stallCalls` consecutive calls with no file mutation
 *      and at least `stallRepeatRatio` of them returning a result already seen
 *      (low information gain). A first-pass analysis reading new files never
 *      fires.
 *
 * Progress (a write/edit tool execution) ends the loop episode: the window and
 * the steer budget reset. Genuine user input, a model change, and a compaction
 * also reset (call reset()).
 *
 * Interventions escalate: steer 1 (names the pattern) → steer 2 (stronger) →
 * one operator notification, then silence until the episode resets. A cooldown
 * prevents spamming. The guardian never blocks — a false positive costs one
 * message, not a halted run.
 */

export interface LoopGuardianConfig {
  /** D1: identical (tool, args, result) repeats before firing. */
  repeatThreshold: number;
  /** D2: full passes of the cycle required. */
  cycleRepeats: number;
  /** D2: maximum cycle period p. */
  maxCycleLength: number;
  /** Number of recent calls to remember. */
  windowSize: number;
  /** D3: no-mutation budget (clamped to windowSize). */
  stallCalls: number;
  /** D3: minimum fraction of repeated results in the stall window. */
  stallRepeatRatio: number;
  /** Steers before the operator is notified (then silence). */
  steerMax: number;
  /** Minimum gap between interventions, in ms. */
  cooldownMs: number;
}

export interface LoopDetection {
  kind: "identical" | "cycle" | "stall";
  toolName?: string;
  count?: number;
  period?: number;
  repeats?: number;
  calls?: number;
  /** Human-readable description of the repeated pattern. */
  detail: string;
}

export type LoopAction =
  | { action: "steer"; level: 1 | 2; message: string; detection: LoopDetection }
  | { action: "notify"; message: string; detection: LoopDetection };

interface CallRecord {
  sig: string;
  toolName: string;
  resultHash: string;
  isError: boolean;
}

/** Tools that mutate files — genuine progress, ends a loop episode. */
const MUTATION_TOOLS = new Set(["write", "edit"]);

const MAX_ARGS_CHARS = 4096;
const MAX_RESULT_CHARS = 262144;

/** FNV-1a 64-bit hash (non-cryptographic; collision-safe enough for a guardian). */
export function hashString(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(36);
}

/** Canonical JSON: object keys sorted recursively, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(record[k]))
      .join(",") +
    "}"
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export class LoopGuardian {
  private readonly config: LoopGuardianConfig;
  private readonly now: () => number;
  private calls: CallRecord[] = [];
  private steerCount = 0;
  private lastSteerAt = Number.NEGATIVE_INFINITY;
  private notified = false;

  constructor(options: { config: LoopGuardianConfig; now?: () => number }) {
    this.config = {
      ...options.config,
      // The window bounds how far back D3 can look.
      stallCalls: Math.min(options.config.stallCalls, options.config.windowSize),
    };
    this.now = options.now ?? (() => Date.now());
  }

  /** Full reset: user input, model change, compaction. */
  reset(): void {
    this.calls = [];
    this.steerCount = 0;
    this.lastSteerAt = Number.NEGATIVE_INFINITY;
    this.notified = false;
  }

  /**
   * Record one completed tool execution and run the detectors.
   * Mutation tools (write/edit) end the loop episode and return null.
   */
  recordToolCall(
    toolName: string,
    args: unknown,
    result: unknown,
    isError: boolean,
  ): LoopAction | null {
    if (MUTATION_TOOLS.has(toolName)) {
      this.reset();
      return null;
    }

    const resultHash = this.resultHash(result);
    const sig = this.signature(toolName, args, resultHash, isError);
    this.calls.push({ sig, toolName, resultHash, isError });
    if (this.calls.length > this.config.windowSize) {
      this.calls = this.calls.slice(-this.config.windowSize);
    }

    const detection = this.detect();
    if (!detection) return null;

    // Cooldown: give the previous intervention time to work.
    if (this.now() - this.lastSteerAt < this.config.cooldownMs) return null;

    if (this.steerCount >= this.config.steerMax) {
      if (this.notified) return null;
      this.notified = true;
      return { action: "notify", message: this.notifyMessage(detection), detection };
    }

    const level = (this.steerCount + 1) as 1 | 2;
    this.steerCount += 1;
    this.lastSteerAt = this.now();
    // The intervention interrupts the episode: only NEW looping after the
    // steer may escalate.
    this.calls = [];
    return { action: "steer", level, message: this.steerMessage(level, detection), detection };
  }

  private signature(
    toolName: string,
    args: unknown,
    resultHash: string,
    isError: boolean,
  ): string {
    let argsText: string;
    try {
      argsText = canonicalJson(args);
    } catch {
      argsText = String(args);
    }
    return [toolName, truncate(argsText, MAX_ARGS_CHARS), resultHash, isError ? "err" : "ok"].join(
      "\u0000",
    );
  }

  private resultHash(result: unknown): string {
    let text: string;
    try {
      text = JSON.stringify(result) ?? "";
    } catch {
      text = String(result);
    }
    return hashString(truncate(text, MAX_RESULT_CHARS));
  }

  private detect(): LoopDetection | null {
    const n = this.calls.length;
    if (n === 0) return null;

    // D1 — identical repeat of the most recent call anywhere in the window.
    // (Mutations reset the window, so a repeat can never span real progress.)
    const last = this.calls[n - 1];
    let count = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (this.calls[i].sig === last.sig) count += 1;
    }
    if (count >= this.config.repeatThreshold) {
      return {
        kind: "identical",
        toolName: last.toolName,
        count,
        detail: `called \`${last.toolName}\` ${count} times with identical arguments and the same result`,
      };
    }

    // D2 — cycle: the last `cycleRepeats` blocks of period p are identical.
    const maxP = Math.min(this.config.maxCycleLength, Math.floor(n / this.config.cycleRepeats));
    for (let p = 2; p <= maxP; p++) {
      const span = p * this.config.cycleRepeats;
      let ok = true;
      for (let b = 1; b < this.config.cycleRepeats; b++) {
        const off = n - span + b * p;
        for (let i = 0; i < p; i++) {
          if (this.calls[off + i].sig !== this.calls[n - span + i].sig) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
      }
      if (ok) {
        return {
          kind: "cycle",
          period: p,
          repeats: this.config.cycleRepeats + 1,
          detail: `repeated the same sequence of ${p} tool calls ${this.config.cycleRepeats + 1} times with identical results`,
        };
      }
    }

    // D3 — analysis stall: no mutation for stallCalls, low information gain.
    if (n >= this.config.stallCalls) {
      const span = this.calls.slice(n - this.config.stallCalls);
      const seen = new Set<string>();
      let repeats = 0;
      for (const c of span) {
        if (seen.has(c.resultHash)) repeats += 1;
        else seen.add(c.resultHash);
      }
      if (repeats / span.length >= this.config.stallRepeatRatio) {
        return {
          kind: "stall",
          calls: span.length,
          detail: `made ${span.length} tool calls without modifying any file, and most of them re-read information you already have`,
        };
      }
    }

    return null;
  }

  private steerMessage(level: 1 | 2, d: LoopDetection): string {
    if (level === 1) {
      return (
        `⚠️ Loop detected: you have ${d.detail}. You are not making progress. ` +
        `Stop this analysis now and take the next concrete action — if the task requires ` +
        `implementation, start writing code; if you are done analyzing, state your conclusion ` +
        `and proceed. Do not repeat work you have already done.`
      );
    }
    return (
      `⚠️ You are STILL looping. You ${d.detail} after being told to stop. STOP. ` +
      `Do not repeat this again. Take the next concrete action now: implement or report. ` +
      `If you cannot proceed, say so instead of repeating.`
    );
  }

  private notifyMessage(d: LoopDetection): string {
    return (
      `The agent is stuck in a loop (${d.detail}) and did not respond to ` +
      `${this.config.steerMax} steering intervention(s). Manual intervention may be needed.`
    );
  }
}
