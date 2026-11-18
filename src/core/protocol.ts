export type ApprovalMode = "plan" | "auto-edit" | "full-auto";
export type TodoItem = { id: string; content: string; status: "pending" | "in_progress" | "completed" };
export type ThreadRecord = { threadId: string; title: string; model: string; approvalMode: ApprovalMode; autoCompact: boolean; createdAt: number; updatedAt: number };
export type TimelineToolEntry = { callId: string; name: string; status: string; rawInput?: unknown; rawOutput?: unknown };
export type TimelineItem = {
  id: string; threadId: string; kind: "turn" | "rotation" | "compact" | "command";
  userText?: string; assistantText?: string; thoughtText?: string; tools?: TimelineToolEntry[];
  title?: string; output?: string; ok?: boolean; error?: string; aborted?: boolean;
  epoch: number; reason?: string; beforeTokens?: number; afterTokens?: number; summary?: string; createdAt: number;
};
export type FsReadInput = { path: string; startLine?: number; endLine?: number };
export type TodoWriteInput = { todos: TodoItem[] };

export function inferContextWindow(modelId: string): number {
  if (/^gemini-/i.test(modelId)) return 1_000_000;
  if (/^claude-/i.test(modelId)) return 200_000;
  if (/^gpt-/i.test(modelId)) return 128_000;
  return LIMITS.DEFAULT_CONTEXT_WINDOW;
}

export type SessionRole = "writer" | "readonly";

export interface SessionIdentity {
  sessionId: string;
  role: SessionRole;
  epoch: number;
  depth: number;
  parentSessionId?: string;
  agentId?: string;
  taskPath?: string;
}

export interface ObservedFileRecord {
  sessionId: string;
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeNs: string;
  sha256: string;
  observedAt: number;
}

export interface SpillResult {
  inlineText: string;
  truncated: boolean;
  totalBytes: number;
  outputRef?: string;
  sha256?: string;
}

export interface SpillOptions {
  sessionId?: string;
  epoch?: number;
  kind?: "bash" | "read" | "grep" | "agent" | "workflow" | "other";
  isError?: boolean;
  exitCode?: number | null;
  commandOrPath?: string;
  durationMs?: number;
  protectedRefs?: Iterable<string>;
}

export interface FsGlobInput {
  pattern: string;
  path?: string;
  limit?: number;
}

export interface FsGrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  mode?: "files" | "content" | "count";
  context?: number;
  limit?: number;
}

export interface PatchHunk {
  oldText: string;
  newText: string;
  startLine?: number;
  endLine?: number;
}

export interface FsPatchInput {
  path: string;
  op: "patch" | "create" | "write" | "delete";
  hunks?: PatchHunk[];
  content?: string;
  startLine?: number;
  endLine?: number;
}

export interface BashInput {
  action?: "exec" | "stdin" | "poll" | "kill";
  jobId?: string;
  command?: string;
  input?: string;
  cwd?: string;
  yieldMs?: number;
  timeoutMs?: number;
  background?: boolean;
}

export type SubagentToolName =
  | "fs_read"
  | "fs_glob"
  | "fs_grep"
  | "fs_patch"
  | "bash"
  | "agent_message"
  | "todo_write";

export const ALL_SUBAGENT_TOOLS: readonly SubagentToolName[] = [
  "fs_read",
  "fs_glob",
  "fs_grep",
  "fs_patch",
  "bash",
  "agent_message",
  "todo_write",
] as const;

export const DEFAULT_SUBAGENT_TOOLS: readonly SubagentToolName[] = [
  "fs_read",
  "fs_glob",
  "fs_grep",
] as const;

export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type CanonicalEffort = "low" | "medium" | "high" | "xhigh";
export type SubagentRole = "explorer" | "worker" | "verifier";
export type AgentRole = SubagentRole | (string & {});

