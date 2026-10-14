/**
 * SPEC INTEGRITY suite — the transitions that clear the completion gate.
 *
 * The settle-time gate keys off spec status: only "open"/"in-progress" MUST
 * specs block, and only those two keep the verification checklist from being
 * silenced by the cooldown. So a transition out of "open" has to cost
 * something, or the gate is decorative: "met" with nothing behind it looks
 * identical to a verified spec, and "obsolete" with no reason is a MUST spec
 * walking out of the gate unattributed.
 *
 * Scope is deliberately narrow (V1):
 *   - terminal statuses require evidence; "obsolete" requires a reason
 *   - presence is checked, quality is NOT (no length or vocabulary heuristics —
 *     those get worked around and make the guard untrustworthy)
 *   - "partial" and "in-progress" stay free, so the honest escape hatch never
 *     turns into a deadlock or a loop back to the user
 */
import { loadExtension } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXT = new URL("../index.ts", import.meta.url).pathname;
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const section = (s) => console.log(`\n=== ${s} ===`);

// Isolate everything: the agent dir holds the spec store, and the store is
// keyed by basename(cwd), so the project name comes from the working directory.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "vigilant-spec-"));
process.env.PI_CODING_AGENT_DIR = path.join(sandbox, "agent");
const projectDir = path.join(sandbox, "spec-integrity-project");
fs.mkdirSync(projectDir, { recursive: true });
process.chdir(projectDir);

const taskFile = path.join(
  process.env.PI_CODING_AGENT_DIR,
  "skills", "spec-memory", "projects", path.basename(projectDir), "current-task.json",
);

const { tools } = await loadExtension(EXT);
const update = tools.get("update_spec_status");
const capture = tools.get("capture_spec");
const getSpecs = tools.get("get_task_specs");

const call = (tool, params) =>
  tool.execute("tc-1", params, new AbortController().signal, undefined, {});
const textOf = (res) => (res?.content?.[0]?.text ?? "");
const readTask = () => JSON.parse(fs.readFileSync(taskFile, "utf-8"));
const findSpec = (id) =>
  Object.values(readTask().areas).flat().find((s) => s.id === id);

/** Fresh task each time: capture_spec creates/uses the current task file. */
let seq = 0;
async function newSpec(priority = "must") {
  seq++;
  const res = await call(capture, {
    requirement: `Integrity requirement ${seq}: the deliverable must do thing ${seq}`,
    area: "functionality",
    priority,
    sourceQuote: `the user asked for thing ${seq}`,
  });
  const m = textOf(res).match(/Spec captured: (spc-[\w-]+)/);
  if (!m) throw new Error(`capture_spec failed: ${textOf(res)}`);
  return m[1];
}

// ── 1. terminal statuses require evidence ───────────────────────────────────
section("1. met/not-met are rejected without evidence");
{
  const id = await newSpec();
  const noEvidence = await call(update, { id, status: "met" });
  check("met without evidence is an error", noEvidence.isError === true);
  check("the rejection says what is missing", /requires evidence/i.test(textOf(noEvidence)));
  check("the rejection points at the honest alternatives", /partial/i.test(textOf(noEvidence)) && /obsolete/i.test(textOf(noEvidence)));

  // Anti-vacuity: the rejection must be the handler refusing, not the schema
  // description hoping. If the write went through, the gate is already open.
  check("a rejected met does NOT persist (status stays open)", findSpec(id)?.status === "open", findSpec(id)?.status);
  check("a rejected met stores no evidence", !findSpec(id)?.evidence);

  const blank = await call(update, { id, status: "met", evidence: "   \n\t " });
  check("whitespace-only evidence is rejected (presence is trimmed, not counted)", blank.isError === true);
  const empty = await call(update, { id, status: "met", evidence: "" });
  check("empty-string evidence is rejected", empty.isError === true);

  const notMet = await call(update, { id, status: "not-met" });
  check("not-met without evidence is an error", notMet.isError === true);

  // Positive control: the rule is not a blanket refusal.
  const ok = await call(update, {
    id, status: "met",
    evidence: "npm test → 372 checks passed, 0 failures; test/test-spec-integrity.mjs asserts this",
  });
  check("met WITH evidence succeeds", ok.isError === undefined && /updated/i.test(textOf(ok)));
  check("the evidence is persisted", /test\/test-spec-integrity\.mjs/.test(findSpec(id)?.evidence || ""));
  check("the status is persisted", findSpec(id)?.status === "met");

  const notMetOk = await call(update, { id, status: "not-met", evidence: "npm test → 3 failures in test-x" });
  check("not-met WITH evidence succeeds", notMetOk.isError === undefined);
}

