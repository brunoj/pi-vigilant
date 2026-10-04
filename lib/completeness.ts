/**
 * Completeness guard — the deliverable that only LOOKS done.
 *
 * The failure this exists for: a build is declared complete but turns out to be
 * a stub, only half wired, or populated with hallucinated/test data. Three kinds
 * are detectable mechanically over the files a session actually touched:
 *
 *   stub             the code says it does not do the thing
 *                    (TODO, FIXME, "not implemented", placeholder, coming soon)
 *   fabricated-data  invented or seed records presented as real content
 *                    (lorem ipsum, John Doe, example.com, "fake users")
 *   unverified-fact  a placeholder standing in for a fact nobody looked up
 *                    (TBD, ???, [insert …], YOUR_API_KEY in shipped code)
 *
 * A fourth kind — something built but never wired to a caller — needs judgement
 * and is not detected here; the audit text instructs on it instead.
 *
 * Test / spec / fixture paths are EXCLUDED on purpose: faking at a test seam is
 * correct practice, and flagging it would train everyone to ignore the guard.
 *
 * Pure functions, no dependencies, safe to call on every completion: git calls
 * are bounded (06b Rule 15) and the file set is capped.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type CompletenessCategory =
  | "stub"
  | "fabricated-data"
  | "unverified-fact";

export interface CompletenessFinding {
  file: string;
  line: number;
  category: CompletenessCategory;
  marker: string;
  text: string;
}

export interface CompletenessAudit {
  findings: CompletenessFinding[];
  /** Files actually read (after exclusion filters). */
  scannedFiles: number;
  /** How the file set was obtained — reported so the guard never overclaims. */
  source: "git-baseline+worktree" | "git-worktree" | "mtime" | "none";
  /** Set when the scan could not run: the guard must say so, not pass silently. */
  error?: string;
  /** Ready-to-inject report ("" when there is nothing to report). */
  text: string;
  truncated: boolean;
}

export interface CompletenessOptions {
  /** Only files modified at/after this time are considered by the mtime path. */
  sinceMs?: number;
  /** Commit the session started from: diff <baseline>..HEAD covers session commits. */
  baselineRef?: string;
  maxFiles?: number;
  maxFindings?: number;
  perFileFindings?: number;
  maxFileBytes?: number;
}

// ─── What counts as a stub or fake ─────────────────────────────────────────

interface Pattern {
  category: CompletenessCategory;
  marker: string;
  re: RegExp;
}

/**
 * Deliberately precise. Every pattern here has to survive being read by an
 * agent that is tired and wants to move on: a noisy guard gets ignored, and
 * then the real stubs ship.
 */
const PATTERNS: Pattern[] = [
  // ── stub: the code admits it is not real ──────────────────────────────
  { category: "stub", marker: "TODO", re: /\bTODO\b/ },
  { category: "stub", marker: "FIXME", re: /\bFIXME\b/ },
  { category: "stub", marker: "XXX", re: /\bXXX\b/ },
  {
    category: "stub",
    marker: "not implemented",
    re: /\b(?:not|un)[ -]implemented\b|NotImplemented\w*|\bE_NOTIMPL\b/i,
  },
  {
    // "placeholder" as prose, not as an HTML/attribute name (placeholder="…").
    category: "stub",
    marker: "placeholder",
    re: /\bplaceholder\b(?!\s*[:=])/i,
  },
  { category: "stub", marker: "coming soon", re: /\bcoming soon\b/i },
  {
    category: "stub",
    marker: "stubbed out",
    re: /\bstub\b(?:ed|s|bed)?\b(?!\s*[:=])|\btemporar(?:y|ily) (?:hardcod|return|wired|implement)/i,
  },

  // ── fabricated data: invented content standing in for real content ────
  { category: "fabricated-data", marker: "lorem ipsum", re: /\blorem\s+ipsum\b/i },
  {
    category: "fabricated-data",
    marker: "placeholder person",
    re: /\b(?:John|Jane)\s+Doe\b|\bJohn\s+Smith\b|\b(?:foo|bar|baz)@\w+\.\w{2,}\b/i,
  },
  {
    category: "fabricated-data",
    marker: "example domain",
    re: /\b(?:www\.)?example\.(?:com|org|net)\b|@example\.(?:com|org|net)\b/i,
  },
  { category: "fabricated-data", marker: "ACME", re: /\bACME\b/ },
  {
    category: "fabricated-data",
    marker: "placeholder phone/address",
    re: /\b555[- ]?\d{3,4}\b|\+\s?1[- ]?555\b|\b123\s+Main\s+St(?:reet)?\b/i,
  },
  {
    category: "fabricated-data",
    marker: "fake data set",
    re: /\b(?:fake|dummy|mock|sample|seed|stub|test|dummy)[ _-]?(?:data|records?|users?|rows?|items?|entries|payload|response|content|products?|orders?)\b/i,
  },

  // ── unverified facts: a hole where a real fact should be ──────────────
  {
    category: "unverified-fact",
    marker: "TBD",
    re: /\bTBD\b|\bTBC\b|\bTO\s+BE\s+DECIDED\b/i,
  },
  { category: "unverified-fact", marker: "???", re: /\?\?\?/ },
  {
    category: "unverified-fact",
    marker: "fill-in hole",
    re: /\[\s*(?:insert|add|fill|put|write|supply)\b[^\]\n]{0,40}\]/i,
  },
  {
    category: "unverified-fact",
    marker: "credential hole",
    re: /\bYOUR_[A-Z0-9_]{3,}\b|<your[-_][a-z0-9_-]{2,}>|\b(?:API_KEY|TOKEN|SECRET|PASSWORD)_HERE\b/i,
  },
];

