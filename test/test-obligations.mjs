/**
 * DECLARED OBLIGATIONS suite.
 *
 * The guard gained a general container for standing obligations declared by any
 * source. Two properties matter more than the feature itself and are what this
 * suite is really about:
 *
 *   1. GENERALITY — the container holds declarations, never content. Vigilant
 *      must not know who wrote any particular file, and the primary fixture is
 *      a synthetic source that has nothing to do with any particular consumer.
 *   2. INERT-WHEN-ABSENT — with zero declarations, behaviour is exactly what it
 *      was before this module existed.
 *
 * A declaration that cannot be loaded is REPORTED, never treated as absent:
 * the guard does not overclaim, and a silently ignored obligation is the worst
 * possible outcome because it looks like compliance.
 */
import { loadExtension } from "./harness.mjs";
import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.join(HERE, "..");
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const section = (s) => console.log(`\n=== ${s} ===`);

const jiti = createJiti(import.meta.url, { interopDefault: true });
const ob = await jiti.import(path.join(REPO, "lib/obligations.ts"));

// ─── 1. Trigger vocabulary is a CLOSED set ─────────────────────────────────
section("trigger vocabulary is closed");

check("always is accepted", ob.validateTrigger("always") === null);
check("area:<x> is accepted", ob.validateTrigger("area:security") === null);
check("path-glob:<g> is accepted", ob.validateTrigger("path-glob:src/**/*.ts") === null);
check("tool:<name> is accepted", ob.validateTrigger("tool:bash") === null);
check("when-spec-matches:<regex> is accepted", ob.validateTrigger("when-spec-matches:\\bapi\\b") === null);

const unknown = ob.validateTrigger("phase:6");
check("an unknown trigger kind is rejected, not ignored", typeof unknown === "string" && unknown.length > 0, unknown);
check(
  "the rejection names the accepted vocabulary",
  typeof unknown === "string" && unknown.includes("path-glob:") && unknown.includes("when-spec-matches:"),
);
check("an empty value after a prefix is rejected", typeof ob.validateTrigger("area:") === "string");
check("an empty trigger is rejected", typeof ob.validateTrigger("   ") === "string");
check(
  "an invalid regex in when-spec-matches is rejected",
  typeof ob.validateTrigger("when-spec-matches:((") === "string",
);

// ─── 2. Trigger matching ───────────────────────────────────────────────────
section("trigger matching");

const ctx = {
  areas: ["security"],
  paths: ["src/api/routes.ts", "README.md"],
  tools: ["bash", "edit"],
  specText: ["the API returns 401 on missing token"],
};
check("always matches", ob.triggerMatches("always", {}) === true);
check("area: matches case-insensitively", ob.triggerMatches("area:Security", ctx) === true);
check("area: does not match an absent area", ob.triggerMatches("area:performance", ctx) === false);
check("path-glob: matches a nested path", ob.triggerMatches("path-glob:src/**/*.ts", ctx) === true);
check("path-glob: does not match an unrelated path", ob.triggerMatches("path-glob:db/**", ctx) === false);
check("tool: matches a called tool", ob.triggerMatches("tool:bash", ctx) === true);
check("tool: does not match an uncalled tool", ob.triggerMatches("tool:browser_navigate", ctx) === false);
check("when-spec-matches: matches spec text", ob.triggerMatches("when-spec-matches:\\bapi\\b", ctx) === true);
check("when-spec-matches: is false, not throwing, on a bad regex", ob.triggerMatches("when-spec-matches:((", ctx) === false);
check("an unknown trigger never matches", ob.triggerMatches("phase:6", ctx) === false);

// ─── 3. Obligation validation ──────────────────────────────────────────────
section("obligation validation");

