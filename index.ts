/**
 * pi-vigilant — a diligence layer for pi: auto-continue after interruptions and track/verify hard specifications.
 *
 * 1. Output-length stops (stopReason === "length"): the model hit max output
 *    tokens mid-response. Queue a follow-up to finish the work.
 *
 * 2. Threshold auto-compaction: the context window was getting full and pi
 *    compacted mid-task. Queue a follow-up so the agent resumes working.
 *
 * 3. Premature stops (stopReason === "stop" but response is incomplete):
 *    the model stopped generating mid-sentence or mid-thought for no clear
 *    reason (provider flakiness). Detected via heuristics on the trailing text.
 *
 * 4. Feedback-memory integration: registers capture_feedback, resolve_feedback,
 *    and get_feedback_checkpoints tools so the agent can document user criticism
 *    and retrieve it as targeted checkpoints. The final verification prompt
 *    includes these checkpoints instead of a generic "did you do everything?".
 *
 * 5. Complexity detection: verification and continuation only fire when the
 *    task was non-trivial (had tool calls). Simple Q&A passes through silently.
 *
 * 6. Feedback compilation: when displaying checkpoints, items are grouped by
 *    category and only the most recent item per category is shown. Contradictory
 *    feedback (same category) auto-resolves the older item on capture.
 *
 * 7. Spec-memory integration: registers capture_spec, get_task_specs, and
 *    update_spec_status tools so the agent can document hard specifications
 *    (requirements, constraints, acceptance criteria) hierarchically per task.
 *    Specs are injected into the post-compaction recap and the final
 *    verification checklist (verify each spec with evidence before declaring
 *    the task complete). Tasks rotate (archive + fresh) when verification ran
 *    and no MUST spec remains open.
 *
 * No summarization, no sub-agents, no temporary files. Pure event-driven
 * continuation with guards against duplicates and edge cases.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  AgentEndEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  isContextOverflow,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai/compat";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// Resolve the directory this extension module lives in — works under jiti
// (pi's TS loader) and native ESM, so the package is relocatable.
const EXTENSION_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // Fallback for environments where import.meta.url isn't available
    return path.join(getAgentDir(), "extensions", "pi-vigilant");
  }
})();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ExtensionConfig {
  prematureStopDetection: boolean;
  lengthStopContinuation: boolean;
  compactionContinuation: boolean;
  finalVerification: boolean;
  feedbackMemoryIntegration: boolean;
  specMemoryIntegration: boolean;
  /** Drop continuations from a past epoch out of the LLM context (see epoch below). */
  staleContinuationFiltering: boolean;
  /** Hard cap on continuations queued during one unbroken failure streak. */
  maxConsecutiveFailureContinuations: number;
  /**
   * Number of consecutive retryable failures to leave to Pi's own retry layer
   * before stepping in. Should mirror the host's `retry.maxRetries` (default 3).
   */
  hostRetryBudget: number;
  /** Consecutive length continuations allowed before pausing, per unbroken streak. */
  lengthContinuationMaxConsecutive: number;
  /** Output at or below this marks a length stop as context-starved. */
  lengthContinuationTinyOutputTokens: number;
  /** Fraction of the context window considered "nearly full". */
  contextPressureRatio: number;
  /** Compact (instead of continuing) when a length stop is starved and the window is nearly full. */
  contextPressureCompaction: boolean;
  /** Hard cap on context-pressure compactions per unbroken streak. */
  maxContextPressureCompactions: number;
}

function loadConfig(): ExtensionConfig {
  const configPath = path.join(EXTENSION_DIR, "pi-vigilant.json");
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        prematureStopDetection:
          parsed.prematureStopDetection !== false,
        lengthStopContinuation:
          parsed.lengthStopContinuation !== false,
        compactionContinuation:
          parsed.compactionContinuation !== false,
        finalVerification:
          parsed.finalVerification !== false,
        feedbackMemoryIntegration:
          parsed.feedbackMemoryIntegration !== false,
        specMemoryIntegration:
          parsed.specMemoryIntegration !== false,
        staleContinuationFiltering:
          parsed.staleContinuationFiltering !== false,
        maxConsecutiveFailureContinuations: normalizeCount(
          parsed.maxConsecutiveFailureContinuations,
          DEFAULT_MAX_CONSECUTIVE_FAILURE_CONTINUATIONS,
        ),
        hostRetryBudget: normalizeCount(
          parsed.hostRetryBudget,
          DEFAULT_HOST_RETRY_BUDGET,
        ),
        lengthContinuationMaxConsecutive: normalizeCount(
          parsed.lengthContinuationMaxConsecutive,
          DEFAULT_LENGTH_CONTINUATION_MAX_CONSECUTIVE,
        ),
        lengthContinuationTinyOutputTokens: normalizeCount(
          parsed.lengthContinuationTinyOutputTokens,
          DEFAULT_LENGTH_CONTINUATION_TINY_OUTPUT_TOKENS,
        ),
        contextPressureRatio: normalizeRatio(
          parsed.contextPressureRatio,
          DEFAULT_CONTEXT_PRESSURE_RATIO,
        ),
        contextPressureCompaction:
          parsed.contextPressureCompaction !== false,
        maxContextPressureCompactions: normalizeCount(
          parsed.maxContextPressureCompactions,
          DEFAULT_MAX_CONTEXT_PRESSURE_COMPACTIONS,
        ),
      };
    }
  } catch {
    // Config read failed; use defaults
  }
  return {
    prematureStopDetection: true,
    lengthStopContinuation: true,
    compactionContinuation: true,
    finalVerification: true,
    feedbackMemoryIntegration: true,
    specMemoryIntegration: true,
    staleContinuationFiltering: true,
    maxConsecutiveFailureContinuations:
      DEFAULT_MAX_CONSECUTIVE_FAILURE_CONTINUATIONS,
    hostRetryBudget: DEFAULT_HOST_RETRY_BUDGET,
    lengthContinuationMaxConsecutive:
      DEFAULT_LENGTH_CONTINUATION_MAX_CONSECUTIVE,
    lengthContinuationTinyOutputTokens:
      DEFAULT_LENGTH_CONTINUATION_TINY_OUTPUT_TOKENS,
    contextPressureRatio: DEFAULT_CONTEXT_PRESSURE_RATIO,
    contextPressureCompaction: true,
    maxContextPressureCompactions: DEFAULT_MAX_CONTEXT_PRESSURE_COMPACTIONS,
  };
}

// ---------------------------------------------------------------------------
// Stale-continuation control
//
// When connectivity drops, every failed turn produces an `agent_end`. The
// continuation this extension queues is drained by the agent loop, pushed into
// `agent.state.messages`, persisted, and converted to a `user` role message for
// the LLM. It therefore never expires on its own: once connectivity returns and
// the work completes, N messages saying "you were interrupted, resume" are still
// sitting in the context, instructing the model to continue finished work.
//
// Three cooperating mechanisms bound and expire them:
//
//   1. Host-retry deferral — Pi already retries retryable errors with backoff.
//      Queuing our own continuation on top duplicates that. We stay out of the
//      way for the first `hostRetryBudget` consecutive retryable failures.
//      Note this must DEFER rather than SUPPRESS: `isRetryableAssistantError`
//      answers "is this class of error retryable", not "will the host retry it
//      again", so suppressing outright would mean never resuming once the host
//      exhausts its budget.
//
//   2. Circuit breaker — at most `maxConsecutiveFailureContinuations`
//      continuations per unbroken failure streak, so a long outage costs a
//      constant number of messages instead of one per failed turn.
//
//   3. Epoch stamping — every continuation carries the epoch it was queued in.
//      The first successful turn after a failure streak increments the epoch,
//      which is precisely the moment those continuations stopped being true.
//      A `context` handler then drops past-epoch continuations from the LLM
//      context before each call.
// ---------------------------------------------------------------------------

/** Default cap on continuations queued during a single failure streak. */
const DEFAULT_MAX_CONSECUTIVE_FAILURE_CONTINUATIONS = 3;

/** Default assumed host retry budget (Pi's `retry.maxRetries` default is 3). */
const DEFAULT_HOST_RETRY_BUDGET = 3;

/** §5.1 — output-length continuation loop bounds (see Case 1 in agent_end). */
const DEFAULT_LENGTH_CONTINUATION_MAX_CONSECUTIVE = 3;
const DEFAULT_LENGTH_CONTINUATION_TINY_OUTPUT_TOKENS = 64;
const DEFAULT_CONTEXT_PRESSURE_RATIO = 0.9;
const DEFAULT_MAX_CONTEXT_PRESSURE_COMPACTIONS = 2;
const CONTEXT_PRESSURE_COMPACTION_COOLDOWN_MS = 60_000;

/**
 * customTypes this extension queues. The context filter only ever considers
 * these, so custom messages from other extensions are never touched.
 */
const CONTINUATION_CUSTOM_TYPES = new Set([
  "auto-continue-abort",
  "auto-continue-length",
  "auto-continue-premature",
  "auto-continue-error",
  "auto-continue-compaction",
]);

