/**
 * Harness: loads the real pi-vigilant extension with a mocked ExtensionAPI
 * and lets a test drive agent_end / agent_settled / session_compact events,
 * capturing every pi.sendMessage call.
 */
import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * jiti alias so `@earendil-works/pi-coding-agent` resolves to the generated
 * host shim (test/setup.sh), which lets tests drive the summarizer while every
 * other export stays the real implementation. Absent when setup.sh has not run;
 * the real package is then used directly.
 */
function jitiOptions() {
  const shim = path.join(HERE, "host-shim.mjs");
  if (!fs.existsSync(shim)) return { interopDefault: true };
  return {
    interopDefault: true,
    alias: { "@earendil-works/pi-coding-agent": shim },
  };
}

export async function loadExtension(extPath, { agentDir } = {}) {
  const jiti = createJiti(import.meta.url, jitiOptions());
  const mod = await jiti.import(extPath, { default: true });

  const handlers = new Map();
  const sent = [];
  const userMessages = [];
  const tools = new Map();
  const commands = new Map();
  const compacted = [];
  /**
   * In-flight ctx.compact() simulations. The real host's AgentSession.compact()
   * is awaited by its caller; the mock's side effects (session_before_compact /
   * session_compact emission) run on a detached promise, since ctx.compact()
   * itself is fire-and-forget and some call sites (Case 1a) never pass an
   * onComplete to await. Tests that need to observe those side effects before
   * the next event (e.g. test-length-loop.mjs's loop()) await this array.
   */
  const pendingCompacts = [];
  const notifications = [];
  let failNextCompact = false;

  /**
   * A faithful `preparation`/`branchEntries` pair for the compact the mock
   * emits. The real host's AgentSession.compact() calls prepareCompaction()
   * and THROWS before emitting if it returns null, so `session_before_compact`
   * always carries a preparation with messagesToSummarize/firstKeptEntryId/
   * tokensBefore plus the branch entries. A mock that omits them makes the
   * compaction fallback throw `Cannot read properties of undefined (reading
   * 'messagesToSummarize')` the moment it is reached through ctx.compact() —
   * so every fallback assertion routed through that path was really exercising
   * the catch branch and passing vacuously. Tests may replace the span with
   * setCompactSpan() when they need specific sizes or cut points.
   */
  const CHARS_PER_TOKEN = 4;
  const spanMessageEntry = (id, role, tokens) => ({
    type: "message",
    id,
    message: {
      role,
      content: [{ type: "text", text: "x".repeat(tokens * CHARS_PER_TOKEN) }],
      timestamp: 1,
    },
  });
  const defaultSpan = () => {
    const entries = [];
    for (let i = 0; i < 4; i++) {
      entries.push(spanMessageEntry(`m${i}`, i % 2 === 0 ? "user" : "assistant", 1024));
    }
    entries.push(spanMessageEntry("k0", "assistant", 128));
    entries.push(spanMessageEntry("k1", "assistant", 128));
    return entries;
  };
  let compactSpan = null;
  const compactEvent = (opts) => {
    const entries = compactSpan ?? defaultSpan();
    const firstKeptEntryId =
      entries.find((e) => e.id.startsWith("k"))?.id ?? entries[entries.length - 1].id;
    const cutIndex = Math.max(0, entries.findIndex((e) => e.id === firstKeptEntryId));
    const messagesToSummarize = entries
      .slice(0, cutIndex)
      .filter((e) => e.type !== "compaction")
      .map((e) => (e.type === "message" ? e.message : undefined))
      .filter(Boolean);
    return {
      type: "session_before_compact",
      reason: "overflow",
      willRetry: false,
      customInstructions: opts?.customInstructions,
      signal: { aborted: false },
      preparation: {
        firstKeptEntryId,
        messagesToSummarize,
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: messagesToSummarize.length * 1024 || 4096,
        fileOps: {},
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      branchEntries: entries,
    };
  };

  // Session-side queue simulation (mirrors agent-session pendingMessageCount)
  const queue = { steering: [], followUp: [] };

  const pi = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    sendMessage(msg, opts) {
      sent.push({ msg, opts, at: Date.now() });
      // Simulate host behaviour: triggerTurn while streaming => queue
      if (opts?.deliverAs === "followUp") queue.followUp.push(msg);
      else if (opts?.deliverAs === "steer") queue.steering.push(msg);
    },
    sendUserMessage(content, opts) {
      userMessages.push({ content, opts, at: Date.now() });
      // Simulate host behaviour: while streaming, steer goes to the steering
      // queue (injected into the current turn), followUp to the follow-up queue.
      if (opts?.deliverAs === "steer") queue.steering.push({ role: "user", content });
      else if (opts?.deliverAs === "followUp") queue.followUp.push({ role: "user", content });
    },
    registerTool(t) { tools.set(t.name, t); },
    registerCommand(name, c) { commands.set(name, c); },
    registerEntryRenderer() {},
    registerMarkdownTransformer() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName() { return undefined; },
    setLabel() {},
    log() {},
  };

  mod(pi);

  const ctxDefaults = {
    hasPendingMessages: () => queue.steering.length + queue.followUp.length > 0,
    isIdle: () => false,
    model: { id: "test-model", provider: "test", contextWindow: 200000, maxTokens: 32000 },
    thinkingLevel: "off",
    modelRegistry: {
      getAll: () => [],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    abort() {},
    shutdown() {},
    getContextUsage: () => undefined,
    compact(opts) {
      compacted.push(opts ?? {});
      // Simulate the host completing the compact synchronously (the real host
      // is fire-and-forget; the extension waits on the callbacks). Tests can
      // arm a failure with failNextCompact().
      //
      // The real host's AgentSession.compact() (the manual entry point
      // ctx.compact() wraps) emits "session_before_compact" first — that is
      // where the extension's own session_before_compact handler increments
      // compactionFallbackAttempts and supplies the summary — then, on
      // success, "session_compact" (awaited) BEFORE the ctx.compact()
      // wrapper's onComplete fires; "session_compact" is what the extension's
      // session_compact handler uses to disarm compactionFallbackArmed. A
      // mock that skips either event is not faithful to the host contract and
      // hides any bug that depends on them having already run (this gap is
      // why the agent_settled overflow-retry deadlock went unnoticed by this
      // suite, and why the attempt-cap/budget checks drifted out of sync).
      if (failNextCompact) {
        failNextCompact = false;
        pendingCompacts.push(
          (async () => {
            await emit(compactEvent(opts), {});
            opts?.onError?.(new Error("compaction failed"));
          })(),
        );
      } else {
        pendingCompacts.push(
          (async () => {
            await emit(compactEvent(opts), {});
            await emit(
              {
                type: "session_compact",
                reason: "overflow",
                willRetry: false,
                fromExtension: false,
              },
              {},
            );
            opts?.onComplete?.({ tokens: 50000, contextWindow: 168000 });
          })(),
        );
      }
    },
    ui: {
      notify(message, type) { notifications.push({ message, type }); },
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
    },
    getSystemPrompt: () => "",
  };

  /**
   * Dispatch an event to every registered handler.
   *
   * Returns the handlers' results so tests can inspect what a hook such as
   * `session_before_compact` handed back to the host.
   */
  async function emit(event, ctxOverrides = {}) {
    const fns = handlers.get(event.type) || [];
    const ctx = { ...ctxDefaults, ...ctxOverrides };
    const results = [];
    for (const fn of fns) results.push(await fn(event, ctx));
    return results;
  }

  return {
    pi, emit, sent, userMessages, tools, commands, queue, handlers, compacted, notifications,
    pendingCompacts,
    /** Make the next ctx.compact() fire onError instead of onComplete. */
    failNextCompact() {
      failNextCompact = true;
    },
    /**
     * Replace the span the mock's session_before_compact reports, so a test can
     * drive the fallback with specific sizes, cut points or illegal cut points.
     */
    setCompactSpan(entries) {
      compactSpan = entries;
    },
  };
}

/** Build an assistant message with a given stopReason and text. */
export function assistantMsg({
  stopReason = "stop",
  text = "Done.",
  toolCalls = 0,
  usage = {},
  errorMessage,
} = {}) {
  const content = [];
  for (let i = 0; i < toolCalls; i++) {
    content.push({ type: "toolCall", id: `tc${i}`, name: "bash", arguments: {} });
  }
  if (text !== null) content.push({ type: "text", text });
  return {
    role: "assistant",
    content,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usage,
    },
  };
}