const good = {
  id: "regression-test-per-bugfix",
  requirement: "Every bug fixed has a regression test that fails without the fix",
  area: "testing",
  priority: "must",
  trigger: ["always"],
  class: "M",
  recurring: true,
};
check("a well-formed obligation validates", ob.validateObligation(good, "t").length === 0, ob.validateObligation(good, "t").join("; "));
check("a missing requirement is rejected", ob.validateObligation({ ...good, requirement: "" }, "t").length > 0);
check("a bad priority is rejected", ob.validateObligation({ ...good, priority: "whenever" }, "t").length > 0);
check("a bad class is rejected", ob.validateObligation({ ...good, class: "X" }, "t").length > 0);
check("an empty trigger array is rejected", ob.validateObligation({ ...good, trigger: [] }, "t").length > 0);
check("a signal of an unknown kind is rejected", ob.validateObligation({ ...good, signal: { kind: "vibes" } }, "t").length > 0);
check("scan without pattern is rejected", ob.validateObligation({ ...good, signal: { kind: "scan" } }, "t").length > 0);
check("scan with a bad regex is rejected", ob.validateObligation({ ...good, signal: { kind: "scan", pattern: "((" } }, "t").length > 0);
check("test without an assertion is rejected", ob.validateObligation({ ...good, signal: { kind: "test", file: "t.mjs" } }, "t").length > 0);
check("trace without codePath is rejected", ob.validateObligation({ ...good, trace: { outcome: "x" } }, "t").length > 0);

const fileResult = ob.validateObligationFile({ obligations: [good] }, "f.json");
check("a file without a source is rejected", fileResult.errors.some((e) => e.includes("source")), fileResult.errors.join("; "));
const mixed = ob.validateObligationFile(
  { source: "synthetic", obligations: [good, { ...good, id: "broken", priority: "nope" }] },
  "f.json",
);
check("a bad obligation is reported while the good one survives", mixed.errors.length === 1 && mixed.file.obligations.length === 1);

// ─── 4. Loading ────────────────────────────────────────────────────────────
section("loading");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vig-ob-"));
try {
  const extDir = path.join(tmp, "ext");
  const projDir = path.join(tmp, "proj");
  const obDir = path.join(extDir, "obligations.d");
  fs.mkdirSync(obDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });

  // The primary fixture is a SYNTHETIC source with no relation to any real
  // consumer: the mechanism is proven general by its own test, not by a claim.
  const synthetic = {
    source: "synthetic-example",
    obligations: [
      { ...good, id: "synthetic-always", trigger: ["always"], class: "M" },
      { ...good, id: "synthetic-area", area: "security", trigger: ["area:security"], class: "S" },
    ],
  };
  fs.writeFileSync(path.join(obDir, "a-synthetic.json"), JSON.stringify(synthetic));

  let r = ob.loadObligations({ extensionDir: extDir, projectDir: projDir });
  check("declarations load", r.obligations.length === 2, JSON.stringify(r.errors));
  check("no errors on a clean load", r.errors.length === 0, r.errors.join("; "));
  check("the source is carried verbatim and never interpreted", r.obligations.every((o) => o.source === "synthetic-example"));

  // A second file with a duplicate id is reported, not silently merged.
  fs.writeFileSync(
    path.join(obDir, "b-dup.json"),
    JSON.stringify({ source: "synthetic-example", obligations: [{ ...good, id: "synthetic-always" }] }),
  );
  r = ob.loadObligations({ extensionDir: extDir, projectDir: projDir });
  check("a duplicate id is reported and the copy is dropped", r.errors.some((e) => e.includes("duplicate")) && r.obligations.length === 2);
  fs.unlinkSync(path.join(obDir, "b-dup.json"));

  // Unreadable JSON is reported, never treated as absent.
  fs.writeFileSync(path.join(obDir, "c-broken.json"), "{ not json");
  r = ob.loadObligations({ extensionDir: extDir, projectDir: projDir });
  check("an unreadable declaration is reported, not treated as absent", r.errors.some((e) => e.includes("could not be read")));
  fs.unlinkSync(path.join(obDir, "c-broken.json"));

  // Project-level declaration file.
  fs.mkdirSync(path.join(projDir, ".vigilant"), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, ".vigilant", "obligations.json"),
    JSON.stringify({ source: "synthetic-project", obligations: [{ ...good, id: "proj-only", trigger: ["path-glob:src/**"] }] }),
  );
  r = ob.loadObligations({ extensionDir: extDir, projectDir: projDir });
  check("the project declaration file is read", r.obligations.some((o) => o.id === "proj-only"));

  // Sibling extensions may ship their own declarations, and a general drop-in
  // directory exists for anything that is not an extension.
  const agentDir = path.join(tmp, "agent");
  const sibOb = path.join(agentDir, "extensions", "some-other-extension", "obligations.d");
  fs.mkdirSync(sibOb, { recursive: true });
  fs.writeFileSync(
    path.join(sibOb, "sibling.json"),
    JSON.stringify({ source: "synthetic-sibling", obligations: [{ ...good, id: "sibling-only", trigger: ["always"] }] }),
  );
  fs.mkdirSync(path.join(agentDir, "obligations.d"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "obligations.d", "dropped-in.json"),
    JSON.stringify({ source: "synthetic-dropin", obligations: [{ ...good, id: "dropin-only", trigger: ["always"] }] }),
  );
  r = ob.loadObligations({ extensionDir: extDir, projectDir: projDir, agentDir });
  check("a sibling extension's declarations are read", r.obligations.some((o) => o.id === "sibling-only" && o.source === "synthetic-sibling"), r.obligations.map((o) => o.id).join(","));
  check("the general drop-in directory is read", r.obligations.some((o) => o.id === "dropin-only"));
  check("declarations from different sources coexist", new Set(r.obligations.map((o) => o.source)).size === 4, [...new Set(r.obligations.map((o) => o.source))].join(","));

  // Zero declarations: no directory at all.
  const emptyExt = path.join(tmp, "empty-ext");
  const emptyProj = path.join(tmp, "empty-proj");
  fs.mkdirSync(emptyExt, { recursive: true });
  fs.mkdirSync(emptyProj, { recursive: true });
  const none = ob.loadObligations({ extensionDir: emptyExt, projectDir: emptyProj });
  check("no declarations ⇒ no obligations and no errors", none.obligations.length === 0 && none.errors.length === 0);
  check("no declarations ⇒ nothing was read (a zero that can be told from a miss)", none.filesRead.length === 0);

  // ── 5. Applicability and fingerprint ──
  section("applicability and fingerprint");
  const applicable = ob.applicableObligations(r.obligations, ctx);
  check(
    "only triggered obligations apply",
    ["synthetic-always", "proj-only", "synthetic-area", "sibling-only", "dropin-only"].every((id) => applicable.some((o) => o.id === id)),
    applicable.map((o) => o.id).join(","),
  );
  const noneTriggered = ob.applicableObligations(r.obligations, { areas: [], paths: [], tools: [], specText: [] });
  check(
    "an obligation whose trigger does not hold is not applied",
    !noneTriggered.some((o) => o.id === "proj-only") && !noneTriggered.some((o) => o.id === "synthetic-area"),
    noneTriggered.map((o) => o.id).join(","),
  );
  const fp1 = ob.obligationFingerprint(good);
  const fp2 = ob.obligationFingerprint({ ...good, requirement: good.requirement + " (and it must be run in CI)" });
  check("the fingerprint changes when the requirement changes", fp1 !== fp2);
  check("the fingerprint is stable for identical declarations", fp1 === ob.obligationFingerprint({ ...good }));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ─── 6. Integration: declared specs reach the tree, and are never persisted ─
