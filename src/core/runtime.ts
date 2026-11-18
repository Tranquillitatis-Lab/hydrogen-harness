import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpSessionAdapter } from "../adapters/acp.js";
import type { ManagedSessionHandle, PromptTurnResult, SessionAdapter, SessionEvent, SessionOpenOptions, SessionUsage } from "../adapters/session.js";
import { AgentManager, formatMailboxNotification, mainAgyTurns, type SubagentOpenMeta } from "./agents.js";
import { fsRead, fsGlob, fsGrep, fsPatch } from "./files.js";
import { HandoverManager } from "./handover.js";
import { spillOutput, type OutputSpill } from "./output.js";
import { ToolPolicy } from "./policy.js";
import { ProcessManager } from "./process.js";
import { LIMITS, inferContextWindow } from "./protocol.js";
import type { ApprovalMode, ThreadRecord, TimelineItem, FsReadInput, TodoWriteInput, AgentDispatchInput, AgentMessageInput, AgentWaitInput, BashInput, DaemonRequest, DaemonResponse, FsGlobInput,
  FsGrepInput, FsPatchInput, HandoffPacket, HookCommonInput, SessionIdentity, SpillOptions, WorkflowRunInput } from "./protocol.js";
import { HydrogenError, StateStore, type SessionRecord } from "./state.js";
import { WorkflowManager } from "./workflow.js";

