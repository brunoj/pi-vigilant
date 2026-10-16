/**
 * Declared standing obligations.
 *
 * A general container, nothing more. Vigilant verifies per-task specifications
 * the agent captures from the user; this module lets any *source* declare
 * standing obligations that apply to every run and re-open rather than staying
 * met. It holds **declarations, never content**: vigilant never interprets the
 * `source` string and knows nothing about who wrote any particular file.
 *
 * The litmus test for every kind added here (trigger kind or signal kind) is:
 * **it must be justifiable without naming the consumer that needed it.** A
 * format that accretes one product's methodology is how a general container
 * quietly becomes that product in JSON instead of prose.
 *
 * With zero declarations present this module contributes nothing and behaviour
 * is exactly what it was before it existed.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Shape ──────────────────────────────────────────────────────────────────

/** Same shape as the spec trace in index.ts, reused rather than reinvented. */
export interface ObligationTrace {
  outcome: string;
  codePath: string;
  testFile?: string;
  assertion?: string;
}

/**
 * Objective check behind an obligation. Closed set on purpose:
 *  - `scan` — a regular expression over the changed files (the completeness
 *    engine's own idiom: a pattern either matches or it does not).
 *  - `test` — a named test file that must contain a named assertion.
 * Anything else is a judgement call wearing a kind, and does not belong here.
 */
export interface ObligationSignal {
  kind: "scan" | "test";
  /** kind=scan */
  pattern?: string;
  /** kind=scan — what the finding is called */
  marker?: string;
  /** kind=test */
  file?: string;
  /** kind=test */
  assertion?: string;
}

export interface Obligation {
  id: string;
  requirement: string;
  area: string;
  priority: "must" | "should" | "nice-to-have";
  /** Trigger expressions from the closed vocabulary below. */
  trigger: string[];
  /**
   * Enforcement class, rendered honestly:
   *  H — hard: cannot be declared done without satisfying it
   *  M — mechanical verdict produced, but only if the check is run
   *  S — self-attested: an expectation, not a blocker. Never blocks.
   */
  class?: "H" | "M" | "S";
  /** Standing obligations re-open each run with per-task evidence. */
  recurring?: boolean;
  /**
   * Filled in by the loader from the declaring file. Opaque to vigilant: it is
   * carried so a verdict can be attributed, never interpreted or branched on.
   */
  source?: string;
  signal?: ObligationSignal;
  trace?: ObligationTrace;
}

/** An obligation as returned by the loader: `source` is always filled in. */
export type LoadedObligation = Obligation & { source: string };

export interface ObligationFile {
  /** Opaque to vigilant. Never interpreted, never branched on. */
  source: string;
  obligations: Obligation[];
}

export interface ObligationLoadResult {
  obligations: LoadedObligation[];
  /** Rejected declarations, with the reason. Reported, never swallowed. */
  errors: string[];
  /** Files read — so a zero result can be told apart from a missing one. */
  filesRead: string[];
}

// ─── Trigger vocabulary (closed set) ────────────────────────────────────────
//
// Every kind below is a general concept: a path, a tool name, an area, the
// text of a specification. None of them is a piece of any one product's
// methodology, and a new kind must be defensible without naming the consumer
// that asked for it.

const TRIGGER_PREFIXES = [
  "area:",
  "path-glob:",
  "tool:",
  "when-spec-matches:",
] as const;

const TRIGGER_LITERALS = ["always"] as const;

export interface TriggerContext {
  /** Areas present in the current task's captured specs. */
  areas?: string[];
  /** Relative paths touched this session. */
  paths?: string[];
  /** Tool names called this session. */
  tools?: string[];
  /** Requirement text of the current task's specs. */
  specText?: string[];
}

/** Parse one trigger expression. Returns an error string if it is not in the closed set. */
export function validateTrigger(expr: string): string | null {
  const t = expr.trim();
  if (t === "") return "empty trigger";
  if ((TRIGGER_LITERALS as readonly string[]).includes(t)) return null;
  for (const p of TRIGGER_PREFIXES) {
    if (t.startsWith(p)) {
      const value = t.slice(p.length).trim();
      if (value === "") return `trigger "${expr}" has an empty value after "${p}"`;
      if (p === "when-spec-matches:") {
        try {
          new RegExp(value);
        } catch (e) {
          return `trigger "${expr}" is not a valid regular expression: ${(e as Error).message}`;
        }
      }
      return null;
    }
  }
  return (
    `unknown trigger "${expr}" — the accepted vocabulary is ` +
    `${[...TRIGGER_LITERALS, ...TRIGGER_PREFIXES.map((p) => p + "<value>")].join(", ")}`
  );
}