section("integration with the spec tree");

const obDir = path.join(REPO, "obligations.d");
const created = !fs.existsSync(obDir);
try {
  fs.mkdirSync(obDir, { recursive: true });
  const fixture = {
    source: "synthetic-example",
    obligations: [
      {
        id: "declared-visible",
        requirement: "The declared obligation is visible in the specification tree",
        area: "testing",
        priority: "must",
        trigger: ["always"],
        class: "H",
        recurring: true,
        trace: { outcome: "the tree lists the obligation", codePath: "load → inject → render", testFile: "test-obligations.mjs", assertion: "declared-visible" },
      },
      {
        id: "declared-expectation",
        requirement: "A self-attested obligation renders as an expectation",
        area: "documentation",
        priority: "should",
        trigger: ["always"],
        class: "S",
      },
      {
        id: "declared-broken",
        requirement: "This one must never load",
        area: "testing",
        priority: "must",
        trigger: ["phase:6"],
      },
    ],
  };
  const fixtureFile = path.join(obDir, "test-synthetic.json");
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));

  const { ext, treeText, readRaw } = await driveExtension();

  check("the declared obligation reaches the tree", treeText.includes("declared-visible"), excerpt(treeText));
  check("the enforcement class is rendered", /\[H\][^\n]*declared-visible/.test(treeText), excerpt(treeText));
  check("the declaring source is named", treeText.includes("declared by synthetic-example"), excerpt(treeText));
  check("a class S obligation renders with its class", /\[S\][^\n]*declared-expectation/.test(treeText), excerpt(treeText));
  check("a self-attested obligation is not labelled as a blocker", !/BLOCKER/i.test(treeText));
  check(
    "a broken declaration is reported, not silently dropped",
    treeText.includes("obligation declaration:"),
    excerpt(treeText),
  );

  // Persistence: declared specs must never be written into the task file.
  const raw = readRaw();
  check("declared obligations are NEVER persisted into the task", !raw.includes("declared-visible"), raw.slice(0, 200));
  check("user-captured specs still persist", raw.includes("user-captured"), raw.slice(0, 200));
} finally {
  if (created) fs.rmSync(obDir, { recursive: true, force: true });
  else fs.rmSync(path.join(obDir, "test-synthetic.json"), { force: true });
}