const MODEL_FAMILY_ALIASES: Record<string, { base: string; maxEffort: CanonicalEffort | null }> = {
  hydrogen: { base: "gemini-4-hydrogen", maxEffort: "xhigh" },
  "gemini-4-hydrogen": { base: "gemini-4-hydrogen", maxEffort: "xhigh" },
  carbon: { base: "gemini-4-carbon", maxEffort: "high" },
  "gemini-4-carbon": { base: "gemini-4-carbon", maxEffort: "high" },
  argon: { base: "gemini-4-argon", maxEffort: "high" },
  "gemini-4-argon": { base: "gemini-4-argon", maxEffort: "high" },
  flash: { base: "gemini-3.8-flash", maxEffort: "high" },
  "gemini-3.8-flash": { base: "gemini-3.8-flash", maxEffort: "high" },
  opus: { base: "claude-opus-5-5", maxEffort: "high" },
  "claude-opus": { base: "claude-opus-5-5", maxEffort: "high" },
  "claude-opus-5-5": { base: "claude-opus-5-5", maxEffort: "high" },
  sonnet: { base: "claude-sonnet-5-5", maxEffort: "high" },
  "claude-sonnet": { base: "claude-sonnet-5-5", maxEffort: "high" },
  "claude-sonnet-5-5": { base: "claude-sonnet-5-5", maxEffort: "high" },
  orchestrator: { base: "gemini-pro-orchestrator", maxEffort: null },
  "orchestrator-carbon": { base: "gemini-pro-orchestrator", maxEffort: null },
  "gemini-pro-orchestrator": { base: "gemini-pro-orchestrator", maxEffort: null },
  "orchestrator-argon": { base: "gemini-pro-orchestrator-argon", maxEffort: null },
  "gemini-pro-orchestrator-argon": { base: "gemini-pro-orchestrator-argon", maxEffort: null },
  "gpt-oss": { base: "gpt-oss-120b-medium", maxEffort: null },
  "gpt-oss-120b": { base: "gpt-oss-120b-medium", maxEffort: null },
  "gpt-oss-120b-medium": { base: "gpt-oss-120b-medium", maxEffort: null },
};

export function normalizeThinkingEffort(raw?: string): CanonicalEffort | undefined {
  if (!raw) return undefined;
  const clean = raw.trim().toLowerCase();
  if (clean === "max" || clean === "xhigh") return "xhigh";
  if (clean === "low" || clean === "medium" || clean === "high") return clean;
  return undefined;
}

export function extractEffortFromModelId(modelId: string): { base: string; effort?: CanonicalEffort } {
  const match = /^(.+)-(low|medium|high|xhigh)$/i.exec(modelId.trim());
  if (!match) return { base: modelId.trim() };
  return { base: match[1], effort: match[2].toLowerCase() as CanonicalEffort };
}

export function resolveModelAndEffort(options?: {
  model?: string;
  effort?: string;
  parentModel?: string;
  defaultModelName?: string;
  defaultEffort?: CanonicalEffort;
}): { modelId: string; effort: CanonicalEffort } {
  const defaultModelName = options?.defaultModelName ?? LIMITS.DEFAULT_SUBAGENT_MODEL_NAME;
  const defaultEffort = options?.defaultEffort ?? LIMITS.DEFAULT_SUBAGENT_EFFORT;
  const explicitEffort = normalizeThinkingEffort(options?.effort);
  if (options?.effort !== undefined && options.effort.trim() !== "" && !explicitEffort) {
    throw new Error(`Invalid thinking effort "${options.effort}" (expected low | medium | high | xhigh | max)`);
  }

  const rawModel = options?.model?.trim();
  const baseInput = !rawModel
    ? defaultModelName
    : rawModel.toLowerCase() === "inherit"
      ? (options?.parentModel?.trim() || LIMITS.DEFAULT_SUBAGENT_MODEL)
      : rawModel;

  const { base: strippedBase, effort: embeddedEffort } = extractEffortFromModelId(baseInput);
  const desiredEffort: CanonicalEffort = explicitEffort ?? embeddedEffort ?? defaultEffort;

  const exactAlias = MODEL_FAMILY_ALIASES[baseInput.toLowerCase()];
  if (exactAlias && exactAlias.maxEffort === null) {
    const fixedEffort = extractEffortFromModelId(exactAlias.base).effort ?? desiredEffort;
    return { modelId: exactAlias.base, effort: fixedEffort };
  }

  const familyAlias = exactAlias ?? MODEL_FAMILY_ALIASES[strippedBase.toLowerCase()];
  if (familyAlias) {
    if (familyAlias.maxEffort === null) {
      const fixedEffort = extractEffortFromModelId(familyAlias.base).effort ?? desiredEffort;
      return { modelId: familyAlias.base, effort: fixedEffort };
    }
    const clampedEffort: CanonicalEffort =
      desiredEffort === "xhigh" && familyAlias.maxEffort !== "xhigh"
        ? familyAlias.maxEffort
        : desiredEffort;
    return { modelId: `${familyAlias.base}-${clampedEffort}`, effort: clampedEffort };
  }

  // Unknown or future model family: apply suffix if explicit effort or embedded effort exists, or if gemini/claude family.
  if (embeddedEffort || explicitEffort) {
    return { modelId: `${strippedBase}-${desiredEffort}`, effort: desiredEffort };
  }
  if (/^(gemini-|claude-)/i.test(strippedBase) && !/thinking$/i.test(strippedBase)) {
    return { modelId: `${strippedBase}-${desiredEffort}`, effort: desiredEffort };
  }
  return { modelId: baseInput, effort: desiredEffort };
}

