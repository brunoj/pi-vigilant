/**
 * THE ARTIFACT GATE.
 *
 * Why this exists: pi-aia-browser shipped 0.2.1 with a tarball missing a file its
 * own daemon imported. Every gate stayed green, because typecheck reads the working
 * tree, the suite runs from the working tree, and `npm publish` only reports that
 * the upload was accepted. pi-vigilant had the same exposure and no test for it:
 * index.ts imports ./lib/loop-guardian.js, ./lib/completeness.js and
 * ./lib/obligations.js, and a `files` allowlist has to be kept in step by hand.
 *
 * So this checks the PACKED file set — what npm would actually publish — not the
 * working tree, and then asks whether every relative import inside that set
 * resolves inside it. A module that cannot be imported by the installed package is
 * a module that does not exist.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve as rresolve, relative } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO = join(HERE, "..");
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ---------------------------------------------------------------------------
console.log("── 1 — the packed file set ──────────────────────────────────");
// ---------------------------------------------------------------------------
let packed = [];
let packErr = "";
try {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO, encoding: "utf8", timeout: 180000, maxBuffer: 32 * 1024 * 1024,
  });
  const j = JSON.parse(out);
  const entry = Array.isArray(j) ? j[0] : j;
  packed = (entry?.files ?? []).map((f) => (f.path || "").replace(/^\.\//, "")).filter(Boolean);
} catch (e) {
  packErr = String(e.stderr || e.message).slice(0, 400);
}

check("npm pack --dry-run succeeds", packErr === "", packErr);
check("the artifact is not empty", packed.length > 0, `${packed.length} files`);

// The extension entry point is what pi loads; without it the package installs and
// silently does nothing at all.
check("the extension entry point ships", packed.includes("index.ts"), packed.join(" "));
for (const mod of ["lib/loop-guardian.ts", "lib/completeness.ts", "lib/obligations.ts"]) {
  check(`${mod} ships`, packed.includes(mod), packed.length ? "" : "(nothing packed)");
}
check("the default config ships", packed.includes("pi-vigilant.json"), packed.length ? "" : "(nothing packed)");
check(
  "the skill ships — its instructions are part of the deliverable",
  packed.some((f) => f.startsWith("skills/")),
  packed.filter((f) => f.startsWith("skills/")).slice(0, 3).join(" ") || "no skills/ entry",
);

// ---------------------------------------------------------------------------
console.log("\n── 2 — every relative import inside the artifact resolves inside it ──");
// ---------------------------------------------------------------------------
// pi loads .ts directly (jiti) and this package imports its own modules with a
// `.js` specifier, so the resolver has to accept .js -> .ts the way the loader does.
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)(["'])(\.\.?\/[^"']+?)\1/g;
const shipped = new Set(packed);
const missing = [];
const followed = [];

for (const rel of packed) {
  if (!/\.(ts|mts|js|mjs)$/.test(rel)) continue;
  const abs = join(REPO, rel);
  if (!existsSync(abs)) continue;
  const text = readFileSync(abs, "utf8");
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[2];
    const relTarget = relative(REPO, rresolve(dirname(abs), spec)).replace(/\\/g, "/");
    followed.push(`${rel} -> ${spec}`);
    const candidates = [
      relTarget,
      relTarget.replace(/\.js$/, ".ts"),
      relTarget.replace(/\.ts$/, ""),
      `${relTarget}.ts`,
      join(relTarget, "index.ts").replace(/\\/g, "/"),
    ];
    if (!candidates.some((c) => shipped.has(c))) missing.push(`${rel}: ${spec}`);
  }
}

// Without this floor the section is vacuous: an IMPORT_RE that matched nothing
// would "prove" every import resolves.
check("the scanner really followed the lib imports", followed.length >= 3, `${followed.length} imports checked`);
check(
  "no relative import in the artifact points outside it",
  missing.length === 0,
  missing.slice(0, 6).join(" | "),
);

// ---------------------------------------------------------------------------
console.log("\n── 3 — the packed set is what package.json claims ───────────");
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
check("files allowlists index.ts", (pkg.files || []).includes("index.ts"), JSON.stringify(pkg.files));
check("files allowlists lib/ as a directory, not file by file", (pkg.files || []).includes("lib/"), JSON.stringify(pkg.files));
check(
  "the version is plain semver (the release gate compares it against the registry)",
  /^\d+\.\d+\.\d+$/.test(pkg.version),
  pkg.version,
);
check(
  "pi.extensions points only at files that ship",
  (pkg.pi?.extensions || []).length > 0 &&
    (pkg.pi.extensions || []).every((e) => packed.includes(String(e).replace(/^\.\//, ""))),
  JSON.stringify(pkg.pi),
);
check(
  "pi.skills point only at directories that ship",
  (pkg.pi?.skills || []).length > 0 &&
    (pkg.pi.skills || []).every((s) => packed.some((f) => f.startsWith(String(s).replace(/^\.\//, "") + "/"))),
  JSON.stringify(pkg.pi?.skills),
);
check(
  "the release script gates on the published artifact",
  existsSync(join(REPO, "scripts", "verify-published.mjs")),
  "scripts/verify-published.mjs missing — a release would publish unverified bytes",
);

const failed = results.filter((r) => !r.cond);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
  process.exit(1);
}