/** Does this trigger hold for the current run? Unknown triggers never match. */
export function triggerMatches(expr: string, ctx: TriggerContext): boolean {
  const t = expr.trim();
  if (t === "always") return true;
  if (t.startsWith("area:")) {
    const want = t.slice(5).trim();
    return (ctx.areas || []).some((a) => a.toLowerCase() === want.toLowerCase());
  }
  if (t.startsWith("path-glob:")) {
    const glob = t.slice(10).trim();
    const re = globToRegExp(glob);
    return (ctx.paths || []).some((p) => re.test(p));
  }
  if (t.startsWith("tool:")) {
    const want = t.slice(5).trim();
    return (ctx.tools || []).some((n) => n.toLowerCase() === want.toLowerCase());
  }
  if (t.startsWith("when-spec-matches:")) {
    const reSrc = t.slice("when-spec-matches:".length).trim();
    try {
      const re = new RegExp(reSrc, "i");
      return (ctx.specText || []).some((s) => re.test(s));
    } catch {
      return false;
    }
  }
  return false;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`(^|/)${escaped}$`);
}

// ─── Validation ─────────────────────────────────────────────────────────────

const PRIORITIES = ["must", "should", "nice-to-have"] as const;
const CLASSES = ["H", "M", "S"] as const;
const SIGNAL_KINDS = ["scan", "test"] as const;

/** Validate one parsed obligation. Returns a list of problems (empty = valid). */
export function validateObligation(o: unknown, where: string): string[] {
  const problems: string[] = [];
  if (!o || typeof o !== "object") return [`${where}: not an object`];
  const rec = o as Record<string, unknown>;

  const str = (k: string, required = true) => {
    const v = rec[k];
    if (typeof v === "string" && v.trim() !== "") return v;
    if (required) problems.push(`${where}: "${k}" must be a non-empty string`);
    return undefined;
  };

  str("id");
  str("requirement");
  str("area");

  if (!PRIORITIES.includes(rec.priority as (typeof PRIORITIES)[number])) {
    problems.push(`${where}: priority must be one of ${PRIORITIES.join(", ")}`);
  }
  if (rec.class !== undefined && !CLASSES.includes(rec.class as (typeof CLASSES)[number])) {
    problems.push(`${where}: class must be one of ${CLASSES.join(", ")} when present`);
  }

  const trig = rec.trigger;
  if (!Array.isArray(trig) || trig.length === 0) {
    problems.push(`${where}: trigger must be a non-empty array`);
  } else {
    for (const t of trig) {
      if (typeof t !== "string") {
        problems.push(`${where}: trigger entries must be strings`);
        continue;
      }
      const err = validateTrigger(t);
      if (err) problems.push(`${where}: ${err}`);
    }
  }

  if (rec.signal !== undefined) {
    const s = rec.signal as Record<string, unknown>;
    if (!s || typeof s !== "object" || typeof s.kind !== "string") {
      problems.push(`${where}: signal.kind is required`);
    } else if (!(SIGNAL_KINDS as readonly string[]).includes(s.kind)) {
      problems.push(`${where}: signal.kind must be one of ${SIGNAL_KINDS.join(", ")}`);
    } else if (s.kind === "scan" && typeof s.pattern !== "string") {
      problems.push(`${where}: signal.kind "scan" requires signal.pattern`);
    } else if (s.kind === "scan" && typeof s.pattern === "string") {
      try {
        new RegExp(s.pattern);
      } catch (e) {
        problems.push(`${where}: signal.pattern is not a valid regular expression: ${(e as Error).message}`);
      }
    } else if (s.kind === "test") {
      if (typeof s.file !== "string") problems.push(`${where}: signal.kind "test" requires signal.file`);
      if (typeof s.assertion !== "string")
        problems.push(`${where}: signal.kind "test" requires signal.assertion`);
    }
  }

  if (rec.trace !== undefined) {
    const t = rec.trace as Record<string, unknown>;
    if (!t || typeof t !== "object" || typeof t.outcome !== "string" || typeof t.codePath !== "string") {
      problems.push(`${where}: trace requires outcome and codePath`);
    }
  }

  return problems;
}

/** Validate a whole parsed declaration file. */
export function validateObligationFile(parsed: unknown, where: string): { file?: ObligationFile; errors: string[] } {
  const errors: string[] = [];
  if (!parsed || typeof parsed !== "object") return { errors: [`${where}: not an object`] };
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.source !== "string" || rec.source.trim() === "") {
    errors.push(`${where}: "source" is required (it identifies who declared this; vigilant never interprets it)`);
  }
  if (!Array.isArray(rec.obligations)) {
    errors.push(`${where}: "obligations" must be an array`);
    return { errors };
  }
  const accepted: Obligation[] = [];
  rec.obligations.forEach((o, i) => {
    const problems = validateObligation(o, `${where} obligations[${i}]`);
    if (problems.length) errors.push(...problems);
    else accepted.push(o as Obligation);
  });
  // A file with no valid obligations is still a valid file: a source may ship
  // obligations that this project does not trigger. Only parse-level failures
  // drop the file.
  return {
    file: { source: String(rec.source || "unknown"), obligations: accepted },
    errors,
  };
}

