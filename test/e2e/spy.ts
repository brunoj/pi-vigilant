/**
 * Event spy for the live E2E. Loaded alongside pi-vigilant with a second -e, it
 * records what the real host actually emits around compaction — which is the one
 * thing the in-process harness can only assume. When the fallback did not engage
 * this is what told us whether session_compact_failed fired at all, and with
 * which `aborted` value.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const OUT = process.env.E2E_SPY || "/tmp/e2e-spy.jsonl";
writeFileSync(OUT, "");

function rec(kind, data) {
  const slim = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k === "preparation") {
      slim.preparation = {
        firstKeptEntryId: v?.firstKeptEntryId,
        messagesToSummarize: v?.messagesToSummarize?.length ?? null,
        tokensBefore: v?.tokensBefore ?? null,
        reason: v?.reason ?? null,
      };
    } else if (k === "branchEntries") {
      slim.branchEntries = Array.isArray(v) ? v.length : null;
    } else if (k === "compaction") {
      slim.compaction = {
        summary: typeof v?.summary === "string" ? v.summary.slice(0, 60) : null,
        firstKeptEntryId: v?.firstKeptEntryId,
        fromHook: v?.details?.fromHook ?? v?.fromHook ?? null,
        mechanism: v?.details?.mechanism ?? null,
      };
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      slim[k] = v;
    }
  }
  appendFileSync(OUT, JSON.stringify({ kind, ...slim }) + "\n");
}

export default function (pi) {
  pi.on("session_before_compact", (event, ctx) => {
    rec("session_before_compact", event);
    return undefined;
  });
  pi.on("session_compact_failed", (event, ctx) => rec("session_compact_failed", event));
  pi.on("session_compact", (event, ctx) => rec("session_compact", event));
  pi.on("agent_end", (event, ctx) => rec("agent_end", { stopReason: event?.stopReason, messages: event?.messages?.length ?? null }));
}