// ─── 7. Inert when absent (the pre-feature behaviour) ──────────────────────
section("inert when absent");
check("no obligations.d directory remains after the fixture run", !fs.existsSync(obDir) || fs.readdirSync(obDir).length === 0);
{
  const { treeText } = await driveExtension();
  check("with zero declarations the tree carries no declared marker", !treeText.includes("declared by"), excerpt(treeText));
  check("with zero declarations the tree still lists user specs", treeText.includes("user-captured"), excerpt(treeText));
}

// ─── 8. The generality guard ───────────────────────────────────────────────
section("generality guard");
{
  const files = ["index.ts", "lib/obligations.ts", "lib/completeness.ts", "lib/loop-guardian.ts"].filter((f) =>
    fs.existsSync(path.join(REPO, f)),
  );
  const banned = [
    /\basf\b/i,
    /\b06[a-j]\b/,
    /\bdefinition of done\b/i,
    /\bDoD\b/,
    /\bcascade\b/i,
    /\bhot path\b/i,
    /\bintake\b/i,
    /\bphase 6\b/i,
  ];
  let leaked = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO, f), "utf-8");
    for (const re of banned) {
      const m = text.match(re);
      if (m) leaked.push(`${f}: ${re} → "${m[0]}"`);
    }
  }
  check("the guard contains no consumer vocabulary", leaked.length === 0, leaked.join(" | "));
  check("the container never branches on a source", !/source\s*===\s*["']/.test(fs.readFileSync(path.join(REPO, "lib/obligations.ts"), "utf-8")));
}

// ─── driver ────────────────────────────────────────────────────────────────
//
// Isolated the way the other suites isolate: the agent dir holds the spec
// store, and the store is keyed by basename(cwd), so the project name comes
// from the working directory.
async function driveExtension() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "vig-ob-task-"));
  const agentDir = path.join(sandbox, "agent");
  const projectDir = path.join(sandbox, "obligation-test-project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const prevCwd = process.cwd();
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.chdir(projectDir);
  try {
    const { tools, handlers } = await loadExtension(path.join(REPO, "index.ts"));

    // Seed the task through the tool the agent itself uses, so the store's own
    // shape (ids, timestamps) is real rather than hand-written.
    const capture = tools.get("capture_spec");
    const call = (tool, params) =>
      tool.execute("tc-1", params, new AbortController().signal, undefined, {});
    await call(capture, {
      requirement: "user-captured requirement stays in the task",
      area: "functionality",
      priority: "must",
      sourceQuote: "the user asked for it",
    });

    // Drive the tool_call observer so path/tool triggers have session facts.
    for (const fn of handlers.get("tool_call") || []) {
      await fn({ toolName: "bash", input: { command: "npm test" } }, {});
    }

    const getSpecs = tools.get("get_task_specs");
    const res = await call(getSpecs, {});
    const treeText = res?.content?.[0]?.text ?? String(res);

    const taskFile = path.join(
      agentDir, "skills", "spec-memory", "projects",
      path.basename(projectDir), "current-task.json",
    );
    return {
      treeText,
      readRaw: () => (fs.existsSync(taskFile) ? fs.readFileSync(taskFile, "utf-8") : ""),
    };
  } finally {
    process.chdir(prevCwd);
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
  }
}

function excerpt(t) {
  return String(t).replace(/\s+/g, " ").slice(0, 160);
}

const failed = results.filter((r) => !r.cond);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
  process.exit(1);
}