// ── 2. presence is checked, quality is not ─────────────────────────────────
section("2. V1 does not judge evidence quality");
{
  const id = await newSpec();
  const terse = await call(update, { id, status: "met", evidence: "ran it" });
  check("terse-but-real evidence is accepted (no length heuristic)", terse.isError === undefined, textOf(terse).slice(0, 60));

  const echo = await call(update, { id, status: "met", evidence: "the deliverable must do thing" });
  check("evidence echoing the requirement is accepted (no vocabulary heuristic)", echo.isError === undefined);
}

// ── 3. obsolete requires a reason ──────────────────────────────────────────
section("3. obsolete is rejected without a reason");
{
  const id = await newSpec();
  const noReason = await call(update, { id, status: "obsolete" });
  check("obsolete without reason is an error", noReason.isError === true);
  check("the rejection says what is missing", /requires a reason/i.test(textOf(noReason)));
  check("the rejection names the risk (silent scope reduction)", /MUST spec|scope/i.test(textOf(noReason)));
  check("a rejected obsolete does NOT persist", findSpec(id)?.status === "open", findSpec(id)?.status);

  const blankReason = await call(update, { id, status: "obsolete", reason: "  " });
  check("whitespace-only reason is rejected", blankReason.isError === true);

  const ok = await call(update, { id, status: "obsolete", reason: "Superseded by spc-9999: the user replaced the format requirement" });
  check("obsolete WITH a reason succeeds", ok.isError === undefined, textOf(ok).slice(0, 60));
  check("the reason is persisted", /spc-9999/.test(findSpec(id)?.reason || ""));
  check("the status is persisted", findSpec(id)?.status === "obsolete");

  const frozen = await call(update, { id, status: "met", evidence: "trying to reopen" });
  check("an already-obsolete spec still cannot be changed", frozen.isError === true && /already obsolete/i.test(textOf(frozen)));
}

// ── 4. the honest escape hatch stays open ──────────────────────────────────
section("4. partial and in-progress stay free");
{
  // The reason V1 stops at presence: if marking a spec unverifiable cost the
  // agent an argument, it would either loop or push the question at the user
  // needlessly. Non-terminal statuses must not gain a new barrier.
  const id = await newSpec("should");
  const inProgress = await call(update, { id, status: "in-progress" });
  check("in-progress without evidence is accepted", inProgress.isError === undefined, textOf(inProgress).slice(0, 60));
  const partial = await call(update, { id, status: "partial" });
  check("partial without evidence is accepted", partial.isError === undefined, textOf(partial).slice(0, 60));
  check("partial is recorded as such", findSpec(id)?.status === "partial");
}

// ── 5. the checklist shows what a verdict rests on ─────────────────────────
section("5. get_task_specs surfaces evidence and retirement reasons");
{
  const keep = await newSpec();
  await call(update, { id: keep, status: "met", evidence: "browser: clicked Save, toast 'Saved' appeared, row persisted after reload" });
  const retired = await newSpec();
  await call(update, { id: retired, status: "obsolete", reason: "User dropped the export requirement in review" });

  const tree = textOf(await call(getSpecs, {}));
  check("a met spec shows its evidence in the checklist", /evidence:.*toast 'Saved'/s.test(tree));
  check("an obsolete spec says why it was retired", /retired because:.*dropped the export requirement/s.test(tree));
  check("long evidence is clipped, not dumped", !/.{200,}/.test(tree.split("evidence:")[1]?.split("\n")[0] || ""));
}

const failed = results.filter((r) => !r.cond);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
