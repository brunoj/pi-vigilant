/**
 * COMPLETENESS GUARD suite — "done" must not mean "stubbed".
 *
 * Covers both halves of the guard:
 *   1. the scanner (lib/completeness.ts) — what it catches, what it must
 *      deliberately ignore, and that it never claims a clean deliverable it
 *      did not actually look at;
 *   2. the completion hook — the final-verification prompt must carry the real
 *      findings (including work the agent already committed), and must stay
 *      silent when there is nothing to report.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";
import { loadExtension, assistantMsg } from "./harness.mjs";

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const EXT = path.join(REPO, "index.ts");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { auditCompleteness, isScannablePath } = await jiti.import(
  path.join(REPO, "lib", "completeness.ts"),
);

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const section = (s) => console.log(`\n=== ${s} ===`);

const tmpDirs = [];
function fixture(files, { git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asf-complete-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  if (git) {
    const run = (...a) =>
      execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
        stdio: "ignore",
      });
    run("init", "-q", "-b", "main");
    run("add", "-A");
    run("commit", "-q", "-m", "seed");
  }
  return dir;
}
const markers = (audit) => audit.findings.map((f) => `${f.category}/${f.marker}`);
/** Unit fixtures are plain temp dirs, so they are scanned through the mtime path. */
const SINCE = Date.now() - 60_000;
const scan = (dir, opts = {}) => auditCompleteness(dir, { sinceMs: SINCE, ...opts });
const has = (audit, cat, marker) =>
  audit.findings.some((f) => f.category === cat && f.marker === marker);

// ─── 1. the scanner catches what it exists for ─────────────────────────────
section("Scanner catches stubs, fabricated data, and fact holes");
{
  const dir = fixture({
    "src/orders.ts": [
      "export function refund(id: string) {",
      "  // TODO: actually call the payment provider",
      "  return { refunded: true };",
      "}",
      "export function exportInvoice() { throw new Error('not implemented'); }",
      "export const config = { host: 'coming soon' };",
    ].join("\n"),
    "src/seed.ts": [
      "export const customers = [",
      "  { name: 'John Doe', email: 'john@example.com', bio: 'Lorem ipsum dolor sit amet' },",
      "];",
      "const fakeUsers = [{ id: 1 }];",
      "const phone = '+1 555-0142';",
    ].join("\n"),
    "src/integrations.ts": [
      "const endpoint = 'TBD';",
      "const key = 'YOUR_API_KEY';",
      "const note = 'see docs ??? for the rate limit';",
    ].join("\n"),
  });
  const audit = scan(dir);
  check("stubs found", has(audit, "stub", "TODO") && has(audit, "stub", "not implemented") && has(audit, "stub", "coming soon"), markers(audit).join(","));
  check("fabricated data found", has(audit, "fabricated-data", "placeholder person") && has(audit, "fabricated-data", "example domain") && has(audit, "fabricated-data", "lorem ipsum") && has(audit, "fabricated-data", "fake data set"), markers(audit).join(","));
  check("fact holes found", has(audit, "unverified-fact", "TBD") && has(audit, "unverified-fact", "credential hole") && has(audit, "unverified-fact", "???"), markers(audit).join(","));
  check("finding carries file + line evidence", audit.findings.every((f) => f.file && f.line > 0 && f.text));
  check("report names the file and the line", audit.text.includes("src/orders.ts") && /\d+: \[stub\/TODO\]/.test(audit.text), audit.text.split("\n")[1]?.trim());
  check("clean-scan statement is empty only when there are findings", audit.text.length > 0);
}

// ─── 2. precision: what it must NOT flag ───────────────────────────────────
section("Precision — legitimate code stays quiet");
{
  const dir = fixture({
    "src/ui.ts": [
      "export const input = html`<input placeholder=\"Search orders\" />`;",
      "// The sample size for the study was 400 orders.",
      "export const title = 'Sample of the month';",
    ].join("\n"),
    "src/real.ts": "export function add(a, b) { return a + b; }\n",
  });
  const audit = scan(dir);
  check("HTML placeholder attribute is not a stub", !has(audit, "stub", "placeholder"), markers(audit).join(",") || "none");
  check("clean source produces no findings", audit.findings.filter((f) => f.file === "src/real.ts").length === 0);
  check("clean deliverable produces an empty report", scan(fixture({ "src/a.ts": "export const x = 1;\n" })).text === "");
}

