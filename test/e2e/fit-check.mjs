#!/usr/bin/env node
// Read the CompactionEntry the host adopted from the session file and assert the
// clauses that are only observable in the artifact the host actually wrote.
//
//   1. no stacking — exactly one of OUR summaries is on the post-compaction path,
//      so the new summary replaced the previous one instead of sitting next to it
//      (two would mean the context grew by a whole summary and the next turn
//      overflows again: the compaction loop);
//   2. the context strictly shrank — the post-compaction context (summary + kept
//      suffix, weighed with the CONSERVATIVE estimate) must be smaller than the
//      tokensBefore the host reported. A "successful" compaction that frees almost
//      nothing is the failure mode this clause exists for;
//   3. the fit used the model's REAL prompt limit with the conservative estimate
//      clamped to 1.75-3x, not pi's low chars/4. fitBudget() returns limitTokens as
//      what the POST-compaction context may weigh and suffixBudget as
//      limitTokens/ratio - summaryTokens, so the necessary condition observable from
//      the artifact is that the kept suffix alone fits inside limitTokens/ratio.
//      (The full fit behaviour, including "summarize the overflow too, or say it was
//      dropped", is asserted by test/test-compaction-fallback.mjs against the host's
//      own context builder.)
//
// Prints one line per check as "PASS <name>" / "FAIL <name> — detail".
import { readFileSync } from "node:fs";

const sessionPath = process.argv[2];
if (!sessionPath) {
  console.log("FAIL no session path given");
  process.exit(2);
}

let entries = [];
try {
  entries = readFileSync(sessionPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
} catch (e) {
  console.log(`FAIL could not read the session file — ${e.message}`);
  process.exit(2);
}

const ours = entries.filter(
  (e) => e.type === "compaction" && e.details?.source === "pi-vigilant-compaction-fallback",
);

const out = [];
const check = (name, pass, detail = "") => out.push({ name, pass, detail });

check(
  "exactly one fallback summary on the path — it replaced, did not stack",
  ours.length === 1,
  `found ${ours.length}`,
);

const entry = ours[0] ?? {};
const d = entry.details ?? {};
const ratio = d.fitRatio;
const limit = d.fitLimitTokens;
const suffix = d.suffixTokens;
const tokensBefore = entry.tokensBefore;

const ratioOk = typeof ratio === "number" && ratio >= 1.75 && ratio <= 3;
check(
  `the estimate stayed inside the 1.75-3x band (got ${ratio})`,
  ratioOk,
  JSON.stringify(d),
);

// summary + suffix, weighed the conservative way, must be smaller than what we started with
const summaryChars = typeof entry.summary === "string" ? entry.summary.length : 0;
const postEst = ratio ? Math.ceil(summaryChars / ratio) + (suffix ?? 0) : NaN;
check(
  `the context strictly shrank (${tokensBefore} -> ~${postEst} tokens: summary ~${Math.ceil(summaryChars / (ratio || 1))} + suffix ${suffix})`,
  typeof tokensBefore === "number" && tokensBefore > 0 && Number.isFinite(postEst) && postEst < tokensBefore,
  JSON.stringify({ tokensBefore, postEst, summaryChars }),
);

check(
  `the kept suffix alone fits the conservative post-compaction budget (${suffix} <= ${limit}/${ratio} = ${limit && ratio ? Math.floor(limit / ratio) : "?"})`,
  typeof suffix === "number" && typeof limit === "number" && typeof ratio === "number" &&
    suffix <= Math.floor(limit / ratio),
  JSON.stringify(d),
);

for (const c of out) {
  console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}${c.pass || !c.detail ? "" : ` — ${c.detail}`}`);
}
process.exit(out.every((c) => c.pass) ? 0 : 1);
