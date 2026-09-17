/**
 * Tool-call timeout enforcement tests.
 *
 * Wiring-level (real extension via the harness):
 *  1. bash/powershell calls without a timeout get the ceiling injected.
 *  2. Calls with a timeout above the ceiling get clamped (with a notify).
 *  3. Calls with a timeout within the ceiling are left alone.
 *  4. Non-shell tools are never touched.
 *  5. set_next_tool_timeout is one-shot: raises the ceiling for the next
 *     shell call only, then reverts.
 *  6. TTL validation (non-positive / absurd values).
 *  7. Config: enforcement disabled / custom ceiling.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtension } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const EXT = process.env.PV_EXT || path.join(REPO, "index.ts");
const EXT_DIR = path.dirname(EXT);

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(s) {
  console.log(`\n=== ${s} ===`);
}

const tempDirs = [];
function extWithConfig(overrides = {}) {
  const base = path.join(REPO, "test");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, ".tmp-tt-"));
  tempDirs.push(dir);
  fs.copyFileSync(EXT, path.join(dir, "index.ts"));
  fs.cpSync(path.join(EXT_DIR, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pi-vigilant.json"),
    JSON.stringify(
      {
        specMemoryIntegration: false,
        feedbackMemoryIntegration: false,
        ...overrides,
      },
      null,
      2,
    ),
  );
  return path.join(dir, "index.ts");
}

async function load(overrides = {}) {
  return loadExtension(extWithConfig(overrides));
}

/** Emit a tool_call and return the (mutated) input object. */
async function call(h, toolName, input) {
  const event = {
    type: "tool_call",
    toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
    toolName,
    input,
  };
  await h.emit(event);
  return event.input;
}

/** Invoke the TTL tool through the registered tool definition. */
async function ttl(h, seconds) {
  const tool = h.tools.get("set_next_tool_timeout");
  if (!tool) throw new Error("set_next_tool_timeout not registered");
  return tool.execute(
    "ttl-call",
    { seconds },
    new AbortController().signal,
    undefined,
    { ui: { notify() {} } },
  );
}

section("1. injection: shell call without a timeout gets the ceiling");
{
  const h = await load();
  const bash = await call(h, "bash", { command: "sleep 100" });
  check("bash timeout injected as 1800", bash.timeout === 1800, `got ${bash.timeout}`);
  const ps = await call(h, "powershell", { command: "Start-Sleep 100" });
  check("powershell timeout injected as 1800", ps.timeout === 1800, `got ${ps.timeout}`);
  check("no clamp notification for injection", h.notifications.length === 0);
}

section("2. clamp: timeout above the ceiling is clamped down");
{
  const h = await load();
  const bash = await call(h, "bash", { command: "sleep 100", timeout: 7200 });
  check("bash timeout clamped to 1800", bash.timeout === 1800, `got ${bash.timeout}`);
  check("clamp notifies the user", h.notifications.length === 1);
  check("notification mentions the clamp", h.notifications[0]?.message?.includes("clamped"));
}

section("3. pass-through: timeout within the ceiling is untouched");
{
  const h = await load();
  const bash = await call(h, "bash", { command: "sleep 10", timeout: 100 });
  check("bash timeout stays 100", bash.timeout === 100, `got ${bash.timeout}`);
  check("no notification", h.notifications.length === 0);
}

section("4. degenerate timeout values are replaced, not passed through");
{
  const h = await load();
  const zero = await call(h, "bash", { command: "sleep 1", timeout: 0 });
  check("timeout 0 replaced with 1800", zero.timeout === 1800, `got ${zero.timeout}`);
  const neg = await call(h, "bash", { command: "sleep 1", timeout: -5 });
  check("negative timeout replaced with 1800", neg.timeout === 1800, `got ${neg.timeout}`);
  const nan = await call(h, "bash", { command: "sleep 1", timeout: Number.NaN });
  check("NaN timeout replaced with 1800", nan.timeout === 1800, `got ${nan.timeout}`);
}

section("5. non-shell tools are never touched");
{
  const h = await load();
  const read = await call(h, "read", { path: "a.ts" });
  check("read input unchanged (no timeout key)", read.timeout === undefined);
  const write = await call(h, "write", { path: "a.ts", content: "x" });
  check("write input unchanged", write.timeout === undefined);
  const custom = await call(h, "my_custom_tool", { url: "https://x" });
  check("custom tool input unchanged", custom.timeout === undefined);
}

section("6. TTL: one-shot raise for the next shell call only");
{
  const h = await load();
  const res = await ttl(h, 3600);
  check("TTL tool returns confirmation", res?.content?.[0]?.text?.includes("3600s"));
  const first = await call(h, "bash", { command: "sleep 100" });
  check("next bash call gets 3600", first.timeout === 3600, `got ${first.timeout}`);
  const second = await call(h, "bash", { command: "sleep 100" });
  check("following bash call reverts to 1800", second.timeout === 1800, `got ${second.timeout}`);
}

section("7. TTL: not consumed by non-shell calls");
{
  const h = await load();
  await ttl(h, 3600);
  await call(h, "read", { path: "a.ts" });
  const bash = await call(h, "bash", { command: "sleep 100" });
  check("TTL survives a read call and applies to the next bash", bash.timeout === 3600, `got ${bash.timeout}`);
}

section("8. TTL: validation");
{
  const h = await load();
  const bad = await ttl(h, 0);
  check("TTL 0 rejected", bad?.content?.[0]?.text?.includes("Invalid seconds"));
  const neg = await ttl(h, -100);
  check("TTL negative rejected", neg?.content?.[0]?.text?.includes("Invalid seconds"));
  const nan = await ttl(h, Number.NaN);
  check("TTL NaN rejected", nan?.content?.[0]?.text?.includes("Invalid seconds"));
  // A rejected TTL must not leave state behind.
  const bash = await call(h, "bash", { command: "sleep 1" });
  check("rejected TTL leaves default ceiling", bash.timeout === 1800, `got ${bash.timeout}`);
  // Absurd values are clamped to the 24h cap.
  const huge = await ttl(h, 999999);
  check("TTL absurd value clamped to 86400", huge?.content?.[0]?.text?.includes("86400s"));
  const after = await call(h, "bash", { command: "sleep 1" });
  check("clamped TTL applies (86400)", after.timeout === 86400, `got ${after.timeout}`);
}

section("9. config: enforcement disabled");
{
  const h = await load({ toolTimeoutEnforcement: false });
  const bash = await call(h, "bash", { command: "sleep 100" });
  check("no injection when disabled", bash.timeout === undefined, `got ${bash.timeout}`);
  const over = await call(h, "bash", { command: "sleep 100", timeout: 7200 });
  check("no clamp when disabled", over.timeout === 7200, `got ${over.timeout}`);
}

section("10. config: custom ceiling");
{
  const h = await load({ toolTimeoutCeilingSeconds: 60 });
  const bash = await call(h, "bash", { command: "sleep 100" });
  check("custom ceiling injected", bash.timeout === 60, `got ${bash.timeout}`);
  const over = await call(h, "bash", { command: "sleep 100", timeout: 120 });
  check("custom ceiling clamps", over.timeout === 60, `got ${over.timeout}`);
  const ttlRes = await ttl(h, 300);
  const ttlCall = await call(h, "bash", { command: "sleep 1" });
  check("TTL overrides custom ceiling", ttlCall.timeout === 300, `got ${ttlCall.timeout}`);
}

// Cleanup temp dirs.
for (const dir of tempDirs) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.cond);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
