/**
 * Project identity for spec-memory and feedback-memory.
 *
 * The key used to be `path.basename(process.cwd())`. That broke two ways:
 *
 *   1. `cd` into a subdirectory and the project's specs and feedback vanish —
 *      a new, empty store is opened under the subdirectory's name.
 *   2. Two checkouts sharing a basename (`~/work/api`, `~/other/api`) share one
 *      store, so one project's met specs and feedback leak into the other.
 *
 * The key is the git work-tree root when there is one, else the absolute cwd,
 * sanitized for the filesystem. This key is a published contract: extensions
 * that read the spec store derive it with the same algorithm, and
 * test/test-project-key.mjs pins input→key vectors so it cannot drift silently.
 *
 * Data written under the old basename key is COPIED (never moved) to the new key
 * on first use, so an upgrade loses nothing and two same-named checkouts that
 * used to share a store each keep a copy of what they used to see.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const CACHE = new Map<string, string>();
const CACHE_MAX = 64;

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return "default";
  }
}

/** The git work-tree root for `cwd`, or `cwd` itself when it is not a repo. */
export function projectRoot(cwd: string = safeCwd()): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    if (out) return out;
  } catch {
    /* not a repo, no git, or git too slow — the cwd is the honest answer */
  }
  return cwd;
}

/** Filesystem-safe key for a root path. Pinned by test/test-project-key.mjs. */
export function sanitizeRoot(root: string): string {
  let key = String(root || "")
    .replace(/^[/\\]+/, "")
    .replace(/[/\\]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 72);
  if (!key) key = "default";
  const full = String(root || "");
  if (full.length > 72) {
    const h = createHash("sha1").update(full).digest("hex").slice(0, 8);
    key = `${key.replace(/-+$/, "")}-${h}`;
  }
  return key;
}

/** The store key for a directory. Cached; the cache is bounded. */
export function projectKey(cwd: string = safeCwd()): string {
  const hit = CACHE.get(cwd);
  if (hit) return hit;
  const key = sanitizeRoot(projectRoot(cwd));
  if (CACHE.size >= CACHE_MAX) CACHE.clear();
  CACHE.set(cwd, key);
  return key;
}

/** The pre-0.9 key: the cwd basename. Only used to find data to migrate. */
export function legacyKey(cwd: string = safeCwd()): string {
  return path.basename(cwd) || "default";
}

/** Test hook. */
export function __clearProjectCache(): void {
  CACHE.clear();
}

/**
 * `<base>/projects/<key>` for the current project, copying the legacy
 * basename directory across the first time the new one is asked for.
 * A copy failure leaves the new directory absent; callers create it lazily.
 */
export function projectStoreDir(base: string, cwd: string = safeCwd()): string {
  const key = projectKey(cwd);
  const dir = path.join(base, "projects", key);
  if (fs.existsSync(dir)) return dir;
  const legacy = path.join(base, "projects", legacyKey(cwd));
  if (legacy !== dir && fs.existsSync(legacy)) {
    try {
      fs.cpSync(legacy, dir, { recursive: true, errorOnExist: false, force: false });
      fs.writeFileSync(
        path.join(dir, ".migrated-from"),
        `${legacyKey(cwd)}\n${new Date().toISOString()}\n`,
      );
    } catch {
      /* the new store starts empty; the legacy copy is untouched */
    }
  }
  return dir;
}