// ─── What is out of scope for the scan ─────────────────────────────────────

/** Fakes at a test seam are correct practice — flagging them kills the guard. */
const TEST_PATH_RE =
  /(^|\/)(?:tests?|__tests?__|spec|specs|fixtures?|__mocks__|cypress|playwright)(\/|$)|\.(?:test|spec)\.[^.]+$|(^|\/)(?:test|conftest)[_./][^.]*$|_test\.(?:go|py|rb)$|^test_/i;

const DEPENDENCY_PATH_RE =
  /(^|\/)(?:node_modules|vendor|\.venv|venv|target|dist|build|out|coverage|\.git|\.cache|\.next|\.nuxt|site-packages|egg-info)(\/|$)/;

const GENERATED_RE =
  /(?:\.min\.(?:js|css)$|\.lock$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|composer\.lock$|Cargo\.lock$|poetry\.lock$|uv\.lock$|\.svg$|\.map$|\.snap$|snapshot)/i;

/** Docs are covered by the documentation rule; prose legitimately quotes these words. */
const DOC_EXT_RE = /\.(?:md|markdown|rst|txt|adoc|changes|license|notice)$/i;

/** Only text that can plausibly contain the deliverable's behaviour. */
const SCANNABLE_EXT_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|c|h|cpp|hpp|cc|swift|scala|clj|ex|exs|erl|lua|pl|dart|vue|svelte|astro|html|htm|css|scss|less|sql|sh|bash|zsh|ps1|yaml|yml|toml|ini|env|proto|graphql|gql|r|rmd|jl|zig|nim|ml|hs|tf|hcl)$/i;

export function isScannablePath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  if (TEST_PATH_RE.test(p)) return false;
  if (DEPENDENCY_PATH_RE.test(p)) return false;
  if (GENERATED_RE.test(p)) return false;
  if (DOC_EXT_RE.test(p)) return false;
  return SCANNABLE_EXT_RE.test(p);
}

// ─── Bounded git / filesystem access ───────────────────────────────────────

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 5000, // 06b Rule 15: nothing in a completion path may hang
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Working-tree changes: staged, unstaged and untracked (incl. inside dirs). */
function worktreeFiles(root: string): string[] | null {
  const out = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (out === null) return null;
  const files: string[] = [];
  for (const raw of out.split("\n")) {
    if (!raw.trim()) continue;
    let p = raw.slice(2).trim();
    // "R  old -> new" / rename entries: keep the destination.
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) p = p.slice(arrow + 4);
    p = p.replace(/^"|"$/g, "");
    if (p) files.push(p);
  }
  return files;
}

/** Files changed between the session's starting commit and HEAD. */
function committedFiles(root: string, baselineRef: string): string[] | null {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!head) return null;
  const out = git(root, ["diff", "--name-only", `${baselineRef}...${head.trim()}`]);
  if (out === null) return null;
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function headRef(root: string): string | null {
  const out = git(root, ["rev-parse", "HEAD"]);
  const sha = out?.trim();
  return sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/** Fallback for non-git workspaces: files written during this session. */
function recentlyModifiedFiles(root: string, sinceMs: number, cap: number): string[] {
  const found: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", "vendor", ".venv", "venv", "target", ".cache", ".next", ".nuxt"]);
  const walk = (dir: string, depth: number) => {
    if (found.length >= cap || depth > 12) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (found.length >= cap) return;
      if (skip.has(name) || name.startsWith(".")) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, depth + 1);
      else if (st.isFile() && st.mtimeMs >= sinceMs - 2000) found.push(abs.slice(root.length + 1));
    }
  };
  walk(root, 0);
  return found;
}