// ─── 3. exclusions: tests, docs, dependencies ──────────────────────────────
section("Exclusions — mocks at a test seam are correct practice");
{
  check("test paths excluded", !isScannablePath("src/__tests__/orders.test.ts") && !isScannablePath("tests/fixtures/users.json".replace(".json", ".ts")) && !isScannablePath("test_helper.py"));
  check("docs excluded", !isScannablePath("README.md") && !isScannablePath("docs/notes.md"));
  check("dependencies and generated excluded", !isScannablePath("node_modules/x/index.ts") && !isScannablePath("dist/bundle.js") && !isScannablePath("package-lock.json") && !isScannablePath("app.min.js"));
  check("source is included", isScannablePath("src/orders.ts") && isScannablePath("app.py") && isScannablePath("main.go") && isScannablePath("db/schema.sql"));

  const dir = fixture({
    "src/app.ts": "export const x = 1;\n",
    "src/__tests__/app.test.ts": "const fakeUsers = [{ name: 'John Doe' }]; // TODO mock the API\n",
    "docs/PLAN.md": "TODO: implement the refund path with lorem ipsum and John Doe\n",
    "node_modules/pkg/index.ts": "const dummyData = [];\n",
  });
  const audit = scan(dir);
  check("only the real source was scanned", audit.scannedFiles === 1, `${audit.scannedFiles}`);
  check("mocks in tests are not reported", audit.findings.length === 0, markers(audit).join(","));
}

// ─── 4. bounded, and honest about what it could not do ─────────────────────
section("Proportional and honest about its own limits");
{
  const many = {};
  for (let i = 0; i < 40; i++) many[`src/f${i}.ts`] = `// TODO ${i}\n`;
  const capped = scan(fixture(many), { maxFindings: 5 });
  check("findings are capped", capped.findings.length <= 5, `${capped.findings.length}`);
  check("capping is disclosed", capped.truncated && capped.text.includes("list capped"), capped.text.split("\n").pop()?.trim());

  const noSince = auditCompleteness(fixture({ "src/a.ts": "// TODO\n" }), {});
  check("non-git without a start time reports it could not scan", !!noSince.error && noSince.source === "none", noSince.error);

  const nonGit = scan(fixture({ "src/a.ts": "// TODO x\n" }));
  check("non-git falls back to files modified this session", nonGit.source === "mtime" && has(nonGit, "stub", "TODO"), `${nonGit.source}`);
}

// ─── 5. the completion hook ────────────────────────────────────────────────
section("Completion hook injects the real findings");

