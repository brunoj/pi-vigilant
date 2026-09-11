/**
 * Harness: loads the real pi-vigilant extension with a mocked ExtensionAPI
 * and lets a test drive agent_end / agent_settled / session_compact events,
 * capturing every pi.sendMessage call.
 */
import { createJiti } from "jiti";
import * as path from "node:path";

export async function loadExtension(extPath, { agentDir } = {}) {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const mod = await jiti.import(extPath, { default: true });

  const handlers = new Map();
  const sent = [];
  const tools = new Map();
  const commands = new Map();
  const compacted = [];
  const notifications = [];

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
    sendUserMessage() {},
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
    model: { contextWindow: 200000 },
    abort() {},
    shutdown() {},
    getContextUsage: () => undefined,
    compact(opts) { compacted.push(opts ?? {}); },
    ui: {
      notify(message, type) { notifications.push({ message, type }); },
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
    },
    getSystemPrompt: () => "",
  };

  async function emit(event, ctxOverrides = {}) {
    const fns = handlers.get(event.type) || [];
    const ctx = { ...ctxDefaults, ...ctxOverrides };
    for (const fn of fns) await fn(event, ctx);
  }

  return { pi, emit, sent, tools, commands, queue, handlers, compacted, notifications };
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