// ─── The scan ──────────────────────────────────────────────────────────────

function scanFile(root: string, rel: string, perFile: number, maxBytes: number): CompletenessFinding[] {
  const out: CompletenessFinding[] = [];
  let content: string;
  try {
    content = readFileSync(join(root, rel), "utf8");
  } catch {
    return out; // deleted/renamed mid-session — not a completeness finding
  }
  if (content.length > maxBytes) content = content.slice(0, maxBytes);

  const lines = content.split("\n");
  const limit = Math.min(lines.length, 20000);
  for (let i = 0; i < limit && out.length < perFile; i++) {
    const line = lines[i];
    if (!line || line.length > 2000) continue;
    for (const { category, marker, re } of PATTERNS) {
      if (!re.test(line)) continue;
      // Every matching marker on the line is reported: a single line can be a
      // stub AND fake data AND a fact hole, and hiding two of them understates
      // what the agent has to fix.
      out.push({
        file: rel,
        line: i + 1,
        category,
        marker,
        text: line.trim().replace(/\s+/g, " ").slice(0, 110),
      });
    }
  }
  return out;
}

/**
 * Scan the files this session changed for stub / fabricated-data / unverified
 * markers. Never throws: a scan that cannot run reports `error` instead of
 * reporting a clean deliverable.
 */
export function auditCompleteness(
  root: string,
  opts: CompletenessOptions = {},
): CompletenessAudit {
  const maxFiles = opts.maxFiles ?? 300;
  const maxFindings = opts.maxFindings ?? 25;
  const perFile = opts.perFileFindings ?? 4;
  const maxBytes = opts.maxFileBytes ?? 400_000;

  let files: string[] = [];
  let source: CompletenessAudit["source"] = "none";
  let error: string | undefined;

  const baseline = opts.baselineRef && /^[0-9a-f]{7,40}$/i.test(opts.baselineRef) ? opts.baselineRef : null;
  const wt = worktreeFiles(root);
  if (wt !== null) {
    const committed = baseline ? committedFiles(root, baseline) : null;
    files = [...new Set([...(committed ?? []), ...wt])];
    source = baseline && committed ? "git-baseline+worktree" : "git-worktree";
  } else if (typeof opts.sinceMs === "number") {
    files = recentlyModifiedFiles(root, opts.sinceMs, maxFiles);
    source = "mtime";
  } else {
    error = "not a git workspace and no session start time — nothing was scanned";
  }

  const eligible = files.filter(isScannablePath);
  const scannable = eligible.slice(0, maxFiles);
  const capped = eligible.length > maxFiles;
  const findings: CompletenessFinding[] = [];
  let scannedFiles = 0;
  let truncated = capped;

  for (const rel of scannable) {
    if (findings.length >= maxFindings) {
      truncated = true;
      break;
    }
    scannedFiles++;
    const hits = scanFile(root, rel, perFile, maxBytes);
    if (hits.length) findings.push(...hits);
  }

  return {
    findings: findings.slice(0, maxFindings),
    scannedFiles,
    source,
    error,
    truncated,
    text: renderAudit(findings.slice(0, maxFindings), {
      scannedFiles,
      source,
      totalFiles: files.length,
      truncated,
    }),
  };
}

/** Human-readable, bounded report for the verification prompt. */
export function renderAudit(
  findings: CompletenessFinding[],
  meta: { scannedFiles: number; source: CompletenessAudit["source"]; totalFiles: number; truncated: boolean },
): string {
  if (findings.length === 0) return "";
  const byFile = new Map<string, CompletenessFinding[]>();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }
  const lines: string[] = [];
  for (const [file, hits] of byFile) {
    lines.push(`  ${file}`);
    for (const h of hits) {
      lines.push(`    ${h.line}: [${h.category}/${h.marker}] ${h.text}`);
    }
  }
  if (meta.truncated) {
    lines.push(`  (list capped at ${findings.length} findings across ${meta.scannedFiles} scanned file(s) of ${meta.totalFiles} changed — scan the rest yourself)`);
  }
  return lines.join("\n");
}

/** Current HEAD, for capturing the session baseline. Null when not a repo. */
export function currentRevision(root: string): string | null {
  return headRef(root);
}