export interface ContextPacket {
  objective: string;
  relevantFiles?: string[];
  writeScope?: string[];
  knownFacts?: string[];
  constraints?: string[];
  outputContract?: string;
}

export interface AgentTaskSpec {
  taskName?: string;
  role?: AgentRole;
  model?: string;
  effort?: ThinkingEffort;
  tools?: SubagentToolName[];
  disableAgentMessage?: boolean;
  enableAgentMessage?: boolean;
  forkTurns?: "none" | "all";
  includeParentContext?: boolean;
  worktree?: boolean;
  prompt?: string;
  objective?: string;
  relevantFiles?: string[];
  writeScope?: string[];
  knownFacts?: string[];
  constraints?: string[];
  outputContract?: string;
  reuseKey?: string;
}

export type AgentDispatchAction =
  | "spawn"
  | "dispatch"
  | "followup"
  | "send"
  | "send_input"
  | "resume"
  | "send_message"
  | "broadcast"
  | "wait"
  | "interrupt"
  | "close"
  | "list"
  | "status";

export interface AgentDispatchInput {
  action?: AgentDispatchAction;
  agentId?: string;
  target?: string;
  to?: string | string[];
  agentIds?: string[];
  taskName?: string;
  role?: AgentRole;
  model?: string;
  effort?: ThinkingEffort;
  tools?: SubagentToolName[];
  disableAgentMessage?: boolean;
  enableAgentMessage?: boolean;
  writeScope?: string[];
  forkTurns?: "none" | "all";
  includeParentContext?: boolean;
  worktree?: boolean;
  reuseKey?: string;
  packet?: ContextPacket;
  tasks?: AgentTaskSpec[];
  prompt?: string;
  message?: string;
  interrupt?: boolean;
  waitAll?: boolean;
  wake?: "never" | "next_turn";
  wait?: boolean;
  timeoutMs?: number;
}

export interface AgentMessageInput {
  action?: "send" | "broadcast" | "read";
  to?: string | string[];
  message?: string;
}

export interface AgentWaitInput {
  afterSeq?: number;
  agentIds?: string[];
  waitAll?: boolean;
  timeoutMs?: number;
  callerPath?: string;
  rootId?: string;
}

export interface WorkflowRunInput {
  action?: "run" | "status" | "cancel";
  code?: string;
  runId?: string;
  timeoutMs?: number;
}

export interface HookCommonInput {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  lastUserInput?: string;
  hookEventName: string;
  cwd?: string;
  stepIdx?: number;
  invocationNum?: number;
  initialNumSteps?: number;
  executionNum?: number;
  terminationReason?: string;
  continuationActive?: boolean;
  error?: string;
  toolCall?: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
}

export interface PreToolUseOutput {
  decision: "allow" | "deny" | "ask" | "force_ask";
  reason?: string;
  overwrite?: Record<string, unknown>;
}

export interface PreInvocationOutput {
  injectSteps?: Array<
    | { systemMessage: { systemMessage: string; metadata?: Record<string, unknown> } }
    | { userMessage: string }
    | { errorMessage: { userMessage: string } }
  >;
  terminationBehavior?: "" | "terminate" | "force_continue";
}

export interface StopHookOutput {
  decision?: "continue" | string;
  reason?: string;
}