export function daemonAddress(projectRoot: string): string {
  const root = resolve(projectRoot);
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 12);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\hy_${hash}`;
  }
  const local = join(root, ".hydrogen/run/daemon.sock");
  return Buffer.byteLength(local) >= 96
    ? `/tmp/hy_${hash}.sock` : local;
}

type PermissionOutcome = { approved: boolean; scope?: "once" | "session"; reason?: string };
type PendingPermission = {
  requestId: string; sessionId: string; toolName: string; title?: string; rawInput?: unknown;
  createdAt: number; resolve: (outcome: PermissionOutcome) => void;
};

interface Managed {
  identity: SessionIdentity;
  handle: ManagedSessionHandle;
  busy: boolean;
}

export class HydrogenRuntime {
  readonly state: StateStore;
  readonly processes: ProcessManager;
  readonly policy: ToolPolicy;
  readonly handover: HandoverManager;
  readonly agents: AgentManager;
  readonly workflows: WorkflowManager;
  readonly projectRoot: string;
  readonly daemonAddr: string;
  private readonly managed = new Map<string, Managed>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly rotations = new Map<string, Promise<string>>();
  private closing = false;
  approvalMode: ApprovalMode = "auto-edit";
  autoCompact = true;
  autoApproveOnNoUi = false;
  activeThreadId = "";
  private activeTurnOnEvent?: (event: SessionEvent) => void;
  private activeTurnSignal?: AbortSignal;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly approvedShellCalls = new Set<string>();
  private readonly compacting = new Set<string>();
  private readonly injectedNativeSessions = new Set<string>();
  private readonly lastCompactedTokenSnapshot = new Map<string, number>();
  private readonly lastRawTranscriptTokens = new Map<string, number>();
  private readonly worktreePolicies = new Map<string, ToolPolicy>();
  private readonly spill: OutputSpill;
  private pendingNativeHandover = false;
  private pendingNativePacket?: HandoffPacket;
  private pendingNativeSpineCard?: string;
  private pendingAcpHandoverCard?: string;
  private lastTranscriptPath?: string;
  private lastUserInput?: string;
  private compactRequested = false;
  private agent: string;
  onNativeRotate?: (info: { sessionId: string; beforeTokens: number; epoch: number }) => void;

  constructor(projectRoot: string, private model = "gemini-4-hydrogen-high",
    private readonly adapter: SessionAdapter = new AcpSessionAdapter(),
    agent?: string) {
    this.projectRoot = resolve(projectRoot);
    this.daemonAddr = daemonAddress(this.projectRoot);
    this.state = new StateStore(this.projectRoot);
    this.spill = (label: string, text: string, maxBytes: number, options?: SpillOptions) =>
      spillOutput(this.projectRoot, label, text, maxBytes, options);
    this.processes = new ProcessManager(this.projectRoot, this.state, this.spill);
    this.policy = new ToolPolicy(this.projectRoot, this.state);
    this.handover = new HandoverManager(this.state);
    this.agents = new AgentManager(
      this.state,
      adapter,
      (identity: SessionIdentity, meta?: SubagentOpenMeta) =>
        this.sessionOptions(identity, undefined, meta?.model, meta),
      this.policy,
      parentSessionId => {
        this.handover.updateCheckpoint({ recentTurns: this.recentTurns() });
        return this.handover.packet({
          sessionId: parentSessionId,
          transcriptPath: this.lastTranscriptPath,
          lastUserInput: this.lastUserInput,
        }).spineCard;
      },
      () => this.model,
      sessionId => this.killSessionPtyJobs(sessionId),
    );
    this.workflows = new WorkflowManager(this.state, this.agents, (id, input, signal) => this.executeBash(id, input, signal));
    this.activeThreadId = this.state.getMeta("active_thread_id") ?? "";
    const thread = this.state.getThread(this.activeThreadId);
    this.approvalMode = thread?.approvalMode ?? (this.state.getMeta("approval_mode") as ApprovalMode | undefined) ?? "auto-edit";
    this.autoCompact = thread?.autoCompact ?? (this.state.getMeta("auto_compact") !== "false");
    const defaultShell = existsSync(join(homedir(), ".gemini/config/agents/hgy-shell.md")) ? "hgy-shell" : "";
    this.agent = agent !== undefined ? agent : (this.state.getMeta("agent") ?? defaultShell);
    if (thread) this.model = thread.model;
    if (this.activeThreadId) this.restorePendingNativeHandover(this.activeThreadId);
    this.policy.setApprovalMode(this.approvalMode);
  }

  ensureThread(): ThreadRecord {
    const existing = this.state.getThread(this.activeThreadId);
    if (existing) return existing;
    const now = Date.now();
    const thread: ThreadRecord = { threadId: randomUUID(), title: "New thread", model: this.model,
      approvalMode: this.approvalMode, autoCompact: this.autoCompact, createdAt: now, updatedAt: now };
    this.state.upsertThread(thread);
    this.activeThreadId = thread.threadId;
    this.state.setMeta("active_thread_id", thread.threadId);
    return thread;
  }

  private saveThread(): void {
    const thread = this.ensureThread();
    this.state.upsertThread({ ...thread, model: this.model, approvalMode: this.approvalMode,
      autoCompact: this.autoCompact, updatedAt: Date.now() });
  }

  listThreads(): ThreadRecord[] { return this.state.listThreads(); }

  private bindThreadSession(sessionId: string, conversationId?: string | null, threadId = this.activeThreadId): void {
    const existing = sessionId ? this.state.getSession(sessionId) : undefined;
    if (existing && (existing.role !== "writer" || existing.depth !== 0)) return;
    const convId = conversationId?.trim();
    let effectiveThreadId = threadId || this.ensureThread().threadId;
    if (convId) {
      const boundThread = this.listThreads().find(
        t => this.state.getMeta(`thread_conversation:${t.threadId}`) === convId,
      );
      if (boundThread && boundThread.threadId !== effectiveThreadId) {
        if (this.activeThreadId && this.activeThreadId !== boundThread.threadId) {
          const prevCp = this.handover.updateCheckpoint({ recentTurns: this.recentTurns() });
          this.state.setMeta(`thread_checkpoint:${this.activeThreadId}`, JSON.stringify(prevCp));
        }
        effectiveThreadId = boundThread.threadId;
        this.activeThreadId = effectiveThreadId;
        this.state.setMeta("active_thread_id", effectiveThreadId);
        const savedCp = this.state.getMeta(`thread_checkpoint:${effectiveThreadId}`);
        if (savedCp) {
          try { this.state.setCheckpoint(JSON.parse(savedCp)); } catch { /* Ignore corrupt checkpoint. */ }
        }
      }
      if (sessionId) {
        const priorSessions = this.state.listSessions().filter(
          s => s.conversationId === convId && s.sessionId !== sessionId && s.depth === 0,
        );
        for (const prior of priorSessions) {
          this.state.migrateSessionResources(prior.sessionId, sessionId);
        }
      }
    }
    if (sessionId) {
      this.state.setMeta(`thread_session:${effectiveThreadId}`, sessionId);
      this.state.setMeta("last_writer_session_id", sessionId);
    }
    if (convId) {
      this.state.setMeta(`thread_conversation:${effectiveThreadId}`, convId);
      this.state.setMeta("last_conversation_id", convId);
      if (existing && existing.conversationId !== convId) {
        this.state.registerSession({ ...existing, conversationId: convId, reuseKey: existing.reuseKey ?? undefined });
      }
    }
  }

  private restorePendingNativeHandover(threadId: string): void {
    const raw = this.state.getMeta(`pending_native_handover:${threadId}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { sessionId?: string; spineCard?: string };
        this.pendingNativeHandover = true;
        this.pendingNativePacket = undefined;
        this.pendingNativeSpineCard = parsed.spineCard || undefined;
        return;
      } catch {
        this.state.setMeta(`pending_native_handover:${threadId}`, "");
      }
    }
    const pendingAcp = this.state.getMeta(`pending_acp_handover:${threadId}`);
    if (pendingAcp) {
      this.pendingNativeHandover = true;
      this.pendingNativePacket = undefined;
      this.pendingNativeSpineCard = pendingAcp;
    }
  }

  activateThreadForNative(threadId: string): ThreadRecord {
    const thread = this.state.getThread(threadId);
    if (!thread) throw new HydrogenError("INVALID_INPUT", "Unknown thread");
    this.activeThreadId = threadId;
    this.state.setMeta("active_thread_id", threadId);
    this.model = thread.model;
    this.approvalMode = thread.approvalMode;
    this.policy.setApprovalMode(this.approvalMode);
    this.autoCompact = thread.autoCompact;
    const saved = this.state.getMeta(`thread_checkpoint:${threadId}`);
    if (saved) {
      try { this.state.setCheckpoint(JSON.parse(saved)); } catch { /* Keep current checkpoint if corrupt. */ }
    }
    this.pendingNativeHandover = false;
    this.pendingNativePacket = undefined;
    this.pendingNativeSpineCard = undefined;
    this.restorePendingNativeHandover(threadId);
    return thread;
  }

  resolveResumeTarget(idOrPrefix?: string): { threadId?: string; conversationId?: string; previousSessionId?: string } {
    const threads = this.listThreads();
    const sessions = this.state.listSessions();
    const writerSessions = [...sessions]
      .filter(s => s.role === "writer" && s.depth === 0)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.epoch - a.epoch);

    const resolveForThread = (threadId: string) => {
      const metaConv = this.state.getMeta(`thread_conversation:${threadId}`) || undefined;
      const metaSess = this.state.getMeta(`thread_session:${threadId}`) || undefined;
      const sessConv = metaSess ? (this.state.getSession(metaSess)?.conversationId ?? undefined) : undefined;
      let conversationId = metaConv || sessConv;
      let previousSessionId = metaSess;
      if (threads.length <= 1) {
        if (!previousSessionId) {
          previousSessionId = this.state.getMeta("last_writer_session_id")
            || this.state.writerSessionId
            || writerSessions[0]?.sessionId;
        }
        if (!conversationId) {
          const latestWithConv = writerSessions.find(s => Boolean(s.conversationId));
          conversationId = this.state.getMeta("last_conversation_id")
            || latestWithConv?.conversationId
            || undefined;
        }
      }
      return { threadId, conversationId, previousSessionId };
    };

    const query = idOrPrefix?.trim();
    if (!query) {
      if (threads.length > 0) {
        const activeId = this.activeThreadId || this.state.getMeta("active_thread_id") || "";
        const activeThread = activeId ? threads.find(t => t.threadId === activeId) : undefined;
        const recentThread = activeThread && activeThread.updatedAt >= threads[0].updatedAt
          ? activeThread
          : threads[0];
        return resolveForThread(recentThread.threadId);
      }
      const latestWithConv = writerSessions.find(s => Boolean(s.conversationId));
      if (latestWithConv) {
        return {
          conversationId: latestWithConv.conversationId ?? undefined,
          previousSessionId: latestWithConv.sessionId,
        };
      }
      const lastConv = this.state.getMeta("last_conversation_id") || undefined;
      const lastSess = this.state.getMeta("last_writer_session_id") || this.state.writerSessionId || writerSessions[0]?.sessionId;
      return lastConv || lastSess ? { conversationId: lastConv, previousSessionId: lastSess } : {};
    }

    const threadMatch = threads.find(t => t.threadId === query)
      ?? threads.find(t => t.threadId.startsWith(query));
    if (threadMatch) {
      return resolveForThread(threadMatch.threadId);
    }

    const allSorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.epoch - a.epoch);
    const findSessionMatch = (pool: SessionRecord[]) =>
      pool.find(s => s.conversationId === query || s.sessionId === query)
      ?? pool.find(s => (s.conversationId?.startsWith(query) ?? false) || s.sessionId.startsWith(query));
    const sessionMatch = findSessionMatch(writerSessions) ?? findSessionMatch(allSorted);
    if (sessionMatch) {
      const boundThread = threads.find(t => {
        const tc = this.state.getMeta(`thread_conversation:${t.threadId}`);
        const ts = this.state.getMeta(`thread_session:${t.threadId}`);
        return (sessionMatch.conversationId && tc === sessionMatch.conversationId) || ts === sessionMatch.sessionId;
      });
      return {
        threadId: boundThread?.threadId,
        conversationId: sessionMatch.conversationId ?? undefined,
        previousSessionId: sessionMatch.sessionId,
      };
    }

    const convThreadMatch = threads.find(t => this.state.getMeta(`thread_conversation:${t.threadId}`) === query)
      ?? threads.find(t => {
        const tc = this.state.getMeta(`thread_conversation:${t.threadId}`);
        return Boolean(tc && tc.startsWith(query));
      });
    if (convThreadMatch) {
      return resolveForThread(convThreadMatch.threadId);
    }

    return { conversationId: query };
  }
  todos() { return this.state.getTodos(this.ensureThread().threadId); }
  setAutoCompact(enabled: boolean): void {
    this.autoCompact = enabled;
    this.state.setMeta("auto_compact", String(enabled));
    this.saveThread();
  }
  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
    this.policy.setApprovalMode(mode);
    for (const policy of this.worktreePolicies.values()) {
      policy.setApprovalMode(mode);
    }
    this.state.setMeta("approval_mode", mode);
    this.saveThread();
  }

  private policyFor(worktreeRoot?: string): ToolPolicy {
    if (!worktreeRoot) return this.policy;
    let policy = this.worktreePolicies.get(worktreeRoot);
    if (!policy) {
      policy = new ToolPolicy(worktreeRoot, this.state);
      this.worktreePolicies.set(worktreeRoot, policy);
    }
    policy.setApprovalMode(this.approvalMode);
    return policy;
  }
  contextStats() {
    const id = this.state.writerSessionId;
    if (id) return this.handover.stats(id, this.model, this.autoCompact);
    const contextWindow = inferContextWindow(this.model);
    const { softTokens, hardTokens, emergencyTokens } = this.handover.thresholds(contextWindow);
    return { inputTokens: 0, contextWindow, usageRatio: 0, source: "estimated" as const, level: "none" as const,
      softTokens, hardTokens, emergencyTokens, autoCompact: this.autoCompact };
  }

  private assertIdle(): void {
    if (this.closing || this.rotations.size || [...this.managed.values()].some(session => session.busy)) {
      throw new HydrogenError("INVALID_INPUT", "Writer is busy or closing");
    }
  }

  async createThread(title = "New thread"): Promise<ThreadRecord> {
    this.assertIdle();
    if (this.activeThreadId) this.saveThreadCheckpoint();
    const oldId = this.state.writerSessionId;
    if (oldId) await this.closeManaged(oldId);
    this.state.setWriteLease(null, this.state.activeEpoch);
    this.activeThreadId = "";
    this.pendingNativeHandover = false;
    this.pendingNativePacket = undefined;
    this.pendingNativeSpineCard = undefined;
    this.pendingAcpHandoverCard = undefined;
    const thread = this.ensureThread();
    this.renameThread(thread.threadId, title);
    this.state.setCheckpoint({ verifiedFacts: [], deadEndsTried: [] });
    await this.openMain();
    return this.state.getThread(thread.threadId)!;
  }

  private recentTurns(): Array<{ user: string; assistant: string }> {
    let budget: number = LIMITS.COMPACT_MAX_DIGEST_CHARS;
    return this.state.listTimelineItems(this.activeThreadId).filter(item => item.kind === "turn")
      .slice(-LIMITS.COMPACT_RECENT_TURNS).reverse().map(item => {
        const assistant = budget > 1 ? (item.assistantText ?? "").slice(-Math.floor(budget / 2)) : "";
        const user = (item.userText ?? "").slice(0, budget - assistant.length);
        budget -= user.length + assistant.length;
        return { user, assistant };
      }).reverse();
  }

  private saveThreadCheckpoint(): void {
    const thread = this.ensureThread();
    const checkpoint = this.handover.updateCheckpoint({ recentTurns: this.recentTurns() });
    this.state.setMeta(`thread_checkpoint:${thread.threadId}`, JSON.stringify(checkpoint));
    this.saveThread();
  }

  async switchThread(threadId: string, resumeConversationId?: string): Promise<ThreadRecord> {
    this.assertIdle();
    const thread = this.state.getThread(threadId);
    if (!thread) throw new HydrogenError("INVALID_INPUT", "Unknown thread");
    const currentWriterId = this.state.writerSessionId;
    const currentManaged = currentWriterId ? this.managed.get(currentWriterId) : undefined;
    const targetConv = resumeConversationId?.trim();
    if (
      threadId === this.activeThreadId &&
      currentManaged &&
      (!targetConv || currentManaged.handle.conversationId === targetConv)
    ) {
      return thread;
    }
    const switchingFromAnother = Boolean(this.activeThreadId && this.activeThreadId !== threadId);
    if (switchingFromAnother) {
      this.saveThreadCheckpoint();
    }
    const previousSessionId = this.state.getMeta(`thread_session:${threadId}`)
      || (threadId === this.activeThreadId ? currentWriterId : undefined);
    const oldId = this.state.writerSessionId;
    if (oldId) await this.closeManaged(oldId);
    this.state.setWriteLease(null, this.state.activeEpoch);
    this.activeThreadId = threadId;
    this.state.setMeta("active_thread_id", threadId);
    this.pendingNativeHandover = false;
    this.pendingNativePacket = undefined;
    this.pendingNativeSpineCard = undefined;
    this.pendingAcpHandoverCard = undefined;
    this.model = thread.model;
    this.setApprovalMode(thread.approvalMode);
    this.setAutoCompact(thread.autoCompact);
    const saved = this.state.getMeta(`thread_checkpoint:${threadId}`);
    if (saved) {
      this.state.setCheckpoint(JSON.parse(saved));
    } else if (switchingFromAnother) {
      this.state.setCheckpoint({ verifiedFacts: [], deadEndsTried: [] });
    }
    const resolvedConvId = targetConv
      || this.state.getMeta(`thread_conversation:${threadId}`)
      || (previousSessionId ? this.state.getSession(previousSessionId)?.conversationId ?? undefined : undefined)
      || undefined;
    await this.openMain({
      resume: true,
      resumeConversationId: resolvedConvId,
      previousSessionId,
    });
    return thread;
  }

  renameThread(threadId: string, title: string): void {
    const thread = this.state.getThread(threadId);
    if (!thread) throw new HydrogenError("INVALID_INPUT", "Unknown thread");
    this.state.upsertThread({ ...thread, title, updatedAt: Date.now() });
  }

  async deleteThread(threadId: string): Promise<void> {
    if (threadId === this.activeThreadId) await this.createThread();
    this.state.deleteThread(threadId);
    this.state.setMeta(`thread_checkpoint:${threadId}`, "");
    this.state.setMeta(`thread_conversation:${threadId}`, "");
    this.state.setMeta(`thread_session:${threadId}`, "");
    this.state.setMeta(`pending_native_handover:${threadId}`, "");
    this.state.setMeta(`pending_acp_handover:${threadId}`, "");
  }

  listPendingPermissions() {
    return [...this.pendingPermissions.values()].map(({ resolve: _resolve, ...request }) => request);
  }

  resolvePermission(requestId: string, choice: "allow_once" | "allow_session" | "deny"): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new HydrogenError("INVALID_INPUT", "Unknown permission request");
    if (choice === "allow_session") this.policy.allowForSession(pending.sessionId, pending.toolName);
    pending.resolve({ approved: choice !== "deny", scope: choice === "allow_session" ? "session" : "once" });
  }

  private requestPermission(sessionId: string, event: Extract<SessionEvent, { type: "permission_request" }>,
    onEvent = this.activeTurnOnEvent, signal = this.activeTurnSignal): Promise<PermissionOutcome> {
    if (!onEvent || this.autoApproveOnNoUi || signal?.aborted) return Promise.resolve({ approved: false, reason: "No interactive approval available" });
    return new Promise(resolve => {
      const abort = () => finish({ approved: false, reason: "Turn cancelled" });
      const finish = (outcome: PermissionOutcome) => {
        this.pendingPermissions.delete(event.requestId);
        signal?.removeEventListener("abort", abort);
        resolve(outcome);
      };
      this.pendingPermissions.set(event.requestId, { ...event, sessionId, createdAt: Date.now(), resolve: finish });
      signal?.addEventListener("abort", abort, { once: true });
      onEvent(event);
    });
  }

  sessionOptions(
    identity: SessionIdentity,
    _packet?: HandoffPacket,
    modelOverride?: string,
    subagentMeta?: SubagentOpenMeta,
  ): SessionOpenOptions {
    const env: Record<string, string> = {
      HYDROGEN_SESSION_ID: identity.sessionId, HYDROGEN_ROLE: identity.role,
      HYDROGEN_EPOCH: String(identity.epoch), HYDROGEN_DEPTH: String(identity.depth),
      HYDROGEN_PROJECT_ROOT: this.projectRoot,
      HYDROGEN_SOCKET_PATH: this.daemonAddr,
      HYDROGEN_DAEMON_ADDR: this.daemonAddr,
    };
    if (subagentMeta?.tools !== undefined) {
      env.HYDROGEN_ALLOWED_TOOLS = subagentMeta.tools.join(",");
    }
    if (subagentMeta?.agentId) {
      env.HYDROGEN_AGENT_ID = subagentMeta.agentId;
    }
    if (subagentMeta?.taskPath) {
      env.HYDROGEN_TASK_PATH = subagentMeta.taskPath;
    }
    const appendSystemPrompt = subagentMeta?.tools !== undefined
      ? `你是 Hydrogen subagent（${subagentMeta.taskPath ?? subagentMeta.agentId ?? "subagent"}）：仅使用授权的 Hydrogen MCP 工具（${subagentMeta.tools.join("、")}）完成任务。`
      : identity.role === "readonly"
        ? "你是 Hydrogen readonly explorer：仅使用 fs_read、fs_glob、fs_grep 检索和阅读文件，完成后返回具体发现与关键路径行号。"
        : "你是 Hydrogen writer：使用 8 个 Hydrogen MCP 原语（fs_read、fs_glob、fs_grep、fs_patch、bash、agent_dispatch、agent_message、todo_write）完成任务。独立调用可单步并行；上下文交接由 Spine Compact 引擎自动管理。";
    return {
      cwd: subagentMeta?.cwd || this.projectRoot, model: modelOverride || this.model, agent: this.agent || undefined,
      resumeSessionId: subagentMeta?.resumeSessionId, env,
      autoApprovePermissions: this.approvalMode === "full-auto" || this.autoApproveOnNoUi,
      // Track B supplies its single shim through ACP; no second plugin/server is installed.
      mcpServers: { hydrogen: { command: process.execPath,
        args: [fileURLToPath(new URL("../entry/runtime-daemon.js", import.meta.url)), "--mcp-shim"], env } },
      // Keep appendSystemPrompt 100% static so agy SystemPromptCache hits across all turns/epochs.
      appendSystemPrompt,
    };
  }

  private async openManaged(identity: SessionIdentity, packet?: HandoffPacket, resumeSessionId?: string): Promise<string> {
    if (this.closing) throw new HydrogenError("INVALID_INPUT", "Runtime is closing");
    this.state.registerSession({ ...identity, status: "opening" });
    try {
      const subagentMeta = resumeSessionId ? { resumeSessionId } : undefined;
      const handle = await this.adapter.open(this.sessionOptions(identity, packet, undefined, subagentMeta));
      if (this.closing) {
        await this.adapter.close(handle);
        throw new HydrogenError("INVALID_INPUT", "Runtime closed while the session was opening");
      }
      this.managed.set(identity.sessionId, { identity, handle, busy: false });
      this.state.registerSession({ ...identity, conversationId: handle.conversationId, status: "idle" });
      if (identity.role === "writer" && identity.depth === 0) {
        this.bindThreadSession(identity.sessionId, handle.conversationId);
      }
      return identity.sessionId;
    } catch (error) { this.state.setSessionStatus(identity.sessionId, "failed"); throw error; }
  }

  async openMain(options?: { resume?: boolean; resumeConversationId?: string; previousSessionId?: string }): Promise<string> {
    const existingId = this.state.writerSessionId;
    const existingManaged = existingId ? this.managed.get(existingId) : undefined;
    const requestedConv = options?.resumeConversationId?.trim();
    if (existingId && existingManaged) {
      if ((!options?.resume && !requestedConv) || (requestedConv && existingManaged.handle.conversationId === requestedConv)) {
        return existingId;
      }
      await this.closeManaged(existingId);
    }
    const thread = this.ensureThread();
    const shouldResume = Boolean(options?.resume || requestedConv);
    const prevSessionId = shouldResume
      ? (options?.previousSessionId
        || this.state.getMeta(`thread_session:${thread.threadId}`)
        || (this.listThreads().length <= 1 ? (existingId || this.state.getMeta("last_writer_session_id")) : undefined)
        || undefined)
      : undefined;
    const resumeConversationId = shouldResume
      ? (requestedConv
        || this.state.getMeta(`thread_conversation:${thread.threadId}`)
        || (prevSessionId ? this.state.getSession(prevSessionId)?.conversationId ?? undefined : undefined)
        || undefined)
      : undefined;
    if (shouldResume) {
      const savedCp = this.state.getMeta(`thread_checkpoint:${thread.threadId}`);
      if (savedCp) {
        try {
          const currentCp = this.state.getCheckpoint();
          if (!currentCp.activeGoal && currentCp.verifiedFacts.length === 0 && currentCp.deadEndsTried.length === 0 && !(currentCp.recentTurns?.length)) {
            this.state.setCheckpoint(JSON.parse(savedCp));
          }
        } catch { /* Ignore corrupt saved checkpoint. */ }
      }
    }
    const epoch = this.state.activeEpoch + 1;
    const sessionId = await this.openManaged({ sessionId: randomUUID(), role: "writer", depth: 0, epoch }, undefined, resumeConversationId);
    this.state.setWriteLease(sessionId, epoch);
    this.state.setMeta("active_workline", this.activeThreadId);
    if (shouldResume && prevSessionId && prevSessionId !== sessionId) {
      this.state.migrateSessionResources(prevSessionId, sessionId);
    }
    if (shouldResume) {
      const pendingSaved = this.state.getMeta(`pending_acp_handover:${thread.threadId}`);
      const handle = this.managed.get(sessionId)?.handle;
      if (pendingSaved && !this.pendingAcpHandoverCard) {
        this.pendingAcpHandoverCard = pendingSaved;
      }
      if (handle?.resumed !== true && !this.pendingAcpHandoverCard) {
        const hasTimeline = this.state.listTimelineItems(thread.threadId).length > 0;
        const cp = this.state.getCheckpoint();
        const hasCheckpointData = Boolean(
          this.state.getMeta(`thread_checkpoint:${thread.threadId}`)
          || cp.activeGoal
          || cp.nextImmediateStep
          || cp.verifiedFacts.length > 0
          || cp.deadEndsTried.length > 0
          || (cp.recentTurns?.length ?? 0) > 0
          || (cp.assistantDecisions?.length ?? 0) > 0,
        );
        if (hasTimeline || hasCheckpointData) {
          this.handover.updateCheckpoint({ recentTurns: this.recentTurns() });
          const { spineCard } = this.handover.buildSpineCheckpointCard({
            sessionId: prevSessionId ?? sessionId,
            transcriptPath: this.lastTranscriptPath,
            lastUserInput: this.lastUserInput,
          });
          if (spineCard.trim()) {
            this.pendingAcpHandoverCard = spineCard;
          }
        }
      }
    }
    return sessionId;
  }

  openNativeMain(conversationId?: string, resume?: boolean, previousSessionId?: string): string {
    const prevSessionId = previousSessionId || this.state.writerSessionId;
    if (this.state.writerSessionId && !this.managed.has(this.state.writerSessionId)) {
      const existing = this.state.getSession(this.state.writerSessionId);
      if (
        existing &&
        existing.epoch === this.state.activeEpoch &&
        existing.status !== "closed" &&
        (!existing.conversationId || (resume && (!conversationId || existing.conversationId === conversationId)))
      ) {
        if (conversationId && !existing.conversationId) {
          this.state.registerSession({ ...existing, conversationId, reuseKey: existing.reuseKey ?? undefined });
        }
        const thread = this.ensureThread();
        this.bindThreadSession(existing.sessionId, conversationId ?? existing.conversationId, thread.threadId);
        if (resume) this.restorePendingNativeHandover(thread.threadId);
        return existing.sessionId;
      }
    }
    const thread = this.ensureThread();
    const epoch = this.state.activeEpoch + 1;
    const sessionId = randomUUID();
    this.state.registerSession({ sessionId, role: "writer", depth: 0, epoch, conversationId, status: "idle" });
    if (prevSessionId && prevSessionId !== sessionId) {
      this.state.migrateSessionResources(prevSessionId, sessionId);
    }
    this.state.setWriteLease(sessionId, epoch);
    this.state.setMeta("active_workline", this.activeThreadId);
    this.bindThreadSession(sessionId, conversationId, thread.threadId);
    if (resume) this.restorePendingNativeHandover(thread.threadId);
    return sessionId;
  }

  compactNativeInPlace(
    targetSessionId?: string,
    transcriptPath = this.lastTranscriptPath,
    lastUserInput = this.lastUserInput,
  ): { sessionId: string; epoch: number; beforeTokens: number; packet: HandoffPacket; card: string } {
    const sessionId = targetSessionId ?? this.state.writerSessionId ?? this.openNativeMain();
    const existing = this.state.getSession(sessionId);
    const beforeTokens = existing?.lastInputTokens || this.contextStats().inputTokens;
    this.handover.updateCheckpoint({ recentTurns: this.recentTurns() });
    const packet = this.handover.packet({
      sessionId,
      transcriptPath,
      lastUserInput,
    });
    const card = packet.spineCard?.trim()
      || `Hydrogen Epoch=${packet.epoch} HandoffPacket（机械状态与已保存语义检查点，直接继续执行）：\n${JSON.stringify(packet)}`;
    this.state.registerSession({
      sessionId,
      role: "writer",
      depth: 0,
      epoch: packet.epoch,
      conversationId: existing?.conversationId ?? undefined,
      reuseKey: existing?.reuseKey ?? undefined,
      status: "idle",
    });
    this.state.setWriteLease(sessionId, packet.epoch);
    const rawBase = this.lastRawTranscriptTokens.get(sessionId) ?? beforeTokens;
    this.setNativeCompactedBase(sessionId, rawBase, existing?.conversationId ?? undefined);
    this.handover.resetSessionUsage(sessionId, 4000);
    this.state.appendEvent("handover.completed", sessionId, {
      oldId: sessionId,
      newId: sessionId,
      epoch: packet.epoch,
      inPlace: true,
    });
    const thread = this.ensureThread();
    this.bindThreadSession(sessionId, existing?.conversationId, thread.threadId);
    this.saveThreadCheckpoint();
    this.state.upsertTimelineItem({
      id: randomUUID(),
      threadId: thread.threadId,
      kind: "compact",
      epoch: packet.epoch,
      beforeTokens,
      afterTokens: 4000,
      summary: card,
      createdAt: Date.now(),
    });
    return { sessionId, epoch: packet.epoch, beforeTokens, packet, card };
  }

  rotateNativeMain(): { oldSessionId: string; newSessionId: string; epoch: number; beforeTokens: number; packet: HandoffPacket } {
    const rot = this.compactNativeInPlace();
    const thread = this.ensureThread();
    this.pendingNativeHandover = true;
    this.pendingNativePacket = rot.packet;
    this.pendingNativeSpineCard = rot.card;
    this.state.setMeta(`pending_native_handover:${thread.threadId}`, JSON.stringify({
      sessionId: rot.sessionId,
      spineCard: rot.card,
      createdAt: Date.now(),
    }));
    return {
      oldSessionId: rot.sessionId,
      newSessionId: rot.sessionId,
      epoch: rot.epoch,
      beforeTokens: rot.beforeTokens,
      packet: rot.packet,
    };
  }

  private nativeCompactBaseMetaKey(sessionId: string, conversationId?: string): string {
    const convId = conversationId ?? this.state.getSession(sessionId)?.conversationId ?? undefined;
    return `native_compact_base:${convId || sessionId}`;
  }

  private getNativeCompactedBase(sessionId: string, conversationId?: string): number | undefined {
    const mem = this.lastCompactedTokenSnapshot.get(sessionId);
    if (mem !== undefined) return mem;
    const raw = this.state.getMeta(this.nativeCompactBaseMetaKey(sessionId, conversationId));
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      this.lastCompactedTokenSnapshot.set(sessionId, parsed);
      return parsed;
    }
    return undefined;
  }

  private setNativeCompactedBase(sessionId: string, rawTokens: number, conversationId?: string): void {
    if (!(rawTokens > 0)) return;
    this.lastCompactedTokenSnapshot.set(sessionId, rawTokens);
    this.state.setMeta(this.nativeCompactBaseMetaKey(sessionId, conversationId), String(rawTokens));
  }

  private clearNativeCompactedBase(sessionId: string, conversationId?: string): void {
    this.lastCompactedTokenSnapshot.delete(sessionId);
    this.state.setMeta(this.nativeCompactBaseMetaKey(sessionId, conversationId), "");
  }

  private observeTranscriptUsage(sessionId: string, transcriptPath?: string, lastUserInput?: string, conversationId?: string): number | undefined {
    if (conversationId) {
      this.bindThreadSession(sessionId, conversationId);
    }
    if (transcriptPath) this.lastTranscriptPath = transcriptPath;
    if (lastUserInput !== undefined) this.lastUserInput = lastUserInput;
    if (lastUserInput?.trim() && !this.state.getCheckpoint().activeGoal) {
      this.handover.updateCheckpoint({ activeGoal: lastUserInput.trim(), nextImmediateStep: lastUserInput.trim() });
    }
    const targetPath = transcriptPath || this.lastTranscriptPath;
    if (!targetPath || !existsSync(targetPath)) return undefined;
    let fd: number | undefined;
    try {
      fd = openSync(targetPath, "r");
      const size = fstatSync(fd).size;
      if (size <= 0) return undefined;
      const readLen = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, size - readLen);
      const lines = buf.toString("utf8").split("\n").filter(line => line.trim().startsWith("{"));
      let totalInputTokens = 0;
      let outputTokens = 0;
      let sawCheckpoint = false;
      const parsedTurns: Array<{ user: string; assistant: string }> = [];
      for (let i = 0; i < lines.length; i++) {
        try {
          const step = JSON.parse(lines[i]) as {
            type?: string;
            content?: unknown;
            input_tokens?: number | null;
            cache_read_tokens?: number | null;
            output_tokens?: number | null;
          };
          if (step.type === "CHECKPOINT") {
            sawCheckpoint = true;
            totalInputTokens = 4000;
            outputTokens = 0;
            parsedTurns.length = 0;
            continue;
          }
          const inTok = typeof step.input_tokens === "number" ? step.input_tokens : 0;
          const cacheTok = typeof step.cache_read_tokens === "number" ? step.cache_read_tokens : 0;
          if (step.type === "PLANNER_RESPONSE" && (inTok > 0 || cacheTok > 0)) {
            totalInputTokens = inTok + cacheTok;
            outputTokens = typeof step.output_tokens === "number" ? step.output_tokens : 0;
          }
          if (step.type === "USER_INPUT" && typeof step.content === "string" && step.content.trim()) {
            parsedTurns.push({ user: step.content.trim().slice(0, 1500), assistant: "" });
          } else if (step.type === "PLANNER_RESPONSE" && typeof step.content === "string" && step.content.trim()) {
            if (parsedTurns.length > 0) {
              parsedTurns[parsedTurns.length - 1].assistant = step.content.trim().slice(-2000);
            }
          }
        } catch { /* Ignore partial line at start of chunk. */ }
      }
      if (parsedTurns.length > 0) {
        this.handover.updateCheckpoint({ recentTurns: parsedTurns.slice(-LIMITS.COMPACT_RECENT_TURNS) });
      }
      if (totalInputTokens > 0) {
        this.lastRawTranscriptTokens.set(sessionId, totalInputTokens);
        let effectiveTokens = totalInputTokens;
        const compactedSnapshot = this.getNativeCompactedBase(sessionId, conversationId);
        if (compactedSnapshot !== undefined) {
          if (sawCheckpoint || totalInputTokens < compactedSnapshot) {
            this.clearNativeCompactedBase(sessionId, conversationId);
          } else {
            effectiveTokens = 4000 + Math.max(0, totalInputTokens - compactedSnapshot);
          }
        }
        this.state.recordTurn(sessionId, effectiveTokens, 0, lastUserInput?.length ?? 0);
        this.handover.observeUsage(sessionId, { inputTokens: effectiveTokens, outputTokens, cumulative: true });
        return effectiveTokens;
      }
      return undefined;
    } catch { /* Ignore transient transcript read errors. */ return undefined; }
    finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* Ignore. */ }
      }
    }
  }

  async promptMain(
    text: string,
    onEvent?: (event: SessionEvent) => void,
    signal?: AbortSignal,
    turnId?: string,
    retriedOverflow = false,
  ): Promise<PromptTurnResult & { hardRotation: boolean }> {
    await this.waitForHandover();
    const emit = (event: SessionEvent) => onEvent?.(event);
    const current = this.state.writerSessionId;
    if (!current) throw new HydrogenError("NO_WRITE_LEASE", "Open a main session first");
    const rotation = this.rotations.get(current);
    if (rotation) await rotation;
    const sessionId = this.state.writerSessionId!;
    const managed = this.managed.get(sessionId);
    if (this.closing || !managed || managed.busy) throw new HydrogenError("INVALID_INPUT", "Main session is unavailable or busy");
    this.activeTurnOnEvent = onEvent;
    this.activeTurnSignal = signal;
    if (!this.state.getCheckpoint().activeGoal) this.handover.updateCheckpoint({ activeGoal: text, nextImmediateStep: text });
    const finish = this.handover.beginTurn(sessionId);
    managed.busy = true;
    let resolveRunning!: () => void;
    const running = new Promise<void>(resolve => { resolveRunning = resolve; });
    this.running.add(running);
    let release: (() => void) | undefined;
    let usage: SessionUsage | undefined;
    let bytes = 0;
    let promptChars = 0;
    const timeline: TimelineItem = { id: turnId ?? randomUUID(), threadId: this.ensureThread().threadId, kind: "turn",
      userText: text, assistantText: "", thoughtText: "", tools: [], epoch: this.state.activeEpoch, createdAt: Date.now() };
    let hardRotation = false;
    let prompted = false;
    let overflowTriggered = false;
    let retryMailboxText = "";
    let cancelledClose: Promise<void> | undefined;
    const abort = () => {
      cancelledClose = this.adapter.close(managed.handle);
      void cancelledClose.catch(error => emit({ type: "error", message: String(error) }));
    };
    try {
      release = await mainAgyTurns.acquire(signal);
      signal?.throwIfAborted();
      this.state.assertWriteLease(sessionId);
      this.state.setSessionStatus(sessionId, "running");
      const mailbox = this.agents.drainMailboxForSession(sessionId);
      const handoverCard = this.pendingAcpHandoverCard;
      this.pendingAcpHandoverCard = undefined;
      if (handoverCard && this.activeThreadId) {
        this.state.setMeta(`pending_acp_handover:${this.activeThreadId}`, "");
      }
      if (managed.handle.conversationId) {
        this.bindThreadSession(sessionId, managed.handle.conversationId);
      }
      const mailboxText = mailbox.length ? formatMailboxNotification(mailbox) : "";
      const prompt = [
        handoverCard,
        text,
        mailboxText,
      ].filter(Boolean).join("\n\n");
      promptChars = prompt.length;
      prompted = true;
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await this.adapter.prompt(managed.handle, prompt, event => {
          if (event.type === "text_delta") { bytes += Buffer.byteLength(event.text); timeline.assistantText += event.text; }
          if (event.type === "thought_delta") timeline.thoughtText += event.text;
          if (event.type === "tool_call") timeline.tools!.push(event);
          if (event.type === "tool_call_update") {
            const tool = timeline.tools!.find(tool => tool.callId === event.callId);
            if (tool) Object.assign(tool, event);
          }
          if (event.type === "usage" || (event.type === "done" && event.usage)) {
            usage = event.usage;
            this.handover.observeUsage(sessionId, usage!);
            const inputTokens = usage?.inputTokens ?? 0;
            if (!hardRotation && event.type !== "done" && inputTokens >= LIMITS.EMERGENCY_COMPACT_TOKENS && this.handover.isEmergency(sessionId, this.model, usage)) {
              hardRotation = true;
              void this.adapter.cancel(managed.handle).catch(error => emit({ type: "error", message: String(error) }));
            }
          }
          if (event.type === "permission_request") {
            const decision = this.policy.preToolUse(sessionId, { hookEventName: "PreToolUse", toolCall: {
              id: event.requestId, name: event.toolName, args: event.rawInput as Record<string, unknown> | undefined,
            } });
            const raw = event.rawInput as Record<string, unknown> | undefined;
            const toolName = event.toolName === "call_mcp_tool"
              ? String(raw?.toolName ?? raw?.tool_name ?? raw?.name ?? "") : event.toolName;
            const permissionEvent = { ...event, toolName };
            const outcome = decision.decision === "ask" || decision.decision === "force_ask"
              ? this.requestPermission(sessionId, permissionEvent, onEvent, signal)
              : Promise.resolve({ approved: decision.decision === "allow", reason: decision.reason });
            void outcome.then(async outcome => {
              if (outcome.approved && toolName.replace(/^mcp_+hydrogen_+/, "") === "bash") this.approvedShellCalls.add(sessionId);
              await this.adapter.respondPermission?.(managed.handle, event.requestId, outcome);
            }).catch(error => emit({ type: "error", message: String(error) }));
            return;
          }
          emit(event);
        }, signal);
        usage = result.usage ?? usage;
        if (usage) this.handover.observeUsage(sessionId, usage);
        this.handover.recordTurnBoundary?.(sessionId, usage?.inputTokens);
        const convId = result.conversationId || managed.handle.conversationId;
        if (convId) {
          managed.handle.conversationId = convId;
          this.bindThreadSession(sessionId, convId);
        }
        if (result.finalText) timeline.assistantText = result.finalText;
        timeline.aborted = result.aborted;
        return { ...result, hardRotation };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isOverflow =
          /context.*(?:limit|window|length|exceeded|overflow)|too many tokens|prompt is too long|413|RESOURCE_EXHAUSTED.*token/i.test(message);
        if (isOverflow && !retriedOverflow && !this.closing && !signal?.aborted) {
          overflowTriggered = true;
          retryMailboxText = mailboxText;
        } else {
          throw error;
        }
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      if (cancelledClose) {
        await cancelledClose.catch(() => {});
        this.managed.delete(sessionId);
      }
      if (prompted && !overflowTriggered) {
        this.state.recordTurn(sessionId, usage?.inputTokens ?? this.state.getSession(sessionId)!.lastInputTokens, bytes, promptChars);
      }
      this.state.setSessionStatus(sessionId, this.closing || cancelledClose ? "closed" : "idle");
      for (const pending of this.pendingPermissions.values()) {
        if (pending.sessionId === sessionId) pending.resolve({ approved: false, reason: "Turn finished" });
      }
      this.approvedShellCalls.delete(sessionId);
      this.activeTurnOnEvent = undefined;
      this.activeTurnSignal = undefined;
      if (prompted && !overflowTriggered) this.state.upsertTimelineItem(timeline);
      this.saveThreadCheckpoint();
      release?.();
      managed.busy = false;
      finish();
      resolveRunning();
      this.running.delete(running);
    }
    if (overflowTriggered) {
      await this.compactMain("reactive_overflow");
      const retryText = retryMailboxText ? `${text}\n\n${retryMailboxText}` : text;
      return this.promptMain(retryText, onEvent, signal, turnId, true);
    }
    throw new HydrogenError("INTERNAL", "Unexpected promptMain exit without result");
  }

  get currentModel(): string {
    return this.model;
  }

  get currentAgent(): string {
    return this.agent || "default";
  }

  async setAgent(agentName: string): Promise<string> {
    const trimmed = agentName.trim();
    const next = trimmed === "default" || trimmed === "none" ? "" : trimmed;
    if (this.closing) throw new HydrogenError("INVALID_INPUT", "Runtime is closing");
    await this.waitForHandover();
    const sessionId = this.state.writerSessionId;
    const managed = sessionId ? this.managed.get(sessionId) : undefined;
    if (managed?.busy) throw new HydrogenError("INVALID_INPUT", "Cannot switch agent while a turn is running");
    this.agent = next;
    this.state.setMeta("agent", next);
    if (managed && sessionId) {
      let capturedPacket: HandoffPacket | undefined;
      await this.handover.rotate(sessionId, {
        open: async packet => {
          capturedPacket = packet;
          const newId = await this.openManaged({ sessionId: randomUUID(), role: "writer", depth: 0, epoch: packet.epoch }, packet);
          this.state.migrateSessionResources(sessionId, newId);
          return newId;
        },
        close: id => this.closeManaged(id),
      });
      if (capturedPacket?.spineCard) this.pendingAcpHandoverCard = capturedPacket.spineCard;
    }
    return this.currentAgent;
  }

  async setModel(modelId: string): Promise<string> {
    const trimmed = modelId.trim();
    if (!trimmed) throw new HydrogenError("INVALID_INPUT", "Model id must not be empty");
    if (this.closing) throw new HydrogenError("INVALID_INPUT", "Runtime is closing");
    await this.waitForHandover();
    const sessionId = this.state.writerSessionId;
    const managed = sessionId ? this.managed.get(sessionId) : undefined;
    if (managed?.busy) throw new HydrogenError("INVALID_INPUT", "Cannot switch model while a turn is running");
    if (managed) {
      if (this.adapter.setModel) await this.adapter.setModel(managed.handle, trimmed);
      else {
        this.model = trimmed;
        await this.rotateMain();
        this.saveThread();
        return this.model;
      }
    }
    this.model = trimmed;
    this.saveThread();
    return this.model;
  }

  async resetMain(): Promise<string> {
    await this.createThread();
    return this.state.writerSessionId!;
  }

  async cancelMain(): Promise<void> {
    const sessionId = this.state.writerSessionId;
    const managed = sessionId ? this.managed.get(sessionId) : undefined;
    for (const pending of this.pendingPermissions.values()) pending.resolve({ approved: false, reason: "Turn cancelled" });
    if (managed?.busy) await this.adapter.cancel(managed.handle);
  }

  async rotateMain(): Promise<string> {
    return (await this.compactMain()).newSessionId;
  }

  async compactMain(instructions?: string): Promise<{
    oldSessionId: string; newSessionId: string; epoch: number; beforeTokens: number; summary: string;
  }> {
    this.assertIdle();
    const oldId = this.state.writerSessionId;
    if (!oldId) throw new HydrogenError("NO_WRITE_LEASE", "No main session");
    const beforeStats = this.contextStats();
    let capturedPacket: HandoffPacket | undefined;
    const operation = (async () => {
      if (instructions?.trim()) {
        this.handover.updateCheckpoint({ nextImmediateStep: instructions.trim() });
      }
      this.handover.updateCheckpoint({ recentTurns: this.recentTurns() });
      return this.handover.rotate(oldId, {
        open: async packet => {
          capturedPacket = packet;
          const newId = await this.openManaged({ sessionId: randomUUID(), role: "writer", depth: 0, epoch: packet.epoch }, packet);
          this.state.migrateSessionResources(oldId, newId);
          return newId;
        },
        close: id => this.closeManaged(id),
      });
    })();
    this.rotations.set(oldId, operation);
    try {
      const newId = await operation;
      const spineCard = capturedPacket?.spineCard?.trim();
      const summary = spineCard || (capturedPacket ? JSON.stringify(capturedPacket.semantic) : JSON.stringify(this.state.getCheckpoint()));
      this.pendingAcpHandoverCard = spineCard
        || (capturedPacket ? `Hydrogen Epoch=${this.state.activeEpoch} HandoffPacket:\n${JSON.stringify(capturedPacket)}` : undefined);
      if (this.pendingAcpHandoverCard && this.activeThreadId) {
        this.state.setMeta(`pending_acp_handover:${this.activeThreadId}`, this.pendingAcpHandoverCard);
      }
      this.saveThreadCheckpoint();
      this.state.upsertTimelineItem({
        id: randomUUID(),
        threadId: this.activeThreadId,
        kind: "compact",
        epoch: this.state.activeEpoch,
        beforeTokens: beforeStats.inputTokens,
        afterTokens: this.contextStats().inputTokens,
        summary,
        createdAt: Date.now(),
      });
      return { oldSessionId: oldId, newSessionId: newId, epoch: this.state.activeEpoch, beforeTokens: beforeStats.inputTokens, summary };
    } finally { this.rotations.delete(oldId); }
  }

  async waitForHandover(): Promise<void> {
    await Promise.all(this.rotations.values());
  }

  private async closeManaged(sessionId: string): Promise<void> {
    const managed = this.managed.get(sessionId);
    if (managed) { await this.adapter.close(managed.handle); this.managed.delete(sessionId); }
    this.state.setSessionStatus(sessionId, "closed");
  }

  private session(request: DaemonRequest): SessionRecord {
    const identity = request.identity;
    const paramConvId = typeof (request.params as { conversationId?: unknown } | undefined)?.conversationId === "string"
      ? (request.params as { conversationId: string }).conversationId
      : undefined;
    const convId = identity.conversationId ?? paramConvId;
    const subByConv = convId ? this.state.getSubagentByConversationId(convId) : undefined;
    if (subByConv) {
      const subSess = this.state.getSession(subByConv.sessionId);
      if (subSess) return subSess;
    }
    let session = identity.sessionId ? this.state.getSession(identity.sessionId)
      : convId ? (this.state.listSessions().find(candidate =>
          candidate.conversationId === convId && candidate.status !== "closed")
        ?? this.state.listSessions().find(candidate => candidate.conversationId === convId))
        : this.state.writerSessionId ? this.state.getSession(this.state.writerSessionId) : undefined;
    if (!session && !identity.sessionId && (identity.role === undefined || identity.role === "writer")) {
      const writerId = this.state.writerSessionId ?? this.openNativeMain(convId);
      const writer = this.state.getSession(writerId);
      if (writer) {
        session = convId && writer.conversationId !== convId
          ? this.state.registerSession({ ...writer, conversationId: convId, reuseKey: writer.reuseKey ?? undefined })
          : writer;
        if (convId) this.bindThreadSession(session.sessionId, convId);
      }
    }
    if (!session) throw new HydrogenError("PERMISSION_DENIED", "Session is not registered");
    if (session.status === "closed") {
      throw new HydrogenError("STALE_EPOCH", "Session epoch is no longer active");
    }
    if (session.role === "writer" && session.depth === 0) {
      if (convId && session.conversationId !== convId) {
        session = this.state.registerSession({ ...session, conversationId: convId, reuseKey: session.reuseKey ?? undefined });
        this.bindThreadSession(session.sessionId, convId);
      }
      if (this.state.writerSessionId !== session.sessionId || this.state.activeEpoch !== session.epoch) {
        this.state.setWriteLease(session.sessionId, session.epoch);
      }
    }
    if ((identity.role !== undefined && identity.role !== session.role) ||
        (identity.depth !== undefined && identity.depth !== session.depth)) {
      throw new HydrogenError("PERMISSION_DENIED", "Session identity does not match its registration");
    }
    return session;
  }

  async handle(request: DaemonRequest): Promise<DaemonResponse> {
    try { return { id: request.id, ok: true, result: await this.execute(request) }; }
    catch (error) { return { id: request.id, ok: false, error: {
      code: error instanceof HydrogenError ? error.code : "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    } }; }
  }

  private async execute(request: DaemonRequest): Promise<unknown> {
    if (this.closing) throw new HydrogenError("INVALID_INPUT", "Runtime is closing");
    if (request.method === "runtime.status") return {
      projectRoot: this.projectRoot, epoch: this.state.activeEpoch, writerSessionId: this.state.writerSessionId,
      sessions: this.state.listSessions(), ptyJobs: this.state.listPtyJobs(),
      subagents: this.state.listSubagents(), workflows: this.state.listWorkflows(),
    };
    if (request.method === "session.register") {
      const claimed = request.identity;
      const params = request.params as { conversationId?: string; hookEventName?: string } | undefined;
      const isSessionStartHook = params?.hookEventName === "SessionStart";
      const conversationId = claimed.conversationId ?? params?.conversationId;
      const sessionsList = this.state.listSessions();
      const existing = claimed.sessionId ? this.state.getSession(claimed.sessionId)
        : conversationId
          ? (sessionsList.find(candidate => candidate.conversationId === conversationId && candidate.status !== "closed")
            ?? (this.state.writerSessionId ? this.state.getSession(this.state.writerSessionId) : undefined)
            ?? sessionsList.find(candidate => candidate.conversationId === conversationId))
          : (this.state.writerSessionId ? this.state.getSession(this.state.writerSessionId) : undefined);
      if (existing) {
        if (existing.status === "closed" && !isSessionStartHook) {
          throw new HydrogenError("STALE_EPOCH", "Cannot register an inactive epoch");
        }
        if ((claimed.role !== undefined && claimed.role !== existing.role) ||
            (claimed.depth !== undefined && claimed.depth !== existing.depth)) {
          throw new HydrogenError("PERMISSION_DENIED", "Registration cannot change an existing identity");
        }
        const updated = this.state.registerSession({
          ...existing,
          conversationId: conversationId ?? existing.conversationId ?? undefined,
          reuseKey: existing.reuseKey ?? undefined,
          status: existing.status === "closed" ? "active" : existing.status,
        });
        if (updated.role === "writer" && updated.depth === 0) {
          this.state.setWriteLease(updated.sessionId, updated.epoch);
          this.bindThreadSession(updated.sessionId, conversationId ?? updated.conversationId);
        }
        return isSessionStartHook ? {} : updated;
      }
      const identity: SessionIdentity = { sessionId: claimed.sessionId ?? randomUUID(), role: claimed.role ?? "writer",
        epoch: claimed.epoch ?? this.state.activeEpoch, depth: claimed.depth ?? 0 };
      if (!Number.isSafeInteger(identity.depth) || identity.depth < 0 || !["writer", "readonly"].includes(identity.role)) {
        throw new HydrogenError("INVALID_INPUT", "Invalid registration role or depth");
      }
      if (identity.role === "writer" && this.state.writerSessionId && !isSessionStartHook) {
        throw new HydrogenError("NO_WRITE_LEASE", "A writer already holds the lease");
      }
      const session = this.state.registerSession({ ...identity, conversationId });
      if (session.role === "writer") {
        this.state.setWriteLease(session.sessionId, session.epoch);
        if (session.depth === 0) this.bindThreadSession(session.sessionId, conversationId);
      }
      return isSessionStartHook ? {} : session;
    }
    const session = this.session(request);
    const sessionId = session.sessionId;
    const params = request.params;
    const worktreeRoot = session.depth > 0 ? this.agents.getWorktreePath(sessionId) : undefined;
    const effectiveRoot = worktreeRoot ?? this.projectRoot;
    const activePolicy = this.policyFor(worktreeRoot);
    if (this.compacting.has(sessionId) && request.method.startsWith("tool.")) {
      throw new HydrogenError("PERMISSION_DENIED", "Compaction cannot use tools");
    }
    const toolNames: Partial<Record<DaemonRequest["method"], string>> = {
      "tool.fsRead": "fs_read", "tool.fsGlob": "fs_glob", "tool.fsGrep": "fs_grep", "tool.fsPatch": "fs_patch",
      "tool.todoWrite": "todo_write", "tool.agentDispatch": "agent_dispatch", "tool.agentMessage": "agent_message",
      "tool.agentWait": "agent_wait", "tool.workflowRun": "workflow_run",
      "handover.updateCheckpoint": "handover_checkpoint", "handover.trigger": "handover_trigger",
    };
    const toolName = toolNames[request.method];
    if (toolName) {
      const decision = activePolicy.preToolUse(sessionId, { hookEventName: "PreToolUse",
        toolCall: { name: toolName, args: params as Record<string, unknown> } });
      if (decision.decision === "deny") throw new HydrogenError("PERMISSION_DENIED", decision.reason!);

    }
    switch (request.method) {
      case "hook.preToolUse": {
        const input = params as HookCommonInput;
        if (this.compacting.has(sessionId)) return { decision: "deny", reason: "Compaction cannot use tools" };
        const decision = activePolicy.preToolUse(sessionId, input);
        if (decision.decision !== "ask" && decision.decision !== "force_ask") return decision;
        if (!this.managed.has(sessionId) && !this.activeTurnOnEvent) {
          // Native `agy` TUI mode: return `{ decision: "ask" }` directly so `agy` renders its own native confirmation card.
          return decision;
        }
        const outcome = await this.requestPermission(sessionId, { type: "permission_request", requestId: randomUUID(),
          toolName: "bash", rawInput: input.toolCall?.args });
        if (outcome.approved) this.approvedShellCalls.add(sessionId);
        return { decision: outcome.approved ? "allow" : "deny", reason: outcome.reason };
      }
      case "hook.postToolUse": {
        const input = params as HookCommonInput;
        activePolicy.postToolUse(sessionId, input);
        const call = input.toolCall;
        if (!input.error && call && /^(write_file|write_to_file|edit_file|replace_file_content)$/.test(call.name)) {
          const args = call.args ?? {};
          const path = args.Path ?? args.AbsolutePath ?? args.TargetFile ?? args.path ?? args.file_path;
          if (typeof path === "string") this.state.appendEvent("file.modified", null, { path: resolve(effectiveRoot, path) });
        }
        return {};
      }
      case "hook.preInvocation": {
        const input = params as HookCommonInput;
        const result = activePolicy.preInvocation(sessionId, input);
        const convId = input.conversationId ?? request.identity.conversationId;
        if (session.depth === 0) {
          this.observeTranscriptUsage(sessionId, input.transcriptPath, input.lastUserInput, convId);
        }
        if (session.depth === 0 && !this.managed.has(sessionId)) {
          const stats = this.handover.stats(sessionId, this.model, this.autoCompact);
          const shouldCompactNow = this.pendingNativeHandover
            || this.consumeCompactRequest()
            || (this.autoCompact && stats.level !== "none");
          if (shouldCompactNow) {
            const threadId = this.activeThreadId || this.state.getMeta("active_thread_id") || "";
            let card: string;
            if (this.pendingNativeHandover) {
              const packet = this.pendingNativePacket ?? (this.pendingNativeSpineCard ? undefined : this.handover.packet({
                sessionId,
                transcriptPath: input.transcriptPath ?? this.lastTranscriptPath,
                lastUserInput: input.lastUserInput ?? this.lastUserInput,
              }));
              card = this.pendingNativeSpineCard?.trim()
                || packet?.spineCard?.trim()
                || `Hydrogen Epoch=${this.state.activeEpoch} HandoffPacket（机械状态与已保存语义检查点，直接继续执行）：\n${JSON.stringify(packet)}`;
              this.pendingNativeHandover = false;
              this.pendingNativePacket = undefined;
              this.pendingNativeSpineCard = undefined;
              this.handover.resetSessionUsage(sessionId, 4000);
            } else {
              const rot = this.compactNativeInPlace(sessionId, input.transcriptPath, input.lastUserInput);
              card = rot.card;
              this.onNativeRotate?.({ sessionId, beforeTokens: rot.beforeTokens, epoch: rot.epoch });
            }
            if (threadId) {
              this.state.setMeta(`pending_native_handover:${threadId}`, "");
              this.state.setMeta(`pending_acp_handover:${threadId}`, "");
            }
            this.injectedNativeSessions.add(sessionId);
            result.injectSteps = [
              ...(result.injectSteps ?? []),
              {
                systemMessage: {
                  systemMessage: card,
                  metadata: {
                    user_markdown: `⟳ **[hgy AutoCompact]** Epoch E${this.state.activeEpoch} 已生成并注入 Spine 检查点摘要`,
                  },
                },
              },
            ];
          }
        }
        const mailbox = this.agents.drainMailboxForSession(sessionId, convId);
        if (mailbox.length > 0) {
          result.injectSteps = [
            ...(result.injectSteps ?? []),
            { userMessage: formatMailboxNotification(mailbox) },
          ];
        }
        return result;
      }
      case "hook.stop": {
        const input = params as HookCommonInput;
        const convId = input.conversationId ?? request.identity.conversationId;
        if (session.depth === 0) {
          const currentInputTokens = this.observeTranscriptUsage(sessionId, input.transcriptPath, input.lastUserInput, convId);
          this.handover.recordTurnBoundary?.(sessionId, currentInputTokens);
          if (!this.managed.has(sessionId)) {
            const stats = this.handover.stats(sessionId, this.model, this.autoCompact);
            if (this.consumeCompactRequest() || (this.autoCompact && stats.level !== "none")) {
              const rot = this.compactNativeInPlace(sessionId, input.transcriptPath, input.lastUserInput);
              this.pendingNativeHandover = true;
              this.pendingNativePacket = rot.packet;
              this.pendingNativeSpineCard = rot.card;
              const threadId = this.activeThreadId || this.state.getMeta("active_thread_id") || "";
              if (threadId) {
                this.state.setMeta(`pending_native_handover:${threadId}`, JSON.stringify({
                  sessionId,
                  spineCard: rot.card,
                  createdAt: Date.now(),
                }));
              }
              this.onNativeRotate?.({ sessionId, beforeTokens: rot.beforeTokens, epoch: rot.epoch });
            }
          }
        }
        return {};
      }
      case "tool.fsRead": return fsRead(effectiveRoot, this.state, sessionId, this.spill, params as FsReadInput);
      case "tool.todoWrite": {
        this.state.setTodos(this.ensureThread().threadId, (params as TodoWriteInput).todos);
        return { todos: this.todos() };
      }
      case "tool.fsGlob": return fsGlob(effectiveRoot, params as FsGlobInput);
      case "tool.fsGrep": return fsGrep(effectiveRoot, this.spill, params as FsGrepInput);
      case "tool.fsPatch": {
        const result = await fsPatch(effectiveRoot, this.state, sessionId, params as FsPatchInput);
        this.state.appendEvent("file.modified", null, { path: result.path });
        return result;
      }
      case "tool.bash": {
        const bashInput = params as BashInput;
        return this.executeBash(
          sessionId,
          worktreeRoot && !bashInput.cwd ? { ...bashInput, cwd: worktreeRoot } : bashInput,
        );
      }
      case "tool.agentDispatch": {
        const input = params as AgentDispatchInput;
        const act = input.action ?? "spawn";
        if (act === "spawn" || act === "dispatch" || act === "followup" || act === "send" || act === "send_input" || act === "resume") {
          this.handover.assertAccepting(sessionId);
        }
        return this.agents.dispatch(session, input);
      }
      case "tool.agentMessage":
        return this.agents.message(session, params as AgentMessageInput);
      case "tool.agentWait": {
        const input = params as AgentWaitInput;
        const sub = session.depth > 0 ? this.state.getSubagentBySessionId(session.sessionId) : undefined;
        return this.agents.wait({
          ...input,
          callerPath: input.callerPath ?? sub?.taskPath ?? "/root",
          rootId: input.rootId ?? sub?.rootId ?? (this.state.getMeta("active_workline") || this.state.writerSessionId || "root"),
        });
      }
      case "tool.workflowRun": {
        const input = params as WorkflowRunInput;
        if (!input.action || input.action === "run") this.handover.assertAccepting(sessionId);
        return this.workflows.run(session, input);
      }
      case "handover.updateCheckpoint":
        this.state.assertWriteLease(sessionId);
        return this.handover.updateCheckpoint(params as Partial<HandoffPacket["semantic"]>);
      case "handover.trigger": {
        this.state.assertWriteLease(sessionId);
        this.compactRequested = true;
        return { rotating: true };
      }
      default: throw new HydrogenError("INVALID_INPUT", `Unknown daemon method: ${String(request.method)}`);
    }
  }

  private async executeBash(sessionId: string, input: BashInput, signal = this.activeTurnSignal) {
    const decision = this.policy.preToolUse(sessionId, { hookEventName: "PreToolUse", toolCall: { name: "bash", args: { ...input } } });
    if (decision.decision === "deny") throw new HydrogenError("PERMISSION_DENIED", decision.reason!);
    const action = input.action ?? "exec";
    if (action === "exec" && decision.decision === "ask" && !this.approvedShellCalls.delete(sessionId)) {
      if (this.managed.has(sessionId) || this.activeTurnOnEvent) {
        const outcome = await this.requestPermission(sessionId, { type: "permission_request", requestId: randomUUID(),
          toolName: "bash", rawInput: input }, this.activeTurnOnEvent, signal);
        if (!outcome.approved) throw new HydrogenError("PERMISSION_DENIED", outcome.reason ?? "User denied permission");
      }
    }
    this.state.assertWriteLease(sessionId);
    return this.processes.execute(sessionId, input);
  }

  private async killSessionPtyJobs(sessionId: string): Promise<void> {
    const aliveJobs = this.state.listPtyJobs(sessionId).filter(job => job.alive);
    await Promise.allSettled(
      aliveJobs.map(job => this.processes.execute(sessionId, { action: "kill", jobId: job.jobId })),
    );
  }

  consumeCompactRequest(): boolean {
    const requested = this.compactRequested;
    this.compactRequested = false;
    return requested;
  }

  async dispose(): Promise<void> {
    for (const pending of this.pendingPermissions.values()) pending.resolve({ approved: false, reason: "Runtime closing" });
    this.closing = true;
    await this.workflows.dispose();
    await this.agents.dispose();
    await Promise.all([...this.managed.keys()].map(id => this.closeManaged(id)));
    await Promise.allSettled([...this.running, ...this.rotations.values()]);
    await this.processes.dispose();
    this.state.close();
  }
}

export interface TurnLoopHooks {
  turnId?: string;
  onEvent: (event: SessionEvent) => void;
  onRotation?: (info: { epoch: number; reason: "pre_turn" | "post_turn" | "hard" }) => void;
  onAfterTurn?: (meta: { aborted: boolean; hardRotation: boolean }) => void;
}

export async function runTurnWithHandover(
  runtime: HydrogenRuntime, text: string, hooks: TurnLoopHooks, signal?: AbortSignal,
): Promise<void> {
  if (!runtime.state.getCheckpoint().activeGoal) runtime.handover.updateCheckpoint({ activeGoal: text, nextImmediateStep: text });
  let next = text;
  let turnId = hooks.turnId;
  for (;;) {
    if (signal?.aborted) return;
    const preStats = runtime.contextStats();
    if (preStats.level === "hard" || (runtime.autoCompact && preStats.level !== "none")) {
      await runtime.compactMain();
      hooks.onRotation?.({ epoch: runtime.state.activeEpoch, reason: "pre_turn" });
    }
    const result = await runtime.promptMain(next, hooks.onEvent, signal, turnId);
    turnId = undefined;
    hooks.onAfterTurn?.({ aborted: result.aborted, hardRotation: result.hardRotation });
    if (signal?.aborted) return;
    const requested = runtime.consumeCompactRequest();
    if (requested || result.hardRotation || (runtime.autoCompact && runtime.contextStats().level !== "none")) {
      await runtime.compactMain();
      hooks.onRotation?.({ epoch: runtime.state.activeEpoch, reason: result.hardRotation ? "hard" : "post_turn" });
    }
    if (!result.hardRotation || !result.aborted) return;
    next = `继续执行交接包中的 activeGoal 与 nextImmediateStep，完成用户请求：\n${text}`;
  }
}