/**
 * Identifies the process that queued a continuation.
 *
 * The epoch counter lives in memory but continuations are persisted, so after
 * `--continue`/`--session` the counter restarts at 0 while inherited
 * continuations still carry the previous process's epochs — comparing the two
 * is meaningless. The run id makes "queued by an earlier process" decidable:
 * any continuation with a different run id was delivered and acted on before
 * this process started, so whatever it interrupted is necessarily over.
 */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Coerce a config value to a non-negative integer, falling back to a default. */
function normalizeCount(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

/**
 * Coerce a config value to a fraction in (0, 1], falling back to a default.
 *
 * Deliberately NOT `normalizeCount`: that floors, which would turn the default
 * `contextPressureRatio` of 0.9 into 0 — making every window look "nearly full"
 * and compacting constantly.
 */
function normalizeRatio(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value <= 0 || value > 1) return fallback;
  return value;
}

// ---------------------------------------------------------------------------
// Spec-Memory — types and helpers
// ---------------------------------------------------------------------------

interface Trace {
  /** Operator-facing observable outcome this spec delivers (e.g. "ingested report has an agent_title on the card"). */
  outcome: string;
  /** Concrete code path that delivers it (e.g. "ingest → analyze() → persist → render"). */
  codePath: string;
  /** Test file that asserts the outcome (optional — required for feature/behavior specs). */
  testFile?: string;
  /** Assertion string that must appear in testFile. */
  assertion?: string;
}

interface SpecItem {
  id: string;
  requirement: string;
  area: string;
  priority: "must" | "should" | "nice-to-have";
  status: "open" | "in-progress" | "met" | "partial" | "not-met" | "obsolete";
  parentId?: string;
  sourceQuote?: string;
  supersedes?: string[];
  evidence?: string;
  verifiedAt?: string;
  /** Spec-to-code traceability (M1): how this spec's outcome is delivered and tested. */
  trace?: Trace;
}

interface SpecTask {
  taskId: string;
  title: string;
  startedAt: string;
  verificationSentAt?: string;
  areas: Record<string, SpecItem[]>;
}

const SPEC_AREAS = [
  "functionality",
  "ui-ux",
  "performance",
  "security",
  "error-handling",
  "testing",
  "documentation",
  "compatibility",
  "constraints",
  "format",
  "data",
  "deployment",
  "other",
] as const;

function getSpecDir(): string {
  return path.join(getAgentDir(), "skills", "spec-memory");
}

function getCurrentTaskFile(): string {
  const projectName = path.basename(process.cwd());
  return path.join(getSpecDir(), "projects", projectName, "current-task.json");
}

function getArchivedTaskFile(taskId: string): string {
  const projectName = path.basename(process.cwd());
  return path.join(
    getSpecDir(),
    "projects",
    projectName,
    "archived",
    `${taskId}.json`,
  );
}

function loadSpecTask(filePath: string): SpecTask | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSpecTask(filePath: string, task: SpecTask): void {
  ensureSpecDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(task, null, 2), "utf-8");
}

function ensureSpecDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateSpecId(): string {
  return `spc-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function generateTaskId(): string {
  return `tsk-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function normalizeSpecText(text: string): string {
  return text.trim().toLowerCase().replace(/[.,\/#!$%^&*;:{}+=\-_()\[\]"'<>]/g, "");
}

function specsOverlap(requirement1: string, requirement2: string): boolean {
  const norm1 = normalizeSpecText(requirement1);
  const norm2 = normalizeSpecText(requirement2);
  const tokens1 = norm1.split(" ").filter((t) => t.length > 0);
  const tokens2 = norm2.split(" ").filter((t) => t.length > 0);
  if (tokens1.length === 0 || tokens2.length === 0) return false;
  const intersection = tokens1.filter((t) => tokens2.includes(t));
  return intersection.length >= 0.8 * tokens1.length;
}

function formatSpecTree(task: SpecTask): string {
  if (Object.keys(task.areas).length === 0) return "";

  const lines: string[] = ["", "=== TASK SPECIFICATIONS ==="];
  lines.push(`(${task.taskId} — ${task.title})`);

  let openCount = 0;
  for (const [area, specs] of Object.entries(task.areas)) {
    const areaOpen = specs.filter((s) => s.status === "open" || s.status === "in-progress").length;
    openCount += areaOpen;
    lines.push(`\n[${area}]`);
    for (const spec of specs) {
      const status = spec.status === "open" ? "open" : spec.status;
      lines.push(`  [${spec.priority}][${status}]  ${spec.id}: ${spec.requirement}`);
      if (spec.parentId) {
        lines.push(`    → Sub-spec: ${spec.requirement}`);
      }
      if (spec.trace) {
        lines.push(`    → trace: ${spec.trace.outcome}`);
        lines.push(`      code path: ${spec.trace.codePath}`);
        if (spec.trace.testFile) {
          lines.push(
            `      test: ${spec.trace.testFile}${spec.trace.assertion ? ` (asserts "${spec.trace.assertion}")` : ""}`,
          );
        }
      }
    }
  }

  lines.push(
    `\nTotal: ${Object.values(task.areas).flat().length} specs, ${openCount} open.`,
  );
  lines.push("Verify EACH specification against the actual deliverable.");
  lines.push("Use update_spec_status with concrete evidence for met/not-met.");
  lines.push("=== END SPECIFICATIONS ===");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Continuation prompts
// ---------------------------------------------------------------------------

const LENGTH_CONTINUATION_PROMPT = `Your previous response was cut off because it reached the model's maximum output token limit. Continue exactly where you stopped and finish the current task. Do not repeat the completed portion. If a tool call was cut off or its result was truncated, re-issue the complete tool call instead of assuming it ran. Keep working through clear next steps; if the task is complete, provide the final result.`;

const COMPACTION_CONTINUATION_PROMPT = `Continue working on the user's current task from the compacted context. Inspect the summary and retained recent messages, do not repeat completed work, and take the next concrete action. Do not stop at a progress recap or plan when clear low-risk work remains. If the task is actually complete, perform a brief completion check and report the result instead of inventing more work.`;

const PREMATURE_STOP_PROMPT = `Your previous response appears to have stopped prematurely — it ends mid-sentence or mid-thought. Continue exactly where you left off and finish what you were about to do. Do not repeat the completed portion. If you were about to call a tool, call it now. If you were explaining something, finish the explanation. Keep working through clear next steps; if the task is actually complete, provide the final result.`;

// ---------------------------------------------------------------------------
// Feedback Memory — types and helpers
// ---------------------------------------------------------------------------

interface FeedbackItem {
  id: string;
  timestamp: string;
  scope: "project" | "global";
  project?: string;
  category: string;
  specific_behavior: string;
  expected_behavior: string;
  user_quote: string;
  resolved: boolean;
  resolved_at: string | null;
}

function getFeedbackDir(): string {
  return path.join(getAgentDir(), "skills", "feedback-memory");
}

function getGlobalFile(): string {
  return path.join(getFeedbackDir(), "global-feedback.json");
}

function getProjectFile(): string {
  const projectName = path.basename(process.cwd());
  return path.join(getFeedbackDir(), "projects", projectName, "feedback.json");
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadItems(filePath: string): FeedbackItem[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveItems(filePath: string, items: FeedbackItem[]): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(items, null, 2), "utf-8");
}

function loadUnresolvedItems(filePath: string): FeedbackItem[] {
  return loadItems(filePath).filter((item) => !item.resolved);
}

function generateId(): string {
  return `fb-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/**
 * Compile feedback items into a concise, non-contradictory summary.
 *
 * Rules:
 * - Group by category
 * - Within each category, only the MOST RECENT item is kept (newer supersedes older)
 * - Items are sorted by recency within each category
 * - Returns a formatted string with a summary header
 */
function compileFeedback(
  projectItems: FeedbackItem[],
  globalItems: FeedbackItem[],
  projectName: string,
): string {
  const allItems = [...projectItems, ...globalItems];
  if (allItems.length === 0) return "";

  // Group by scope+category, keeping only the most recent per group.
  // Scope is part of the key so a global item can never mask a
  // project-specific item in the same category (they address different
  // things and both must be checked).
  const byCategory = new Map<string, FeedbackItem>();
  for (const item of allItems) {
    const key = `${item.scope === "project" ? "project" : "global"}:${item.category}`;
    const existing = byCategory.get(key);
    if (!existing || item.timestamp > existing.timestamp) {
      byCategory.set(key, item);
    }
  }

  // Sort categories: project items first, then global; within each, by recency
  const projectCats = new Map<string, FeedbackItem>();
  const globalCats = new Map<string, FeedbackItem>();
  for (const [key, item] of byCategory) {
    const cat = key.slice(key.indexOf(":") + 1);
    if (item.scope === "project") projectCats.set(cat, item);
    else globalCats.set(cat, item);
  }

  const sortedProject = [...projectCats.entries()].sort(
    (a, b) => (b[1].timestamp > a[1].timestamp ? 1 : -1),
  );
  const sortedGlobal = [...globalCats.entries()].sort(
    (a, b) => (b[1].timestamp > a[1].timestamp ? 1 : -1),
  );

  const lines: string[] = [];
  lines.push("");
  lines.push("=== FEEDBACK CHECKPOINTS ===");

  const totalCategories = byCategory.size;
  const totalItems = allItems.length;
  const compiledCount = byCategory.size;
  if (totalItems > compiledCount) {
    lines.push(
      `${totalItems} feedback items compiled into ${compiledCount} categories ` +
        `(only the most recent per category is shown).`,
    );
  } else {
    lines.push(`${compiledCount} feedback item(s) to check.`);
  }
  lines.push("Address EACH checkpoint before declaring work complete.");
  lines.push("");

  if (sortedProject.length > 0) {
    lines.push(`PROJECT-LEVEL (${projectName}):`);
    lines.push("");
    for (const [, item] of sortedProject) {
      lines.push(`  [${item.category}] ${item.specific_behavior}`);
      lines.push(`      → ${item.expected_behavior}`);
      if (item.user_quote) {
        lines.push(`      → User: "${item.user_quote}"`);
      }
      lines.push("");
    }
  }

  if (sortedGlobal.length > 0) {
    lines.push("GLOBAL-LEVEL:");
    lines.push("");
    for (const [, item] of sortedGlobal) {
      lines.push(`  [${item.category}] ${item.specific_behavior}`);
      lines.push(`      → ${item.expected_behavior}`);
      if (item.user_quote) {
        lines.push(`      → User: "${item.user_quote}"`);
      }
      lines.push("");
    }
  }

  lines.push("=== END CHECKPOINTS ===");
  lines.push("");
  return lines.join("\n");
}

/**
 * Get compiled checkpoints for the current project + global.
 */
function getFeedbackCheckpoints(): string {
  const projectName = path.basename(process.cwd());
  const globalItems = loadUnresolvedItems(getGlobalFile());
  const projectItems = loadUnresolvedItems(getProjectFile());
  return compileFeedback(projectItems, globalItems, projectName);
}

/**
 * When capturing new feedback, if an unresolved item in the same category
 * already exists, auto-resolve it (newer feedback supersedes older).
 * Returns the ID of the resolved item, or null if none was resolved.
 */
function autoResolveContradictory(
  filePath: string,
  category: string,
  newTimestamp: string,
): string | null {
  const items = loadItems(filePath);
  let resolvedId: string | null = null;
  for (const item of items) {
    if (
      !item.resolved &&
      item.category === category &&
      item.timestamp < newTimestamp
    ) {
      item.resolved = true;
      item.resolved_at = newTimestamp;
      resolvedId = item.id;
    }
  }
  if (resolvedId) {
    saveItems(filePath, items);
  }
  return resolvedId;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Cooldown period for verification prompts (15 minutes). */
const VERIFICATION_COOLDOWN_MS = 15 * 60 * 1000;

/** Minimum tool calls in a turn to consider it a "complex task" vs simple Q&A. */
const MIN_TOOL_CALLS_FOR_COMPLEX_TASK = 1;

interface ContinuationState {
  lengthQueued: boolean;
  compactionQueued: boolean;
  prematureQueued: boolean;
  /** Whether the last agent_end had a conclusive (complete) response. */
  lastResponseConclusive: boolean;
  /** Timestamp (ms) of the last verification prompt, or 0 if never sent. */
  lastVerificationTime: number;
  /** Whether any continuation (length/premature/compaction) fired since the last verification. */
  continuationSinceLastVerification: boolean;
  /**
   * Monotonic continuation epoch. Continuations are stamped with the epoch they
   * were queued in; the first successful turn after a failure streak increments
   * it, marking every earlier continuation as describing an interruption that is
   * over. Never reset — it must keep rising for the whole session, otherwise a
   * later epoch could collide with stamps already sitting in the context.
   */
  epoch: number;
  /** Consecutive failed turns in the current streak (reset by any successful turn). */
  consecutiveFailures: number;
  /** Continuations queued during the current failure streak (bounded by config). */
  failureContinuationsQueued: number;
  /** Consecutive output-length continuations since the last real progress. */
  lengthContinuationsQueued: number;
  /** Consecutive context-starved length stops. */
  starvedLengthStreak: number;
  /** Context-pressure compactions requested in the current streak. */
  contextPressureCompactionsQueued: number;
  /** Timestamp (ms) of the last context-pressure compaction request. */
  lastContextPressureCompactionTime: number;
  /** Number of tool calls in the last agent run (used to detect simple Q&A vs complex task). */
  lastRunToolCallCount: number;
  /** Tool calls since the last genuine user message (task boundary). */
  taskToolCallCount: number;
  /** Total tool calls across the entire session (for complexity heuristics). */
  sessionTotalToolCalls: number;
  /** Current active task ID for spec-memory. */
  currentTaskId?: string;
  /** Path to current task file. */
  currentTaskPath?: string;
  /** Title of current task (first spec's context). */
  currentTaskTitle?: string;
}

// ---------------------------------------------------------------------------
// Premature-stop detection heuristics
//
// These detect when the model returned stopReason "stop" but the text content
// ends in a way that strongly suggests the response was cut short — typically
// a provider-side issue where the model stopped generating for no clear reason.
// ---------------------------------------------------------------------------

/** Patterns that indicate the text ends in the middle of a sentence/thought. */
const INCOMPLETE_END_PATTERNS: RegExp[] = [
  // Ends with a hanging colon (about to list/explain/do something)
  /:\s*$/,
  // Ends with a comma (mid-list or mid-clause)
  /,\s*$/,
  // Ends with a dash or ellipsis (trailing off)
  /[-–—…]\s*$/,
  // Ends with a hanging conjunction or preposition
  /(and|but|or|because|so|then|if|when|while|although|since|unless|until|after|before|like|such as|for example|e\.g\.|i\.e\.|namely|specifically|including|particularly)\s*$/i,
  // Ends with an incomplete sentence: lowercase letter (sentence cut off)
  /[a-z]\s*$/,
  // Ends with an incomplete code block opener
  /```\s*$/,
  // Ends with an unclosed inline code backtick
  /`[^`]*$/,
  // Ends with an unclosed bracket
  /[\(\[\{]\s*$/,
  // Ends with a hanging quote
  /[""'']\s*$/,
  // Ends with a hanging HTML/XML tag opener
  /<[a-zA-Z][^>]*$/,
  // Ends with a hanging markdown link/image syntax
  /\[[^\]]*$/,
  /!\[[^\]]*$/,
];

/** Patterns that indicate a conclusive, complete ending. */
const CONCLUSIVE_END_PATTERNS: RegExp[] = [
  // Ends with sentence-ending punctuation followed by optional whitespace
  /[.!?]\s*$/,
  // Ends with a closing code block
  /```\s*$/,
  // Ends with a closing bracket (balanced)
  /[\)\]\}]\s*$/,
];

/** Maximum length of trailing text to check for incomplete patterns. */
const TRAILING_CHECK_LENGTH = 120;

function getLastTextBlock(
  content: AssistantMessage["content"],
): string | undefined {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block.type === "text" && block.text.trim().length > 0) {
      return block.text;
    }
  }
  return undefined;
}

function hasToolCalls(content: AssistantMessage["content"]): boolean {
  return content.some((b) => b.type === "toolCall");
}

/**
 * Count tool calls in an assistant message.
 */
function countToolCalls(content: AssistantMessage["content"]): number {
  return content.filter((b) => b.type === "toolCall").length;
}

/**
 * Detect whether the text ends in a way that suggests the response was
 * cut short prematurely.
 */
function isPrematureStop(
  assistant: AssistantMessage,
): boolean {
  // Only applies to stopReason "stop" — length/error/aborted are handled elsewhere.
  if (assistant.stopReason !== "stop") return false;

  // If there are tool calls, the model intentionally handed off to tools.
  // This is a normal stop, not premature.
  if (hasToolCalls(assistant.content)) return false;

  // If the response has no text content, nothing to check.
  const text = getLastTextBlock(assistant.content);
  if (!text) return false;

  const trimmed = text.trimEnd();

  // Check for conclusive endings first — if it ends with ".", "!", "?" or
  // a closing code block, it's likely complete.
  for (const pattern of CONCLUSIVE_END_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }

  // Check the trailing portion for incomplete patterns.
  const trailing = trimmed.slice(-TRAILING_CHECK_LENGTH);

  for (const pattern of INCOMPLETE_END_PATTERNS) {
    if (pattern.test(trailing)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AssistantMessage = Extract<
  AgentEndEvent["messages"][number],
  { role: "assistant" }
>;

/** Any message as it appears in the LLM context list. */
type AgentMessage = AgentEndEvent["messages"][number];

/**
 * Is this one of our own continuations describing an interruption that is over?
 *
 * Two ways to be stale:
 *   1. queued by an earlier process (different run id) — it was already
 *      delivered and acted on before this session was resumed;
 *   2. queued by this process in a superseded epoch — a later turn succeeded,
 *      so the outage it describes has ended.
 *
 * Conservative by construction — anything not unambiguously a stale
 * pi-vigilant continuation is kept:
 *   - only `role: "custom"` messages are considered;
 *   - only our five `auto-continue-*` customTypes, so other extensions' custom
 *     messages are never touched;
 *   - only messages carrying a numeric `epoch`, so continuations written by
 *     versions before epoch stamping are never retroactively dropped.
 */
function isStaleContinuation(
  message: AgentMessage,
  currentEpoch: number,
): boolean {
  if (message.role !== "custom") return false;
  if (!CONTINUATION_CUSTOM_TYPES.has(message.customType)) return false;

  const details = message.details as
    | { epoch?: unknown; runId?: unknown }
    | undefined;

  const epoch = details?.epoch;
  if (typeof epoch !== "number" || !Number.isFinite(epoch)) return false;

  if (details?.runId !== RUN_ID) return true; // inherited from a previous run
  return epoch < currentEpoch;
}

function lastAssistantMessage(
  messages: AgentEndEvent["messages"],
): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") return m as AssistantMessage;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  const state: ContinuationState = {
    lengthQueued: false,
    compactionQueued: false,
    prematureQueued: false,
    lastResponseConclusive: true,
    lastVerificationTime: 0,
    continuationSinceLastVerification: false,
    epoch: 0,
    consecutiveFailures: 0,
    failureContinuationsQueued: 0,
    lengthContinuationsQueued: 0,
    starvedLengthStreak: 0,
    contextPressureCompactionsQueued: 0,
    lastContextPressureCompactionTime: 0,
    lastRunToolCallCount: 0,
    taskToolCallCount: 0,
    sessionTotalToolCalls: 0,
    currentTaskId: undefined,
    currentTaskPath: undefined,
    currentTaskTitle: undefined,
  };

  // ======================================================================
  // FEEDBACK MEMORY TOOLS
  // ======================================================================

  // ── capture_feedback ─────────────────────────────────────────────────
  pi.registerTool({
    name: "capture_feedback",
    label: "Capture Feedback",
    description:
      "Document user criticism or feedback about your behavior as an agent. " +
      "Call this when the user corrects a mistake, points out an omission, " +
      "complains about a recurring pattern ('you always...', 'you keep...'), " +
      "or gives you a specific instruction about how to work more effectively. " +
      "Do NOT call this for casual conversation, task instructions, or praise. " +
      "Do NOT call this for meta-questions about the feedback system itself " +
      "(e.g. 'should this have been captured?'). " +
      "Do NOT call this for feedback about your behavior from a different project or session.",
    promptSnippet: "Document user criticism as a feedback item (project or global scope)",
    promptGuidelines: [
      "Use capture_feedback when the user criticizes your behavior, especially if they say 'you always' or 'you keep' — document it immediately before responding.",
      "Scope as 'project' if feedback is specific to this project's conventions or domain. Scope as 'global' ONLY if it applies to all your work universally across ALL projects.",
      "Default to 'project' scope. Only use 'global' for truly universal behavior patterns that apply regardless of project.",
      "Do NOT capture feedback about your behavior from other projects or sessions — only the current one.",
    ],
    parameters: Type.Object({
      scope: StringEnum(["project", "global"] as const, {
        description:
          "'project' if feedback is specific to this project, 'global' if it applies to all your work",
      }),
      category: StringEnum(
        [
          "diligence",
          "thoroughness",
          "testing",
          "communication",
          "code-quality",
          "verification",
          "completeness",
          "other",
        ] as const,
        { description: "Category of the feedback" },
      ),
      specific_behavior: Type.String({
        description:
          "Exactly what you did wrong — be specific, not vague. E.g. 'Stopped after first working solution without considering edge cases'",
      }),
      expected_behavior: Type.String({
        description:
          "What you should do instead. E.g. 'After implementing, enumerate edge cases, test with sample inputs, consider alternatives'",
      }),
      user_quote: Type.Optional(
        Type.String({
          description:
            "Quote or paraphrase what the user said (helps with context)",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        scope: "project" | "global";
        category: string;
        specific_behavior: string;
        expected_behavior: string;
        user_quote?: string;
      },
      _signal: AbortSignal,
      _onUpdate:
        | ((update: { content: { type: string; text: string }[] }) => void)
        | undefined,
      _ctx: ExtensionContext,
    ) {
      const timestamp = new Date().toISOString();
      const targetFile =
        params.scope === "global" ? getGlobalFile() : getProjectFile();

      // Auto-resolve any existing unresolved item in the same category
      // (newer feedback supersedes older, contradictory feedback)
      const resolvedId = autoResolveContradictory(
        targetFile,
        params.category,
        timestamp,
      );

      const item: FeedbackItem = {
        id: generateId(),
        timestamp,
        scope: params.scope,
        project:
          params.scope === "project" ? path.basename(process.cwd()) : undefined,
        category: params.category,
        specific_behavior: params.specific_behavior,
        expected_behavior: params.expected_behavior,
        user_quote: params.user_quote ?? "",
        resolved: false,
        resolved_at: null,
      };

      const existing = loadItems(targetFile);
      existing.push(item);
      saveItems(targetFile, existing);

      const resultLines: string[] = [
        `Feedback captured: ${item.id}`,
        `  Scope: ${params.scope}`,
        `  Category: ${params.category}`,
        `  Behavior: ${params.specific_behavior}`,
      ];
      if (params.user_quote) {
        resultLines.push(`  User: "${params.user_quote}"`);
      }
      if (resolvedId) {
        resultLines.push(
          `  Note: Superseded previous feedback item ${resolvedId} (same category, newer feedback wins)`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: resultLines.join("\n"),
          },
        ],
        details: { item, superseded: resolvedId },
      };
    },
  });

  // ── resolve_feedback ─────────────────────────────────────────────────
  pi.registerTool({
    name: "resolve_feedback",
    label: "Resolve Feedback",
    description:
      "Mark a feedback item as resolved. Call this when you've consistently " +
      "demonstrated improved behavior and the user confirms the issue is addressed, " +
      "or when a feedback item is no longer relevant.",
    promptSnippet: "Mark a feedback item as resolved",
    parameters: Type.Object({
      id: Type.String({
        description: "The ID of the feedback item to resolve (e.g. 'fb-1234567890-12345')",
      }),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string },
      _signal: AbortSignal,
      _onUpdate:
        | ((update: { content: { type: string; text: string }[] }) => void)
        | undefined,
      _ctx: ExtensionContext,
    ) {
      const timestamp = new Date().toISOString();
      const searchFiles = [getGlobalFile(), getProjectFile()];
      let found = false;

      for (const filePath of searchFiles) {
        const items = loadItems(filePath);
        const idx = items.findIndex((item) => item.id === params.id);
        if (idx !== -1) {
          items[idx].resolved = true;
          items[idx].resolved_at = timestamp;
          saveItems(filePath, items);
          found = true;
          break;
        }
      }

      if (!found) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Feedback item '${params.id}' not found.`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Feedback ${params.id} resolved.`,
          },
        ],
        details: { resolved: true, id: params.id },
      };
    },
  });

  // ── get_feedback_checkpoints ─────────────────────────────────────────
  pi.registerTool({
    name: "get_feedback_checkpoints",
    label: "Get Feedback Checkpoints",
    description:
      "Retrieve all unresolved user criticism/feedback items (project-level and global) " +
      "formatted as a compiled checklist. Items are grouped by category and only the " +
      "most recent item per category is shown (newer feedback supersedes older). " +
      "Use this before finishing work to check if past user feedback applies. " +
      "Also called automatically by auto-continue during final verification.",
    promptSnippet: "Retrieve unresolved feedback checkpoints from past user criticism",
    promptGuidelines: [
      "Use get_feedback_checkpoints before declaring work complete to check if past user feedback applies.",
    ],
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate:
        | ((update: { content: { type: string; text: string }[] }) => void)
        | undefined,
      _ctx: ExtensionContext,
    ) {
      const checkpoints = getFeedbackCheckpoints();
      if (!checkpoints) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No unresolved feedback items found. ✓",
            },
          ],
          details: { items: [] },
        };
      }
      return {
        content: [{ type: "text" as const, text: checkpoints }],
        details: { items: "checklist" },
      };
    },
  });

  // ── /clear-feedback command (user-only) ──────────────────────────────
  pi.registerCommand("clear-feedback", {
    description: "Clear all feedback memory items (project-level and global). User-only command.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const globalFile = getGlobalFile();
      const projectFile = getProjectFile();

      const confirmed = await ctx.ui.confirm(
        "Clear Feedback",
        "This will delete ALL feedback items (project-level and global). Are you sure?",
      );
      if (!confirmed) {
        ctx.ui.notify("Clear cancelled.", "info");
        return;
      }

      saveItems(globalFile, []);
      saveItems(projectFile, []);
      ctx.ui.notify("All feedback memory cleared.", "info");
    },
  });

  // ======================================================================
  // SPEC-MEMORY TOOLS
  // ======================================================================

  // ── capture_spec ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "capture_spec",
    label: "Capture Specification",
    description:
      "Document a hard specification (requirement, constraint, acceptance criterion, format, deliverable) " +
      "that the user explicitly states. Use this for deliverable/constraint requirements — " +
      "behavior criticism stays in capture_feedback. " +
      "Do NOT capture: behavior criticism ('you keep...'), context/background, vague preferences, " +
      "casual conversation, praise, meta-questions, or task instructions themselves. " +
      "Litmus test: 'Will the user check the deliverable against this? Can I objectively verify it?' — if yes to both, CAPTURE.",
    promptSnippet: "Capture a hard specification (requirement/constraint) the user stated",
    promptGuidelines: [
      "Capture immediately when a hard requirement/constraint is stated — before responding.",
      "Use area to categorize: functionality, security, testing, constraints, format, documentation, etc.",
      "Default priority is 'must' — use 'should' only if user says it's important but not blocking.",
      "Use parentId to decompose broad specs into sub-specs.",
      "Use supersedes when the user changes a requirement (mark old spec as obsolete).",
      "Be specific and checkable: 'API must return 401' is good; 'make it secure' is bad.",
      "EXTERNAL PLANNING DOCS: when a task references or contains external planning documents (IMPROVEMENT-PLAN.md, PLAN.md, requirements docs, delivery logs, ticket lists), ingest every actionable item as its own spec with sourceQuote pointing at the doc + item id. The doc's own ✅/delivered markers are claims, not evidence — each item gets traced and verified like any other spec.",
    ],
    parameters: Type.Object({
      requirement: Type.String({
        description:
          "The hard specification — a checkable requirement, constraint, acceptance criterion, format, or deliverable.",
      }),
      area: StringEnum(SPEC_AREAS, {
        description:
          "Area category: functionality, ui-ux, performance, security, error-handling, testing, " +
          "documentation, compatibility, constraints, format, data, deployment, other.",
      }),
      priority: StringEnum(["must", "should", "nice-to-have"] as const, {
        description:
          "Priority: 'must' (user checks it/blocker), 'should' (important but not blocking), " +
          "'nice-to-have' (optional). Default is 'must'.",
      }),
      parentId: Type.Optional(
        Type.String({
          description:
            "Parent spec ID if this is a sub-spec (decomposes a broad requirement into concrete checks).",
        }),
      ),
      sourceQuote: Type.Optional(
        Type.String({
          description:
            "Quote or paraphrase what the user said (helps with context and verification).",
        }),
      ),
      supersedes: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Array of spec IDs this replaces (when the user changes a requirement).",
          }),
        ),
      ),
      trace: Type.Optional(
        Type.Object({
          outcome: Type.String({
            description:
              "Operator-facing observable outcome this spec delivers (e.g. \"ingested report has an agent_title on the card\").",
          }),
          codePath: Type.String({
            description:
              "Concrete code path that delivers it (e.g. \"ingest → analyze() → persist → render\").",
          }),
          testFile: Type.Optional(
            Type.String({
              description:
                "Test file that asserts the outcome (required for feature/behavior specs).",
            }),
          ),
          assertion: Type.Optional(
            Type.String({
              description: "Assertion string that must appear in testFile.",
            }),
          ),
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        requirement: string;
        area: string;
        priority: "must" | "should" | "nice-to-have";
        parentId?: string;
        sourceQuote?: string;
        supersedes?: string[];
        trace?: Trace;
      },
      _signal: AbortSignal,
      _onUpdate:
        | ((update: { content: { type: string; text: string }[] }) => void)
        | undefined,
      _ctx: ExtensionContext,
    ) {
      const timestamp = new Date().toISOString();
      const currentFile = getCurrentTaskFile();

      // Load or create current task
      let task = loadSpecTask(currentFile);
      if (!task) {
        task = {
          taskId: generateTaskId(),
          title: params.requirement,
          startedAt: timestamp,
          verificationSentAt: undefined,
          areas: {},
        };
      }

      // Dedup guard: check for near-identical specs in the same area
      const specId = generateSpecId();
      const areaSpecs = task.areas[params.area] || [];
      for (const existing of areaSpecs) {
        if (
          existing.status !== "obsolete" &&
          specsOverlap(existing.requirement, params.requirement)
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Spec already exists (near-duplicate in ${params.area}): ${existing.id}` +
                  `\n  Requirement: ${existing.requirement}\n  Status: ${existing.status}\n  Priority: ${existing.priority}\n  Evidence: ${existing.evidence || "none"}`,
              },
            ],
            details: { duplicate: true, existingSpecId: existing.id },
          };
        }
      }

      // Handle supersedes: mark old specs as obsolete
      let supersededIds: string[] = [];
      if (params.supersedes && params.supersedes.length > 0) {
        for (const oldId of params.supersedes) {
          const areaSpecs = task.areas[params.area] || [];
          const idx = areaSpecs.findIndex((s) => s.id === oldId);
          if (idx !== -1) {
            areaSpecs[idx] = {
              ...areaSpecs[idx],
              status: "obsolete",
              supersededBy: specId,
            } as SpecItem;
            supersededIds.push(oldId);
          }
        }
      }

      // Create new spec
      const spec: SpecItem = {
        id: specId,
        requirement: params.requirement,
        area: params.area,
        priority: params.priority,
        status: "open",
        parentId: params.parentId,
        sourceQuote: params.sourceQuote || "",
        supersedes: params.supersedes,
        evidence: undefined,
        verifiedAt: undefined,
        trace: params.trace,
      };

      // Add to area
      if (!task.areas[params.area]) {
        task.areas[params.area] = [];
      }
      task.areas[params.area].push(spec);

      // Save task
      saveSpecTask(currentFile, task);

      // Track in state so rotation and injection use the right task
      state.currentTaskId = task.taskId;
      state.currentTaskPath = currentFile;
      state.currentTaskTitle = task.title;

      const resultLines: string[] = [
        `Spec captured: ${specId}`,
        `  Task: ${task.taskId} (${task.title})`,
        `  Area: ${params.area}`,
        `  Priority: ${params.priority}`,
        `  Requirement: ${params.requirement}`,
      ];
      if (params.sourceQuote) {
        resultLines.push(`  Source: "${params.sourceQuote}"`);
      }
      if (supersededIds.length > 0) {
        resultLines.push(`  Note: Superseded ${supersededIds.join(", ")}`);
      }
      resultLines.push(`  Per-area counts: ${Object.keys(task.areas).map((a) => `${a}: ${task.areas[a].length}`).join(", ")}`);

      return {
        content: [
          {
            type: "text" as const,
            text: resultLines.join("\n"),
          },
        ],
        details: { spec, task, superseded: supersededIds },
      };
    },
  });

  // ── get_task_specs ───────────────────────────────────────────────────
  pi.registerTool({
    name: "get_task_specs",
    label: "Get Task Specifications",
    description:
      "Retrieve all specifications for the current task as a hierarchical tree. " +
      "Call this mid-task for awareness, after compaction for spec recap, and " +
      "before declaring work complete to verify each spec against the deliverable.",
    promptSnippet: "Retrieve all specs for the current task",
    promptGuidelines: [
      "Call get_task_specs before declaring work complete to verify each spec.",
      "After compaction, call get_task_specs to get the spec recap for continuation.",
    ],
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate:
        | ((update: { content: { type: string; text: string }[] }) => void)
        | undefined,
      _ctx: ExtensionContext,
    ) {
      const currentFile = getCurrentTaskFile();
      const task = loadSpecTask(currentFile);

      if (!task || Object.keys(task.areas).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active task or no specifications found yet. Call capture_spec to add requirements.",
            },
          ],
          details: { task: null },
        };
      }

      const tree = formatSpecTree(task);
      return {
        content: [{ type: "text" as const, text: tree }],
        details: { task },
      };
    },
  });

  // ── update_spec_status ───────────────────────────────────────────────
  pi.registerTool({
    name: "update_spec_status",
    label: "Update Specification Status",
    description:
      "Mark a specification as met/not-met with concrete evidence. " +
      "Terminal statuses (met/not-met) require evidence (test output, build result, code inspection). " +
      "If a spec cannot be objectively verified, use status 'partial' with a note explaining why " +
      "and ask the user — never self-certify unverifiable specs.",
    promptSnippet: "Mark a spec as met/not-met with evidence",
    parameters: Type.Object({
      id: Type.String({
        description: "The spec ID to update (e.g., 'spc-1752-48391')",
      }),
      status: StringEnum(["met", "not-met", "partial", "in-progress", "obsolete"] as const, {
        description:
          "Status: 'met' (verified and passes), 'not-met' (verified and fails), " +
          "'partial' (unverifiable — needs user confirmation), 'in-progress' (working on it), " +
          "'obsolete' (superseded by a new requirement).",
      }),
      evidence: Type.Optional(
        Type.String({
          description:
            "Concrete evidence for terminal statuses (met/not-met): test output, build result, code inspection. " +
            "Required for met/not-met. For partial, explain why it's unverifiable.",
        }),
      ),
      note: Type.Optional(
        Type.String({
          description:
            "Optional note (e.g., 'needs user confirmation for unverifiable spec')",
        }),
      ),
      trace: Type.Optional(
        Type.Object({
          outcome: Type.String({
            description:
              "Operator-facing observable outcome this spec delivers (e.g. \"ingested report has an agent_title on the card\").",
          }),
          codePath: Type.String({
            description:
              "Concrete code path that delivers it (e.g. \"ingest → analyze() → persist → render\").",
          }),
          testFile: Type.Optional(
            Type.String({
              description:
                "Test file that asserts the outcome (required for feature/behavior specs).",
            }),
          ),
          assertion: Type.Optional(
            Type.String({
              description: "Assertion string that must appear in testFile.",
            }),
          ),
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        id: string;
        status: "met" | "not-met" | "partial" | "in-progress" | "obsolete";
        evidence?: string;
        note?: string;
        trace?: Trace;
      },
      _signal: AbortSignal,
      _onUpdate:
        | ((update: { content: { type: string; text: string }[] }) => void)
        | undefined,
      _ctx: ExtensionContext,
    ) {
      const currentFile = getCurrentTaskFile();
      const task = loadSpecTask(currentFile);

      if (!task) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Spec '${params.id}' not found. No active task or invalid spec ID.`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      let found = false;
      let oldStatus = "unknown";
      let updatedSpec: SpecItem | undefined;
      for (const [, specs] of Object.entries(task.areas)) {
        const idx = specs.findIndex((s) => s.id === params.id);
        if (idx !== -1) {
          const spec = specs[idx];
          // Prevent changing an already-obsolete spec
          if (spec.status === "obsolete") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Spec '${params.id}' is already obsolete and cannot be changed.`,
                },
              ],
              isError: true,
              details: {},
            };
          }

          oldStatus = spec.status;
          spec.status = params.status;
          if (params.evidence) {
            spec.evidence = params.evidence;
          }
          if (params.trace) {
            spec.trace = params.trace;
          }
          spec.verifiedAt = new Date().toISOString();
          found = true;
          updatedSpec = spec;
          break;
        }
      }

      if (!found) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Spec '${params.id}' not found.`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      saveSpecTask(currentFile, task);

      const resultLines: string[] = [
        `Spec '${params.id}' updated:`,
        `  Old status: ${oldStatus}`,
        `  New status: ${params.status}`,
        `  Evidence: ${params.evidence || "none"}`,
      ];
      if (params.note) {
        resultLines.push(`  Note: ${params.note}`);
      }

      // Count terminal statuses
      let metCount = 0, notMetCount = 0, partialCount = 0;
      for (const areaSpecs of Object.values(task.areas)) {
        for (const spec of areaSpecs) {
          if (spec.status === "met") metCount++;
          else if (spec.status === "not-met") notMetCount++;
          else if (spec.status === "partial") partialCount++;
        }
      }
      resultLines.push(
        `\nVerification summary: ${metCount} met, ${notMetCount} not-met, ${partialCount} partial, ${task.areas["constraints"]?.filter((s) => s.status === "open" || s.status === "in-progress").length || 0} constraints remaining.`,
      );

      // If any MUST spec is not-met or partial, warn
      for (const areaSpecs of Object.values(task.areas)) {
        for (const spec of areaSpecs) {
          if (spec.priority === "must" && (spec.status === "not-met" || spec.status === "partial")) {
            resultLines.push(
              `\n⚠️  CRITICAL: MUST spec '${spec.id}' is ${spec.status}. Continue working until it is met.`,
            );
            break;
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: resultLines.join("\n"),
          },
        ],
        details: { task, updatedSpec },
      };
    },
  });

  // ── /clear-specs command (user-only) ─────────────────────────────────
  pi.registerCommand("clear-specs", {
    description:
      "Clear all spec memory for the current task. User-only command. " +
      "Archives the current task to history and starts a fresh task.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const currentFile = getCurrentTaskFile();

      const task = loadSpecTask(currentFile);
      if (!task) {
        ctx.ui.notify("No active task to clear.", "info");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Clear Specs",
        `This will archive task '${task.taskId}' (${task.title}) and start a fresh task. Are you sure?`,
      );
      if (!confirmed) {
        ctx.ui.notify("Clear cancelled.", "info");
        return;
      }

      // Archive current task
      const archivedFile = getArchivedTaskFile(task.taskId);
      saveSpecTask(archivedFile, task);

      // Clear current task file
      const freshTaskId = generateTaskId();
      fs.writeFileSync(currentFile, JSON.stringify({
        taskId: freshTaskId,
        title: "",
        startedAt: new Date().toISOString(),
        verificationSentAt: undefined,
        areas: {},
      }, null, 2), "utf-8");

      // Sync state so rotation/injection use the fresh task
      state.currentTaskId = freshTaskId;
      state.currentTaskPath = currentFile;
      state.currentTaskTitle = "";

      ctx.ui.notify("Specs cleared. New task started.", "info");
    },
  });

  // ======================================================================
  // AUTO-CONTINUE EVENT HANDLERS
  // ======================================================================

  // ── Task boundary detection ──────────────────────────────────────────
  // A genuine user message starts a new task. Reset the task-level tool
  // call counter so the complexity gate reflects the CURRENT task, not
  // the whole session. Extension-injected messages (continuations) do NOT
  // reset the counter — they're part of the same task.
  pi.on("input", (event: { text: string; source: string }, _ctx: ExtensionContext) => {
    if (event.source === "extension") return;

    // §5.4 — a genuine user message is real progress: the length loop gets a
    // fresh budget, matching pi-safe-compact's precedent.
    noteLengthProgress();

    state.taskToolCallCount = 0;

    // A genuine user message starts a NEW task, so the previous task's
    // verification must not suppress this one. Without this reset the
    // 15-minute cooldown is session-wide and only the first task of a
    // session ever gets verified.
    state.lastVerificationTime = 0;
    state.continuationSinceLastVerification = false;

    // ── Spec-memory task rotation ─────────────────────────────────────
    // Rotate to a fresh task if: verification already ran (verificationSentAt set)
    // AND no MUST spec is open/in-progress. User refines after verification → new task.
    // User keeps clarifying mid-task → same task accumulates specs.
    // File-based (not state-based) so it works even on a fresh session where
    // agent_start hasn't populated state yet.
    if (config.specMemoryIntegration) {
      const currentFile = getCurrentTaskFile();
      const task = loadSpecTask(currentFile);
      if (task && task.verificationSentAt) {
        // Check if any MUST spec is still open/in-progress
        let hasOpenMust = false;
        for (const areaSpecs of Object.values(task.areas)) {
          for (const spec of areaSpecs) {
            if (spec.priority === "must" && (spec.status === "open" || spec.status === "in-progress")) {
              hasOpenMust = true;
              break;
            }
          }
        }
        if (!hasOpenMust) {
          // Archive current task and start fresh
          const archivedFile = getArchivedTaskFile(task.taskId);
          saveSpecTask(archivedFile, task);
          state.currentTaskId = generateTaskId();
          state.currentTaskPath = getCurrentTaskFile();
          state.currentTaskTitle = "New task";
          saveSpecTask(state.currentTaskPath, {
            taskId: state.currentTaskId,
            title: "New task",
            startedAt: new Date().toISOString(),
            verificationSentAt: undefined,
            areas: {},
          });
        }
      }
    }
  });

  // Reset guards at the start of each agent run so a later run can
  // enqueue its own continuation.
  pi.on("agent_start", () => {
    // §5.4 — `state.lengthQueued` is no longer cleared unconditionally here.
    // The per-stop guard is re-armed only while the length streak still has
    // budget; once `lengthContinuationsQueued` reaches its limit the guard
    // stays armed, so no further continuation can be queued even if some other
    // path would try. The streak counters themselves are NOT touched here —
    // they are the loop bound and must survive run boundaries.
    if (
      state.lengthContinuationsQueued <
      config.lengthContinuationMaxConsecutive
    ) {
      state.lengthQueued = false;
    }
    state.compactionQueued = false;
    state.prematureQueued = false;
    state.lastRunToolCallCount = 0;
    state.lastResponseConclusive = true;
    // lastVerificationTime and continuationSinceLastVerification are NOT
    // reset here — they persist across runs within the same session.

    // ── Spec-memory state initialization ─────────────────────────────
    if (config.specMemoryIntegration) {
      const currentFile = getCurrentTaskFile();
      const task = loadSpecTask(currentFile);
      if (task) {
        state.currentTaskId = task.taskId;
        state.currentTaskPath = currentFile;
        state.currentTaskTitle = task.title;
      }
    }
  });

  /**
   * Record a failed turn and decide whether to queue a continuation for it.
   *
   * Returns false when the continuation should be skipped, either because Pi's
   * own retry layer is still working on it or because this failure streak has
   * already produced its budget of continuations.
   *
   * `assistant` is undefined when the provider produced no message at all.
   */
  function shouldQueueFailureContinuation(
    assistant: AssistantMessage | undefined,
  ): boolean {
    state.consecutiveFailures++;

    // Layer 1 — leave the first N retryable failures to Pi's retry machinery.
    // Extensions don't receive `willRetry` on agent_end, so the host's budget is
    // mirrored rather than observed: defer while within it, then step in.
    const hostMayStillRetry =
      assistant !== undefined &&
      isRetryableAssistantError(assistant) &&
      state.consecutiveFailures <= config.hostRetryBudget;
    if (hostMayStillRetry) return false;

    // Layer 2 — circuit breaker. Bound the cost of a long outage to a constant.
    if (
      state.failureContinuationsQueued >=
      config.maxConsecutiveFailureContinuations
    ) {
      return false;
    }

    state.failureContinuationsQueued++;
    return true;
  }

  /**
   * §5.4 — real progress on the output-length path.
   *
   * Clears the length-loop counters and re-arms `lengthQueued`. Called only for
   * turns that genuinely moved forward (a non-length stop, or a new user
   * message) — never for a length stop, which is exactly the case the loop is
   * made of.
   */
  function noteLengthProgress(): void {
    state.lengthContinuationsQueued = 0;
    state.starvedLengthStreak = 0;
    state.contextPressureCompactionsQueued = 0;
    state.lengthQueued = false;
  }

  /**
   * A compaction produced a fresh window.
   *
   * The length budget restarts — the context is small again — but the
   * context-pressure compaction budget deliberately survives: that counter is
   * the one that stops a compact → starve → compact loop (§5.5 step 1a). If a
   * successful compaction reset it, every compaction would re-arm its own cap
   * and the loop would never end.
   */
  function noteFreshWindow(): void {
    state.lengthContinuationsQueued = 0;
    state.starvedLengthStreak = 0;
    state.lengthQueued = false;
  }

  /**
   * A turn completed without failing. Close out any failure streak: bump the
   * epoch so continuations queued during the outage are recognised as stale,
   * and reset the streak counters.
   */
  function noteSuccessfulTurn(): void {
    if (state.consecutiveFailures > 0) {
      state.epoch++;
    }
    state.consecutiveFailures = 0;
    state.failureContinuationsQueued = 0;
  }

  // ── Single agent_end handler covering length + premature stops ───────
  pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
    const assistant = lastAssistantMessage(event.messages);

    // ── Case 0: No assistant message at all (provider aborted mid-generation) ──
    // The model started generating but stopped without producing any output.
    // This is a provider-side failure — send a continuation to retry.
    if (!assistant) {
      if (ctx.hasPendingMessages()) return;
      state.lastResponseConclusive = false;
      if (!shouldQueueFailureContinuation(undefined)) return;
      state.continuationSinceLastVerification = true;
      try {
        pi.sendMessage(
          {
            customType: "auto-continue-abort",
            content: `Your previous response was interrupted before it could produce any output. This appears to be a transient provider issue. Please re-read the user's last message and respond again from scratch. Do not repeat completed work from earlier turns.`,
            display: false,
            details: {
              kind: "provider_abort_continuation",
              epoch: state.epoch,
              runId: RUN_ID,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch {
        // Agent may be in a state that rejects messages
      }
      return;
    }

    // A turn that produced a message and did not error ends any failure streak
    // and retires the continuations queued during it. Length/premature stops are
    // incomplete responses, not failed calls, so they count as progress here.
    // §5.7 (decided): this stays true for starved length stops too. Failure and
    // length are separate concerns — the provider answered successfully, so the
    // turn is not a failure. In a pure length loop `consecutiveFailures` is 0,
    // so no epoch bump happens and no continuation is retired by this call.
    if (assistant.stopReason !== "error") {
      noteSuccessfulTurn();
    }

    // §5.4 — a turn that did not stop on the output limit is real progress on
    // the length path: reset the loop counters so the next length stop starts
    // from a fresh budget. A length stop is handled in Case 1 below.
    if (assistant.stopReason !== "length") {
      noteLengthProgress();
    }

    // If the user or another extension already queued work, don't duplicate.
    if (ctx.hasPendingMessages()) return;

    // Track tool call count for complexity detection
    state.lastRunToolCallCount = countToolCalls(assistant.content);
    state.taskToolCallCount += state.lastRunToolCallCount;
    state.sessionTotalToolCalls += state.lastRunToolCallCount;

    // ── Case 1: Output-length stop ──────────────────────────────────
    // The per-stop guard (`lengthQueued`) is applied at the queueing step
    // below, not here: the context-pressure and circuit-breaker checks must
    // still run for every length stop, otherwise the pause would be silent.
    if (
      config.lengthStopContinuation &&
      assistant.stopReason === "length"
    ) {
      // Pi core owns genuine context-overflow recovery (abort + compact + retry).
      if (isContextOverflow(assistant, ctx.model?.contextWindow)) return;

      const usage = assistant.usage;
      const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      const contextWindow = ctx.model?.contextWindow;
      const tinyOutput =
        usage.output <= config.lengthContinuationTinyOutputTokens;
      const contextNearlyFull =
        typeof contextWindow === "number" &&
        Number.isFinite(contextWindow) &&
        contextWindow > 0 &&
        inputTokens >= contextWindow * config.contextPressureRatio;

      // ── 1a: context-starved stop — a continuation cannot help ──────
      // Continuing appends to an already-full context, so input grows while
      // output stays tiny. This is strictly self-reinforcing: compact instead.
      if (
        config.contextPressureCompaction &&
        tinyOutput &&
        (contextNearlyFull ||
          state.starvedLengthStreak + 1 >=
            config.lengthContinuationMaxConsecutive)
      ) {
        state.starvedLengthStreak++;
        state.lastResponseConclusive = false;

        // Hard cap: never compact in a loop.
        if (
          state.contextPressureCompactionsQueued >=
          config.maxContextPressureCompactions
        ) {
          ctx.ui.notify(
            "Context remains exhausted after automatic compaction. Stopping automatic continuations; start a new session or select a larger-context model.",
            "warning",
          );
          return;
        }

        const now = Date.now();
        if (
          now - state.lastContextPressureCompactionTime <
          CONTEXT_PRESSURE_COMPACTION_COOLDOWN_MS
        ) {
          return;
        }
        state.lastContextPressureCompactionTime = now;
        state.contextPressureCompactionsQueued++;
        state.lengthQueued = true;
        state.continuationSinceLastVerification = true;

        ctx.ui.notify(
          `Context is exhausted (${inputTokens.toLocaleString()} / ${
            contextWindow?.toLocaleString() ?? "?"
          } input tokens, only ${usage.output} output tokens possible) — compacting instead of continuing.`,
          "warning",
        );
        ctx.compact({
          customInstructions:
            "The previous turn stopped because the input had consumed nearly the entire " +
            "context window, leaving no output budget (the model could only emit a token " +
            "or two). Preserve the user's most recent request verbatim and the exact state " +
            "of the in-flight work so it can be resumed immediately after this summary.",
          onError: (error) => {
            ctx.ui.notify(
              `Context-pressure compaction failed: ${error.message}`,
              "error",
            );
          },
        });
        return;
      }

      // ── 1b: circuit breaker on productive continuations ────────────
      // `agent_start` no longer clears this, so it survives run boundaries
      // and actually bounds the streak.
      if (
        state.lengthContinuationsQueued >=
        config.lengthContinuationMaxConsecutive
      ) {
        ctx.ui.notify(
          `Paused after ${state.lengthContinuationsQueued} consecutive output-length continuations. Inspect the output limit and context before continuing.`,
          "warning",
        );
        return;
      }

      // Per-stop guard: never queue a second continuation for the same stop.
      // Cleared by noteLengthProgress() on real progress and re-armed at
      // `agent_start` while the streak still has budget.
      if (state.lengthQueued) return;

      state.lengthContinuationsQueued++;
      if (tinyOutput) state.starvedLengthStreak++;
      // A productive stop is progress against starvation even though it does not
      // reset the continuation budget: the model is no longer boxed in by the
      // context, so the starvation streak ends here (§5.5).
      else state.starvedLengthStreak = 0;

      state.lengthQueued = true;
      state.lastResponseConclusive = false;
      state.continuationSinceLastVerification = true;
      try {
        pi.sendMessage(
          {
            customType: "auto-continue-length",
            content: LENGTH_CONTINUATION_PROMPT,
            display: false,
            details: {
              kind: "output_length_continuation",
              epoch: state.epoch,
              runId: RUN_ID,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch {
        // Agent may be in a state that rejects messages
      }
      return;
    }

    // ── Case 2: Premature stop (stopReason "stop" but incomplete) ───
    if (
      config.prematureStopDetection &&
      assistant.stopReason === "stop" &&
      !state.prematureQueued &&
      !state.lengthQueued &&
      isPrematureStop(assistant)
    ) {
      state.prematureQueued = true;
      state.lastResponseConclusive = false;
      state.continuationSinceLastVerification = true;
      try {
        pi.sendMessage(
          {
            customType: "auto-continue-premature",
            content: PREMATURE_STOP_PROMPT,
            display: false,
            details: {
              kind: "premature_stop_continuation",
              epoch: state.epoch,
              runId: RUN_ID,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch {
        // Agent may be in a state that rejects messages
      }
      return;
    }

    // ── Case 3: Error stop ──────────────────────────────────────────
    // The model stopped due to an error. Retry.
    if (assistant.stopReason === "error" && !state.lengthQueued && !state.prematureQueued) {
      state.lastResponseConclusive = false;
      if (!shouldQueueFailureContinuation(assistant)) return;
      state.continuationSinceLastVerification = true;
      try {
        pi.sendMessage(
          {
            customType: "auto-continue-error",
            content: `Your previous response stopped due to an error. Please re-read the user's last message and try again. Do not repeat completed work from earlier turns.`,
            display: false,
            details: {
              kind: "error_continuation",
              epoch: state.epoch,
              runId: RUN_ID,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch {
        // Agent may be in a state that rejects messages
      }
      return;
    }

    // If we get here, the response was conclusive (normal stop with complete text).
    state.lastResponseConclusive = true;
  });

  // ── Stale-continuation filter ─────────────────────────────────────
  // Fires before every LLM call and may rewrite the message list. Continuations
  // queued during an outage are ordinary context messages (custom → user role)
  // that outlive the interruption they describe, so after recovery the model
  // reads several standing instructions to resume work that is already done.
  // Drop the ones stamped with a superseded epoch.
  //
  // This only filters the LLM's view. The session transcript keeps every entry,
  // so nothing is destroyed and the change is reversible by config.
  pi.on("context", (event: { messages: AgentMessage[] }) => {
    if (!config.staleContinuationFiltering) return;

    const kept = event.messages.filter(
      (message) => !isStaleContinuation(message, state.epoch),
    );
    if (kept.length === event.messages.length) return; // nothing to do
    return { messages: kept };
  });

  // ── Post-compaction continuation ──────────────────────────────────────
  pi.on(
    "session_compact",
    (event: SessionCompactEvent, ctx: ExtensionContext) => {
      // §5.4 — a fresh window deserves a fresh length budget. This resets the
      // length counters only; the context-pressure compaction budget survives
      // so the compaction cap can actually stop a compact → starve → compact
      // loop. Placed before the config gate so the reset always happens.
      noteFreshWindow();

      if (!config.compactionContinuation) return;

      // Manual /compact is user-requested maintenance — stay idle.
      // Overflow recovery already has a precise host retry path (willRetry=true).
      if (
        event.reason === "manual" ||
        event.willRetry ||
        state.compactionQueued ||
        state.lengthQueued
      )
        return;

      // Auto-compaction can also happen before a newly submitted user prompt.
      // In that pre-prompt path the session is idle and the user's prompt will
      // start the next run itself — injecting another continuation would duplicate work.
      if (ctx.isIdle()) return;

      // If another extension or the user already queued work while compaction
      // was in flight, Pi will resume it itself.
      if (ctx.hasPendingMessages()) return;

      // Don't continue if the last response was conclusive (task appeared complete).
      // This prevents unnecessary continuation after summaries, final results, etc.
      // The final verification on agent_settled will catch any missed work.
      if (state.lastResponseConclusive) return;

      // Don't continue for simple Q&A (no tool calls in the current task)
      if (state.taskToolCallCount < MIN_TOOL_CALLS_FOR_COMPLEX_TASK) return;

      state.compactionQueued = true;
      state.continuationSinceLastVerification = true;

      // Include feedback checkpoints in the compaction continuation prompt
      let prompt = COMPACTION_CONTINUATION_PROMPT;
      if (config.feedbackMemoryIntegration) {
        const checkpoints = getFeedbackCheckpoints();
        if (checkpoints) {
          prompt +=
            "\n\n" +
            "Also, review these feedback checkpoints from past user criticism:\n" +
            checkpoints;
        }
      }

      // Include spec-memory recap in the compaction continuation prompt.
      // Compaction destroys context detail — the spec tree survives in storage
      // and gets re-injected here so requirements survive context loss.
      if (config.specMemoryIntegration) {
        const currentFile = getCurrentTaskFile();
        const task = loadSpecTask(currentFile);
        if (task && Object.keys(task.areas).length > 0) {
          const specs = formatSpecTree(task);
          if (specs) {
            prompt +=
              "\n\n" +
              "Also, re-check these task specifications as you resume:\n" +
              specs;
          }
        }
      }

      try {
        pi.sendMessage(
          {
            customType: "auto-continue-compaction",
            content: prompt,
            display: false,
            details: {
              kind: "post_compaction_continuation",
              reason: event.reason,
              epoch: state.epoch,
              runId: RUN_ID,
            },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      } catch {
        // Agent may be in a state that rejects messages — silently skip
      }
    },
  );

  // ── Final verification (once per session, only for complex tasks) ────
  // After the agent fully settles with no pending retries, compactions, or
  // continuations, send a targeted check based on past feedback.
  // Only fires when the last task was non-trivial (had tool calls).
  // Simple Q&A (0 tool calls) passes through silently.
  pi.on("agent_settled", () => {
    if (!config.finalVerification) return;
    if (!state.lastResponseConclusive) return; // Already handled by other paths

    // ── Complexity gate: skip verification for simple Q&A ────────────
    // If the current task had no tool calls, it was a simple Q&A exchange.
    // Verification would be annoying and unnecessary. Using task-level
    // count (not last-run) so a complex task ending in a text summary
    // still triggers verification.
    if (state.taskToolCallCount < MIN_TOOL_CALLS_FOR_COMPLEX_TASK) return;

    const now = Date.now();
    const timeSinceLastVerification = now - state.lastVerificationTime;
    const neverSent = state.lastVerificationTime === 0;
    const cooldownExpired =
      timeSinceLastVerification >= VERIFICATION_COOLDOWN_MS;
    const hadContinuation = state.continuationSinceLastVerification;

    // Specs left "open"/"in-progress" mean a previous verification checklist
    // was never acted on. That must never be silenced by the cooldown.
    let pendingSpecs = false;
    if (config.specMemoryIntegration) {
      const pendingTask = loadSpecTask(getCurrentTaskFile());
      if (pendingTask) {
        pendingSpecs = Object.values(pendingTask.areas)
          .flat()
          .some((s) => s.status === "open" || s.status === "in-progress");
      }
    }

    // Send if: never sent, OR a continuation fired since last check,
    // OR 15+ min elapsed, OR specs are still awaiting a verdict.
    if (!neverSent && !hadContinuation && !cooldownExpired && !pendingSpecs)
      return;

    state.lastVerificationTime = now;
    state.continuationSinceLastVerification = false;

    // Build the verification prompt. The base instruction is intentionally
    // specific: verify that captured specs and feedback were actually
    // implemented/addressed as requested — not a vague "are you done" check.
    // Concrete specifics (the real spec tree, the real feedback checkpoints)
    // are appended below whenever they exist, so the agent verifies against
    // actual requirements instead of its own memory of the conversation.
    let prompt =
      "Verify that everything you were asked to do has actually been implemented as requested — " +
      "not just attempted or assumed. Check the captured task specifications and past feedback " +
      "checkpoints below (if any) against the real deliverable. If everything is verified complete, " +
      "state this clearly with full responsibility, re-iterating what was verified. If anything is " +
      "missing, unmet, or unaddressed, continue working until it is.";

    // Spec-memory verification checklist
    if (config.specMemoryIntegration) {
      const currentFile = getCurrentTaskFile();
      const task = loadSpecTask(currentFile);
      if (task && Object.keys(task.areas).length > 0) {
        const specs = formatSpecTree(task);
        if (specs) {
          // Are there specs the agent still has to rule on? Specs left
          // "open"/"in-progress" mean the previous verification prompt was
          // never acted on, so this verification must not be suppressed.
          const allSpecs = Object.values(task.areas).flat();
          const unresolvedMust = allSpecs.filter(
            (s) =>
              s.priority === "must" &&
              (s.status === "open" || s.status === "in-progress"),
          ).length;

          prompt +=
            "\n\n" +
            specs +
            "\nVerify EACH specification above was actually implemented as requested, against the " +
            "real deliverable (not from memory): call update_spec_status for every spec with concrete " +
            "evidence (test output, build result, code inspection, or ask the user when you cannot " +
            "verify objectively). If any MUST spec is not met, continue working until it is. " +
            "SHOULD specs: note briefly. Only declare the task complete when every MUST spec is met " +
            "or explicitly obsolete.";

          if (unresolvedMust > 0) {
            prompt +=
              `\n\n⚠️ ${unresolvedMust} MUST spec(s) still have status "open"/"in-progress". ` +
              "Do NOT declare the task complete until you have called " +
              "update_spec_status on each of them with real evidence.";
          }

          // Record that verification ran for this task (drives rotation).
          // Set unconditionally: rotation separately requires that no MUST
          // spec is still open/in-progress, so unverified specs already block
          // archiving. Gating this on resolution instead would deadlock —
          // once specs are resolved the cooldown suppresses further
          // verifications, so the flag would never be written at all.
          task.verificationSentAt = new Date().toISOString();
          saveSpecTask(currentFile, task);
        }
      }
    }

    const checkpoints = config.feedbackMemoryIntegration
      ? getFeedbackCheckpoints()
      : "";
    if (checkpoints) {
      prompt +=
        "\n\nVerify each of these past feedback issues has actually been addressed in this session's work " +
        "(not just noted) — check the specific behavior against what you actually did:\n" +
        checkpoints +
        "\nAddress each checkpoint explicitly, with concrete evidence, before declaring the task complete.";
    }

    try {
      pi.sendMessage(
        {
          customType: "auto-continue-verify",
          content: prompt,
          display: false,
          details: { kind: "final_verification" },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // Agent may be in a state that rejects messages
    }
  });
}