// ─── Loading ────────────────────────────────────────────────────────────────

export interface ObligationLocations {
  /** Directory holding `obligations.d/*.json` (usually beside pi-vigilant.json). */
  extensionDir: string;
  /** Project root; an optional `.vigilant/obligations.json` is read from here. */
  projectDir: string;
  /**
   * Agent directory. When present, declarations are also read from
   * `<agentDir>/obligations.d/*.json` (the general drop-in location) and from
   * every sibling extension's own `obligations.d/` — so any installed extension
   * may ship its own declarations without this module knowing what any of them
   * are for.
   */
  agentDir?: string;
}

/** Every directory this loader will look at, in load order. */
export function declarationLocations(loc: ObligationLocations): string[] {
  const files: string[] = [];
  const pushDir = (dir: string) => {
    try {
      if (fs.existsSync(dir)) {
        for (const n of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
          files.push(path.join(dir, n));
        }
      }
    } catch {
      // A directory we cannot list is reported by the caller via readJson errors.
    }
  };

  pushDir(path.join(loc.extensionDir, "obligations.d"));

  if (loc.agentDir) {
    pushDir(path.join(loc.agentDir, "obligations.d"));
    // Sibling extensions: each may ship declarations beside its own entry point.
    try {
      const extRoot = path.join(loc.agentDir, "extensions");
      if (fs.existsSync(extRoot)) {
        for (const name of fs.readdirSync(extRoot).sort()) {
          pushDir(path.join(extRoot, name, "obligations.d"));
        }
      }
    } catch {
      /* best effort */
    }
  }

  const projectFile = path.join(loc.projectDir, ".vigilant", "obligations.json");
  try {
    if (fs.existsSync(projectFile)) files.push(projectFile);
  } catch {
    /* best effort */
  }
  return files;
}

function readJson(file: string): { parsed?: unknown; error?: string } {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return { parsed: JSON.parse(raw) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Load every declaration that applies to this run.
 *
 * Sources, in order: `<extensionDir>/obligations.d/*.json`, then the optional
 * `<projectDir>/.vigilant/obligations.json`. Nothing here is required to exist:
 * no files means no obligations and no errors, which is the behaviour that predates this module.
 */
export function loadObligations(loc: ObligationLocations): ObligationLoadResult {
  const obligations: LoadedObligation[] = [];
  const errors: string[] = [];
  const filesRead: string[] = [];

  const files = declarationLocations(loc);

  const seenIds = new Map<string, string>();

  for (const file of files) {
    const { parsed, error } = readJson(file);
    if (error) {
      // A declaration that cannot be read is reported, never treated as absent.
      errors.push(`${path.basename(file)}: could not be read (${error})`);
      continue;
    }
    filesRead.push(file);
    const { file: validated, errors: fileErrors } = validateObligationFile(parsed, path.basename(file));
    errors.push(...fileErrors);
    if (!validated) continue;
    for (const o of validated.obligations) {
      const key = `${validated.source}/${o.id}`;
      if (seenIds.has(key)) {
        errors.push(`${path.basename(file)}: duplicate obligation id "${o.id}" (already declared in ${seenIds.get(key)})`);
        continue;
      }
      seenIds.set(key, path.basename(file));
      obligations.push({ ...o, source: validated.source });
    }
  }

  return { obligations, errors, filesRead };
}

/** Which obligations apply, given what this run has touched. */
export function applicableObligations(
  obligations: LoadedObligation[],
  ctx: TriggerContext,
): LoadedObligation[] {
  return obligations.filter((o) => o.trigger.some((t) => triggerMatches(t, ctx)));
}

/**
 * A short, stable fingerprint of a declaration's substance. Used to decide
 * whether a recurring obligation's evidence from an earlier run still applies:
 * if the requirement changed, the obligation re-opens rather than inheriting a
 * verdict earned against different words.
 */
export function obligationFingerprint(o: Obligation): string {
  const parts = [
    o.requirement.trim().toLowerCase(),
    o.priority,
    o.class || "-",
    o.signal ? `${o.signal.kind}:${o.signal.pattern || o.signal.file || ""}:${o.signal.assertion || ""}` : "-",
    o.trace ? `${o.trace.outcome}|${o.trace.codePath}|${o.trace.testFile || ""}|${o.trace.assertion || ""}` : "-",
  ];
  return parts.join("\u0000");
}