export interface HandoffPacket {
  epoch: number;
  createdAt: number;
  spineCard?: string;
  mechanical: {
    projectRoot: string;
    activePtyJobs: Array<{ jobId: string; command: string; cwd: string; alive: boolean }>;
    modifiedFiles: string[];
    activeSubagents: Array<{ agentId: string; status: string; reuseKey?: string }>;
    activeWorkflows: Array<{ runId: string; status: string }>;
  };
  semantic: {
    recentContext?: string;
    recentTurns?: Array<{ user: string; assistant: string }>;
    activeGoal?: string;
    verifiedFacts: string[];
    deadEndsTried: string[];
    nextImmediateStep?: string;
    assistantDecisions?: string[];
    recentFailures?: string[];
    shadowRefs?: string[];
  };
}

export const LIMITS = {
  TOOL_INLINE_BYTES: 32 * 1024,
  FS_READ_INLINE_BYTES: 64 * 1024,
  FS_READ_MAX_LINE_CHARS: 4_096,
  SPINE_SUCCESS_FOLD_BYTES: 24 * 1024,
  SPINE_KEEP_BUDGET_CHARS: 8_000,
  SPINE_TOOL_BUDGET_CHARS: 2_400,
  MAX_SHADOW_BYTES: 256 * 1024 * 1024,
  WORKFLOW_INLINE_BYTES: 8 * 1024,
  AGENT_SUMMARY_CHARS: 4000,
  PTY_RING_BUFFER_BYTES: 10 * 1024 * 1024,
  DEFAULT_YIELD_MS: 90_000,
  MAX_YIELD_MS: 150_000,
  DEFAULT_SUBAGENT_MODEL_NAME: "hydrogen",
  DEFAULT_SUBAGENT_EFFORT: "high" as const,
  DEFAULT_SUBAGENT_MODEL: "gemini-4-hydrogen-high",
  MAX_AGENT_DEPTH: 1,
  MAX_CONCURRENT_AGY_TURNS: 4,
  MAX_CONCURRENT_EXPLORERS: 4,
  MAX_IDLE_SUBAGENTS: 16,
  MAX_WARM_IDLE_SUBAGENTS: 2,
  SUBAGENT_IDLE_TTL_MS: 90_000,
  DEFAULT_WAIT_TIMEOUT_MS: 90_000,
  REUSE_IDLE_TTL_MS: 240_000,
  REUSE_MAX_INPUT_TOKENS: 45_000,
  DEFAULT_CONTEXT_WINDOW: 200_000,
  ACTIVE_COMPACT_TOKENS: 300_000,
  HARD_COMPACT_TOKENS: 340_000,
  EMERGENCY_COMPACT_TOKENS: 450_000,
  PREDICTIVE_MAX_TURN_GROWTH_CAP: 80_000,
  SOFT_COMPACT_RATIO: 0.78,
  HARD_COMPACT_RATIO: 0.92,
  EMERGENCY_ABORT_RATIO: 0.98,
  CHARS_PER_TOKEN_ESTIMATE: 4,
  COMPACT_RECENT_TURNS: 4,
  COMPACT_MAX_DIGEST_CHARS: 8_000,
} as const;

export type DaemonMethod =
  | "session.register"
  | "hook.preToolUse"
  | "hook.postToolUse"
  | "hook.preInvocation"
  | "hook.stop"
  | "tool.fsRead"
  | "tool.todoWrite"
  | "tool.fsGlob"
  | "tool.fsGrep"
  | "tool.fsPatch"
  | "tool.bash"
  | "tool.agentDispatch"
  | "tool.agentMessage"
  | "tool.agentWait"
  | "tool.workflowRun"
  | "handover.updateCheckpoint"
  | "handover.trigger"
  | "runtime.status";

export interface DaemonRequest<T = unknown> {
  id: string;
  method: DaemonMethod;
  identity: Partial<SessionIdentity> & { conversationId?: string };
  params: T;
}

export interface DaemonResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: {
    code:
      | "STALE_EPOCH"
      | "NO_WRITE_LEASE"
      | "OBSERVATION_REQUIRED"
      | "OBSERVATION_STALE"
      | "MATCH_ERROR"
      | "DEPTH_EXCEEDED"
      | "PERMISSION_DENIED"
      | "TIMEOUT"
      | "INVALID_INPUT"
      | "INTERNAL";
    message: string;
  };
}
