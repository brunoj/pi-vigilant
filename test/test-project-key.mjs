/**
 * Project key contract (spec store + feedback store).
 *
 * The key is a published contract: other extensions read the spec store under
 * it. These vectors are pinned byte-for-byte; the consuming extension's suite
 * pins the SAME vectors, so a change on either side fails a build.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";

const { sanitizeRoot, projectKey, legacyKey, projectStoreDir, __clearProjectCache } = await createJiti(import.meta.url).import(
  new URL("../lib/project.ts", import.meta.url).pathname,
);

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  cond ? pass++ : fail++;
};

console.log("=== pinned vectors (shared with the consumer's suite) ===");
const VECTORS = [
  ["/home/brunoj/pi-aia-asf", "home-brunoj-pi-aia-asf"],
  ["/home/brunoj", "home-brunoj"],
  ["/tmp/a b/c", "tmp-a-b-c"],
  ["/" + "x".repeat(100) + "/proj", "x".repeat(72) + "-b17978e1"],
  ["", "default"],
];
for (const [input, want] of VECTORS) {
  check(`sanitizeRoot(${JSON.stringify(input.slice(0, 28))})`, sanitizeRoot(input) === want, sanitizeRoot(input));
}

console.log("=== identity ===");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vig-key-")));
try {
  const repo = path.join(root, "api");
  fs.mkdirSync(path.join(repo, "packages", "web"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  __clearProjectCache();
  check("a subdirectory resolves to its repo's key", projectKey(path.join(repo, "packages", "web")) === projectKey(repo));
  const other = path.join(root, "other", "api");
  fs.mkdirSync(other, { recursive: true });
  check("NEGATIVE: same basename, different root, different key", projectKey(other) !== projectKey(repo));
  check("the legacy key is the basename", legacyKey(repo) === "api");

  console.log("=== migration copies, never moves ===");
  const base = path.join(root, "store");
  const legacyDir = path.join(base, "projects", "api");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "current-task.json"), '{"taskId":"t1"}');
  const dir = projectStoreDir(base, repo);
  check("the new store is under the root key", path.basename(dir) === projectKey(repo));
  check("legacy data is copied across", fs.readFileSync(path.join(dir, "current-task.json"), "utf8").includes("t1"));
  check("the legacy copy is left intact (a same-named checkout still sees its data)", fs.existsSync(path.join(legacyDir, "current-task.json")));
  check("the migration is recorded", fs.existsSync(path.join(dir, ".migrated-from")));
  fs.writeFileSync(path.join(dir, "current-task.json"), '{"taskId":"t2"}');
  projectStoreDir(base, repo);
  check("NEGATIVE: a second call never re-copies over newer data", fs.readFileSync(path.join(dir, "current-task.json"), "utf8").includes("t2"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);