function extWithConfig(overrides = {}) {
  // Must live under test/ so bare imports in the copied extension resolve through
  // the repo's node_modules (setup.sh links pi + jiti + pi-ai there).
  const dir = fs.mkdtempSync(path.join(REPO, "test", ".tmp-cg-"));
  tmpDirs.push(dir);
  fs.copyFileSync(EXT, path.join(dir, "index.ts"));
  fs.cpSync(path.join(REPO, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pi-vigilant.json"),
    JSON.stringify(
      { specMemoryIntegration: false, feedbackMemoryIntegration: false, ...overrides },
      null,
      2,
    ),
  );
  return path.join(dir, "index.ts");
}

/**
 * Drive one complex task to completion and return the verification prompt.
 * `writtenDuringRun` is created AFTER the session starts — the way an agent
 * actually writes files (the non-git fallback ignores anything older than the
 * session start on purpose, so pre-seeding them would test nothing).
 */
async function verifyPrompt(extPath, dir, writtenDuringRun = {}) {
  if (dir) process.chdir(dir);
  const { emit, sent } = await loadExtension(extPath);
  await emit({ type: "agent_start" });
  for (const [rel, content] of Object.entries(writtenDuringRun)) {
    const abs = path.join(process.cwd(), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  await emit({
    type: "agent_end",
    messages: [assistantMsg({ stopReason: "stop", text: "All done.", toolCalls: 3 })],
  });
  await emit({ type: "agent_settled" });
  const v = sent.filter((s) => s.msg.customType === "auto-continue-verify");
  return String(v[0]?.msg.content ?? "");
}

const prevCwd = process.cwd();
try {
  // Uncommitted work (normal mid-task completion).
  let prompt = await verifyPrompt(extWithConfig(), fixture({}), {
    "src/orders.ts": "export function refund() {\n  // TODO wire stripe\n  return true;\n}\n",
  });
  check("audit section present", prompt.includes("COMPLETENESS AUDIT"), prompt.slice(0, 60));
  check("names the real file and marker", prompt.includes("src/orders.ts") && prompt.includes("[stub/TODO]"), prompt.match(/src\/orders\.ts[\s\S]{0,80}/)?.[0]?.replace(/\n/g, " ⏎ "));
  check("states that a stub is not complete", /NOT complete/.test(prompt) && /stub/.test(prompt));
  check("demands: finish the work or state the discrepancy", /finish the real implementation/.test(prompt) && /state the discrepancy/.test(prompt));
  check("a deliberate stub must be said out loud", /acceptable ONLY when the user asked/.test(prompt));
  check("covers the stub a scan cannot see (never wired)", /Built-but-never-wired/.test(prompt));
  check("fakes on a user path are called out", /placeholder data reach a user-reachable path/.test(prompt));

  // Work the agent already COMMITTED (the ASF commits per phase, so the tree is
  // clean exactly when verification runs) — the baseline diff must still see it.
  const repo = fixture({ "src/clean.ts": "export const ok = 1;\n" }, { git: true });
  process.chdir(repo);
  const { emit, sent } = await loadExtension(extWithConfig());
  await emit({ type: "agent_start" }); // captures the baseline commit
  fs.writeFileSync(path.join(repo, "src/stub.ts"), "export function pay() {\n  // TODO implement\n  return { ok: true };\n}\n");
  const g = (...a) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "ignore" });
  g("add", "-A");
  g("commit", "-q", "-m", "feat: payments");
  await emit({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "Payments done.", toolCalls: 4 })] });
  await emit({ type: "agent_settled" });
  const committedPrompt = String(sent.filter((s) => s.msg.customType === "auto-continue-verify")[0]?.msg.content ?? "");
  check("committed stub work is still caught", committedPrompt.includes("src/stub.ts") && committedPrompt.includes("[stub/TODO]"), committedPrompt.match(/git-[a-z+]*/)?.[0]);
  check("scan source is reported honestly", /git-baseline\+worktree|git-worktree/.test(committedPrompt), committedPrompt.match(/\(\w[\w+]*,/)?.[0]);

  // Clean deliverable → the guard says nothing.
  const cleanDir = fixture({});
  const cleanPrompt = await verifyPrompt(extWithConfig(), cleanDir, {
    "src/real.ts": "export function add(a, b) { return a + b; }\n",
  });
  check("the clean fixture really was scanned", scan(cleanDir).scannedFiles >= 1, `${scan(cleanDir).scannedFiles}`);
  check("a clean deliverable is still confronted", cleanPrompt.includes("COMPLETENESS AUDIT") && /clean scan is\s+NOT proof/.test(cleanPrompt), cleanPrompt.match(/COMPLETENESS AUDIT[\s\S]{0,70}/)?.[0]?.replace(/\n/g, " ⏎ "));
  check("a clean scan invents no findings", !cleanPrompt.includes("[stub/") && !cleanPrompt.includes("[fabricated-data/"));
  check("the clean variant still demands wiring + nothing deferred", /reachable from where the user enters it/.test(cleanPrompt) && /nothing silently/.test(cleanPrompt));
  check("verification itself still runs", cleanPrompt.includes("implemented as requested"));

  // Guard off → no audit even with stubs everywhere.
  const offPrompt = await verifyPrompt(extWithConfig({ completenessGuard: false }), fixture({}), {
    "src/orders.ts": "// TODO refund\nconst u = 'John Doe';\n",
  });
  check("completenessGuard:false disables the audit", !offPrompt.includes("COMPLETENESS AUDIT"));

  // Q&A stays silent (complexity gate, unchanged).
  const { emit: e2, sent: s2 } = await loadExtension(extWithConfig());
  await e2({ type: "agent_start" });
  await e2({ type: "agent_end", messages: [assistantMsg({ stopReason: "stop", text: "It is 42.", toolCalls: 0 })] });
  await e2({ type: "agent_settled" });
  check("simple Q&A is not audited", s2.filter((s) => s.msg.customType === "auto-continue-verify").length === 0);
} finally {
  process.chdir(prevCwd);
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.cond);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
