import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ManagedSessionHandle, SessionAdapter, SessionOpenOptions, SessionUsage } from "../adapters/session.js";
import { spillOutput } from "./output.js";
import { ToolPolicy } from "./policy.js";
import {
  ALL_SUBAGENT_TOOLS,
  DEFAULT_SUBAGENT_TOOLS,
  LIMITS,
  extractEffortFromModelId,
  resolveModelAndEffort,
  type AgentDispatchInput,
  type AgentMessageInput,
  type AgentTaskSpec,
  type AgentWaitInput,
  type CanonicalEffort,
  type SessionIdentity,
  type SessionRole,
  type SubagentToolName,
} from "./protocol.js";
import {
  HydrogenError,
  StateStore,
  normalizeTaskPath,
  normalizeTaskSegment,
  type AgentMailRecord,
  type SubagentRecord,
} from "./state.js";

/** Permits are transferred directly to FIFO waiters; newcomers cannot jump the queue. */
export class FifoSemaphore {
  private active = 0;
  private readonly queue: Array<{ grant: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void }> = [];
  constructor(private readonly capacity: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const waiter = {
        signal, reject,
        abort: () => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(signal!.reason);
        },
        grant: () => {
          signal?.removeEventListener("abort", waiter.abort);
          resolve(() => {
            const next = this.queue.shift();
            if (next) next.grant();
            else this.active--;
          });
        },
      };
      if (this.active < this.capacity) { this.active++; waiter.grant(); }
      else { this.queue.push(waiter); signal?.addEventListener("abort", waiter.abort, { once: true }); }
    });
  }
}

export const mainAgyTurns = new FifoSemaphore(1);
export const agyTurns = new FifoSemaphore(LIMITS.MAX_CONCURRENT_AGY_TURNS);

const VALID_TOOL_SET = new Set<string>(ALL_SUBAGENT_TOOLS);
const NICKNAME_POOL = [
  "Sol", "Vega", "Lyra", "Orion", "Nova", "Altair",
  "Rigel", "Sirius", "Atlas", "Helios", "Ceres", "Draco",
];
const TERMINAL_OR_IDLE = new Set(["idle", "interrupted", "closed", "failed"]);
const BUSY_STATUSES = new Set(["queued", "running"]);
const ACTIVE_BROADCAST_STATUSES = new Set(["queued", "starting", "opening", "running", "idle", "interrupted"]);
const WAIT_EVENT_TYPES = new Set(["MESSAGE", "BROADCAST", "FINAL_ANSWER", "TURN_COMPLETED", "CLOSED", "agent.completed"]);

export interface SubagentResult extends SubagentRecord {
  effort?: CanonicalEffort;
  unreadMailCount?: number;
  worktreePath?: string;
}

export interface AgentBatchTaskResult {
  agentId: string;
  taskPath: string;
  nickname: string;
  role: string;
  model: string;
  effort?: CanonicalEffort;
  tools: SubagentToolName[];
  writeScope?: string[];
  worktreePath?: string;
  status: string;
  turnCount: number;
  summary: string;
  outputRef: string | null;
}

export interface AgentBatchResult {
  tasks: AgentBatchTaskResult[];
}

export interface SubagentOpenMeta {
  model?: string;
  tools?: SubagentToolName[];
  agentId?: string;
  taskPath?: string;
  role?: string;
  writeScope?: string[];
  cwd?: string;
  resumeSessionId?: string;
}

interface LiveAgentEntry {
  record: SubagentRecord;
  identity: SessionIdentity;
  parentSessionId: string;
  workline: string;
  handle?: ManagedSessionHandle;
  idleTimer?: ReturnType<typeof setTimeout>;
  hibernating?: Promise<void>;
  worktreePath?: string;
  controller: AbortController;
  interruptMode: "none" | "interrupt" | "close";
  finished: Promise<SubagentResult>;
  syncWait: boolean;
  wake: "never" | "next_turn";
}

function resolveToolsAndRole(
  inputTools?: SubagentToolName[],
  roleLabel?: string,
  requestedScope?: string[],
  options?: {
    disableAgentMessage?: boolean;
    enableAgentMessage?: boolean;
    asyncMode?: boolean;
    forceWriter?: boolean;
  },
): {
  tools: SubagentToolName[];
  sessionRole: SessionRole;
  roleLabel: string;
  writeScope?: string[];
} {
  const normalizedRole = roleLabel?.trim().toLowerCase();
  if (normalizedRole === "prober") {
    throw new HydrogenError(
      "INVALID_INPUT",
      "Role 'prober' is not supported; use role 'explorer', 'worker', or 'verifier'.",
    );
  }
  let tools: SubagentToolName[];
  if (inputTools !== undefined) {
    for (const tool of inputTools) {
      if (!VALID_TOOL_SET.has(tool)) {
        throw new HydrogenError("INVALID_INPUT", `Unknown subagent tool: ${tool}`);
      }
    }
    tools = [...new Set(inputTools)];
  } else if (normalizedRole === "verifier") {
    tools = ["fs_read", "fs_glob", "fs_grep", "bash"];
  } else if (normalizedRole === "worker" || requestedScope !== undefined || options?.forceWriter) {
    tools = ["fs_read", "fs_glob", "fs_grep", "fs_patch", "bash"];
  } else {
    tools = [...DEFAULT_SUBAGENT_TOOLS];
  }

  const wantAgentMessage = options?.disableAgentMessage
    ? false
    : Boolean(options?.enableAgentMessage || options?.asyncMode || inputTools?.includes("agent_message"));
  if (!wantAgentMessage) {
    tools = tools.filter(t => t !== "agent_message");
  } else if (!tools.includes("agent_message")) {
    tools.push("agent_message");
  }

  const sessionRole: SessionRole = tools.includes("fs_patch") || tools.includes("bash") ? "writer" : "readonly";
  const effectiveLabel = roleLabel?.trim() || (sessionRole === "writer" ? "worker" : "explorer");
  const writeScope = normalizedRole === "verifier" && requestedScope === undefined && !tools.includes("fs_patch")
    ? []
    : requestedScope;
  return { tools, sessionRole, roleLabel: effectiveLabel, writeScope };
}

export function formatMailboxNotification(items: AgentMailRecord[]): string {
  const body = items.map(mail => [
    `[${mail.messageType}] From: ${mail.senderPath} -> To: ${mail.recipientPath}`,
    mail.content,
  ].join("\n")).join("\n\n");
  return `[Agent Mailbox (${items.length} unread)]\n${body}`;
}

function groupAlive(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  if (process.platform === "win32") {
    try { process.kill(pgid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }
  try { process.kill(-pgid, 0); return true; }
  catch { return false; }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pgid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch { /* Ignore already exited. */ }
    return;
  }
  try { process.kill(-pgid, signal); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

function summarizeWorktreeGit(worktreePath: string): string {
  try {
    const status = execFileSync("git", ["-C", worktreePath, "status", "--short"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!status) return `[worktree: ${worktreePath} | clean]`;
    const changedCount = status.split(/\r?\n/).filter(Boolean).length;
    const diffStat = execFileSync("git", ["-C", worktreePath, "diff", "--stat", "HEAD"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const statTail = diffStat ? diffStat.split(/\r?\n/).pop()?.trim() ?? "" : "";
    return `[worktree: ${worktreePath} | ${changedCount} file(s) touched${statTail ? ` (${statTail})` : ""}]`;
  } catch {
    return `[worktree: ${worktreePath}]`;
  }
}

function buildRoleGuidance(record: SubagentRecord, worktreePath?: string): string {
  const lines = [
    `Subagent Identity: agentId=${record.agentId}, taskPath=${record.taskPath}, role=${record.role}, model=${record.model}.`,
    `Authorized Hydrogen MCP Tools: [${record.tools.join(", ")}].`,
  ];
  if (worktreePath) {
    lines.push(`ISOLATED GIT WORKTREE: cwd=${worktreePath}. Execute all edits and commands inside this isolated worktree.`);
  }
  if (record.writeScope !== undefined) {
    if (record.writeScope.length === 0) {
      lines.push("STRICT READ-ONLY PROJECT SCOPE (writeScope=[]): Never modify repository files; temporary scratch files may only use /tmp.");
    } else {
      lines.push(`STRICT WRITE SCOPE: writeScope=${JSON.stringify(record.writeScope)}. Never modify files outside this scope.`);
    }
  }
  return lines.join("\n");
}

export class AgentManager {
  private readonly entries = new Map<string, LiveAgentEntry>();
  private readonly worktreePolicies = new Map<string, ToolPolicy>();
  private readonly slots = new FifoSemaphore(LIMITS.MAX_CONCURRENT_EXPLORERS);
  private closing = false;

  constructor(
    private readonly state: StateStore,
    private readonly adapter: SessionAdapter,
    private readonly options: (identity: SessionIdentity, meta?: SubagentOpenMeta) => SessionOpenOptions,
    private readonly policy?: ToolPolicy,
    private readonly getForkContext?: (parentSessionId: string) => string | undefined,
    private readonly getParentModel?: () => string,
    private readonly killSessionPtyJobs?: (sessionId: string) => Promise<void>,
  ) {}

  private workline(): string {
    return `${this.state.getMeta("active_workline") ?? this.state.writerSessionId ?? "root"}:${this.state.getCheckpoint().activeGoal ?? ""}`;
  }

  private resolveRootId(): string {
    return this.state.getMeta("active_workline") || this.state.writerSessionId || "root";
  }

  private callerContext(identity: SessionIdentity): {
    callerId: string;
    callerPath: string;
    rootId: string;
  } {
    if (identity.depth === 0) {
      return { callerId: "/root", callerPath: "/root", rootId: this.resolveRootId() };
    }
    const self = this.state.getSubagentBySessionId(identity.sessionId);
    if (self) {
      return { callerId: self.agentId, callerPath: self.taskPath, rootId: self.rootId };
    }
    return {
      callerId: identity.agentId ?? "/root",
      callerPath: identity.taskPath ?? "/root",
      rootId: this.resolveRootId(),
    };
  }

  private allocateNickname(rootId: string): string {
    const used = new Set(this.state.listSubagents(rootId).map(agent => agent.nickname).filter(Boolean));
    for (const candidate of NICKNAME_POOL) {
      if (!used.has(candidate)) return candidate;
    }
    let suffix = 2;
    for (;;) {
      for (const candidate of NICKNAME_POOL) {
        const named = `${candidate} ${suffix}`;
        if (!used.has(named)) return named;
      }
      suffix += 1;
    }
  }

  private allocateIdentity(
    rootId: string,
    parentPath: string,
    taskName?: string,
  ): { agentId: string; taskPath: string } {
    const existingInRoot = this.state.listSubagents(rootId);
    let taskPath: string;
    let agentId: string;
    if (taskName?.trim()) {
      const segment = normalizeTaskSegment(taskName);
      taskPath = normalizeTaskPath(`${parentPath === "/root" ? "/root" : parentPath}/${segment}`);
      const liveConflict = existingInRoot.find(
        agent => agent.taskPath === taskPath && !["closed", "killed"].includes(agent.status),
      );
      if (liveConflict) {
        throw new HydrogenError("INVALID_INPUT", `Task path already exists: ${taskPath}`);
      }
      const cleanId = taskName.trim();
      if (/^[A-Za-z0-9_-]+$/.test(cleanId) && cleanId !== "root" && !this.state.getSubagent(cleanId)) {
        agentId = cleanId;
      } else {
        agentId = this.state.nextSubagentId();
      }
    } else {
      agentId = this.state.nextSubagentId();
      const segment = normalizeTaskSegment(agentId);
      taskPath = normalizeTaskPath(`${parentPath === "/root" ? "/root" : parentPath}/${segment}`);
    }
    return { agentId, taskPath };
  }

  private persistPermissions(sessionId: string, tools: SubagentToolName[], writeScope?: string[]): void {
    this.state.setAllowedTools(sessionId, tools);
    this.state.setWriteScope(sessionId, writeScope);
    if (this.policy) {
      this.policy.setAllowedTools(sessionId, tools);
      this.policy.setWriteScope(sessionId, writeScope);
    }
  }

  private snapshot(record: SubagentRecord): SubagentResult {
    const worktreePath = this.getWorktreePathByAgentId(record.agentId);
    const effort = extractEffortFromModelId(record.model).effort;
    return {
      ...record,
      ...(effort ? { effort } : {}),
      unreadMailCount: this.state.countUnreadMail(record.agentId),
      ...(worktreePath ? { worktreePath } : {}),
    };
  }

  private createWorktree(agentId: string): string {
    let repoRoot: string;
    try {
      repoRoot = execFileSync("git", ["-C", this.state.projectRoot, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      throw new HydrogenError(
        "INVALID_INPUT",
        `worktree: true requires a git repository (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const worktreesDir = join(this.state.projectRoot, ".hydrogen", "worktrees");
    mkdirSync(worktreesDir, { recursive: true });
    const worktreePath = join(worktreesDir, agentId);
    try {
      execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", worktreePath, "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new HydrogenError(
        "INVALID_INPUT",
        `Failed to create git worktree at ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return worktreePath;
  }

  private saveWorktreePath(agentId: string, sessionId: string, worktreePath: string): void {
    this.state.setMeta(`worktree_agent:${agentId}`, worktreePath);
    this.state.setMeta(`worktree_session:${sessionId}`, worktreePath);
  }

  private getWorktreePathByAgentId(agentId: string): string | undefined {
    const live = this.entries.get(agentId)?.worktreePath;
    if (live) return live;
    const saved = this.state.getMeta(`worktree_agent:${agentId}`);
    return saved && existsSync(saved) ? saved : undefined;
  }

  getWorktreePath(sessionId: string): string | undefined {
    for (const entry of this.entries.values()) {
      if (entry.identity.sessionId === sessionId && entry.worktreePath) {
        return entry.worktreePath;
      }
    }
    const bySession = this.state.getMeta(`worktree_session:${sessionId}`);
    if (bySession && existsSync(bySession)) return bySession;
    const sub = this.state.getSubagentBySessionId(sessionId);
    if (sub) {
      const byAgent = this.state.getMeta(`worktree_agent:${sub.agentId}`);
      if (byAgent && existsSync(byAgent)) return byAgent;
    }
    return undefined;
  }

  private policyFor(worktreePath?: string): ToolPolicy | undefined {
    if (!this.policy) return undefined;
    if (!worktreePath) return this.policy;
    let policy = this.worktreePolicies.get(worktreePath);
    if (!policy) {
      policy = new ToolPolicy(worktreePath, this.state);
      this.worktreePolicies.set(worktreePath, policy);
    }
    policy.setApprovalMode(this.policy.getApprovalMode());
    return policy;
  }

  async dispatch(
    identity: SessionIdentity,
    input: AgentDispatchInput,
    signal?: AbortSignal,
  ): Promise<SubagentResult | SubagentResult[] | AgentBatchResult | Record<string, unknown>> {
    if (this.closing) throw new HydrogenError("INVALID_INPUT", "Agent manager is closing");
    const action = input.action ?? "spawn";
    const caller = this.callerContext(identity);

    if (action === "list" || action === "status") {
      const targetRef = input.target ?? input.agentId;
      if (action === "status" && targetRef) {
        const record = this.state.resolveAgent(targetRef, { rootId: caller.rootId, callerPath: caller.callerPath });
        return this.snapshot(record);
      }
      return this.state.listSubagents(caller.rootId).map(record => this.snapshot(record));
    }

    if (action === "wait") {
      return this.wait({
        afterSeq: undefined,
        agentIds: input.agentIds ?? (input.target || input.agentId ? [input.target ?? input.agentId!] : undefined),
        waitAll: input.waitAll,
        timeoutMs: input.timeoutMs,
        callerPath: caller.callerPath,
        rootId: caller.rootId,
      });
    }

    if (action === "interrupt") {
      const targetRef = input.target ?? input.agentId;
      if (!targetRef) throw new HydrogenError("INVALID_INPUT", "interrupt requires target or agentId");
      const record = this.state.resolveAgent(targetRef, { rootId: caller.rootId, callerPath: caller.callerPath });
      await this.interrupt(record.agentId);
      return this.snapshot(this.require(record.agentId));
    }

    if (action === "close") {
      const targetRef = input.target ?? input.agentId;
      if (!targetRef) throw new HydrogenError("INVALID_INPUT", "close requires target or agentId");
      const record = this.state.resolveAgent(targetRef, { rootId: caller.rootId, callerPath: caller.callerPath });
      return { closed: await this.closeSubtree(record.agentId) };
    }

    if (action === "followup" || action === "send" || action === "send_input" || action === "resume") {
      return this.followup(identity, input, signal);
    }

    if (action === "send_message" || action === "broadcast") {
      const to = input.to
        ?? (input.agentIds && input.agentIds.length > 0 ? input.agentIds : (input.target ?? input.agentId));
      return this.message(identity, {
        action: action === "broadcast" ? "broadcast" : "send",
        to,
        message: input.message?.trim() || input.prompt?.trim(),
      });
    }

    if (action !== "spawn" && action !== "dispatch") {
      throw new HydrogenError("INVALID_INPUT", `Unknown agent_dispatch action: ${String(action)}`);
    }

    if (identity.depth >= LIMITS.MAX_AGENT_DEPTH) {
      throw new HydrogenError("DEPTH_EXCEEDED", `Max subagent depth (${LIMITS.MAX_AGENT_DEPTH}) reached`);
    }

    if (input.tasks && input.tasks.length > 0) {
      const wait = input.wait ?? true;
      const results = await Promise.all(
        input.tasks.map((task: AgentTaskSpec) => {
          const text = task.prompt?.trim() || task.objective?.trim();
          if (!text) {
            throw new HydrogenError("INVALID_INPUT", "Each task in tasks requires a non-empty prompt or objective");
          }
          const single: AgentDispatchInput = {
            action: "spawn",
            taskName: task.taskName,
            role: task.role ?? input.role,
            model: task.model ?? input.model,
            effort: task.effort ?? input.effort,
            tools: task.tools ?? input.tools,
            disableAgentMessage: task.disableAgentMessage ?? input.disableAgentMessage,
            enableAgentMessage: task.enableAgentMessage ?? input.enableAgentMessage,
            writeScope: task.writeScope ?? input.writeScope,
            forkTurns: task.forkTurns ?? input.forkTurns,
            includeParentContext: task.includeParentContext ?? input.includeParentContext,
            worktree: task.worktree ?? input.worktree,
            reuseKey: task.reuseKey,
            wake: input.wake,
            wait,
            timeoutMs: input.timeoutMs,
            prompt: task.prompt,
            packet: task.objective
              ? {
                  objective: task.objective,
                  relevantFiles: task.relevantFiles,
                  writeScope: task.writeScope ?? input.writeScope,
                  knownFacts: task.knownFacts,
                  constraints: task.constraints,
                  outputContract: task.outputContract,
                }
              : undefined,
          };
          return this.spawnSingle(identity, single, signal);
        }),
      );
      return {
        tasks: results.map(r => ({
          agentId: r.agentId,
          taskPath: r.taskPath,
          nickname: r.nickname,
          role: r.role,
          model: r.model,
          ...(r.effort ? { effort: r.effort } : {}),
          tools: r.tools,
          writeScope: r.writeScope,
          ...(r.worktreePath ? { worktreePath: r.worktreePath } : {}),
          status: r.status,
          turnCount: r.turnCount,
          summary: r.summary,
          outputRef: r.outputRef,
        })),
      };
    }

    if (input.agentId && !input.prompt?.trim() && !input.packet?.objective?.trim() && !input.message?.trim()) {
      throw new HydrogenError("INVALID_INPUT", "dispatch requires prompt, message, packet.objective, or tasks");
    }
    if (input.agentId) {
      return this.followup(identity, input, signal);
    }

    return this.spawnSingle(identity, input, signal);
  }

  private buildInitialPrompt(identity: SessionIdentity, input: AgentDispatchInput): string {
    const parts: string[] = [];
    if (input.includeParentContext || input.forkTurns === "all") {
      const forkCard = this.getForkContext?.(identity.sessionId);
      if (forkCard?.trim()) {
        parts.push(`[PARENT_CONTEXT_SUMMARY]\n${forkCard.trim()}\n[/PARENT_CONTEXT_SUMMARY]`);
      }
    }
    if (input.packet) parts.push(JSON.stringify(input.packet));
    if (input.prompt?.trim()) parts.push(input.prompt.trim());
    if (input.message?.trim()) parts.push(input.message.trim());
    return parts.join("\n\n");
  }

  private resolveSubagentModel(model?: string, effort?: string): string {
    try {
      return resolveModelAndEffort({
        model,
        effort,
        parentModel: this.getParentModel?.(),
        defaultModelName: LIMITS.DEFAULT_SUBAGENT_MODEL_NAME,
        defaultEffort: LIMITS.DEFAULT_SUBAGENT_EFFORT,
      }).modelId;
    } catch (error) {
      throw new HydrogenError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
    }
  }

  private async spawnSingle(
    identity: SessionIdentity,
    input: AgentDispatchInput,
    signal?: AbortSignal,
  ): Promise<SubagentResult> {
    const promptText = this.buildInitialPrompt(identity, input);
    if (!promptText.trim()) {
      throw new HydrogenError("INVALID_INPUT", "spawn/dispatch requires prompt, message, packet.objective, or tasks");
    }

    const caller = this.callerContext(identity);
    const model = this.resolveSubagentModel(input.model, input.effort);
    const useWorktree = Boolean(input.worktree);
    const wait = input.wait ?? true;
    const requestedScope = input.writeScope ?? input.packet?.writeScope;
    const { tools, sessionRole, roleLabel, writeScope } = resolveToolsAndRole(
      input.tools,
      input.role,
      requestedScope,
      {
        disableAgentMessage: Boolean(input.disableAgentMessage),
        enableAgentMessage: Boolean(input.enableAgentMessage),
        asyncMode: !wait,
        forceWriter: useWorktree,
      },
    );

    let entry = input.reuseKey
      ? [...this.entries.values()].find(candidate =>
        candidate.record.rootId === caller.rootId &&
        candidate.record.parentId === caller.callerId &&
        candidate.record.reuseKey === input.reuseKey &&
        candidate.record.model === model &&
        candidate.record.tools.join(",") === tools.join(",") &&
        Boolean(candidate.worktreePath) === useWorktree &&
        (useWorktree || JSON.stringify(candidate.record.writeScope ?? null) === JSON.stringify(writeScope ?? null)) &&
        candidate.workline === this.workline() &&
        candidate.record.status === "idle" &&
        Date.now() - candidate.record.updatedAt <= LIMITS.REUSE_IDLE_TTL_MS &&
        (this.state.getSession(candidate.identity.sessionId)?.lastInputTokens ?? 0) <= LIMITS.REUSE_MAX_INPUT_TOKENS)
      : undefined;

    if (!entry) {
      const { agentId, taskPath } = this.allocateIdentity(caller.rootId, caller.callerPath, input.taskName);
      const nickname = this.allocateNickname(caller.rootId);
      const worktreePath = useWorktree ? this.createWorktree(agentId) : undefined;
      const effectiveWriteScope = worktreePath
        ? (writeScope !== undefined ? [...new Set([...writeScope, worktreePath])] : [worktreePath])
        : writeScope;
      const now = Date.now();
      const childIdentity: SessionIdentity = {
        sessionId: randomUUID(),
        role: sessionRole,
        epoch: identity.epoch,
        depth: identity.depth + 1,
        parentSessionId: identity.sessionId,
        agentId,
        taskPath,
      };
      const record: SubagentRecord = {
        agentId,
        sessionId: childIdentity.sessionId,
        conversationId: "",
        taskPath,
        parentId: caller.callerId,
        rootId: caller.rootId,
        nickname,
        role: roleLabel,
        model,
        tools,
        writeScope: effectiveWriteScope,
        reuseKey: input.reuseKey ?? null,
        status: "queued",
        turnCount: 0,
        summary: "",
        outputRef: null,
        createdAt: now,
        updatedAt: now,
      };
      this.persistPermissions(childIdentity.sessionId, tools, effectiveWriteScope);
      if (worktreePath) {
        this.saveWorktreePath(agentId, childIdentity.sessionId, worktreePath);
      }
      entry = {
        record,
        identity: childIdentity,
        parentSessionId: identity.sessionId,
        workline: this.workline(),
        worktreePath,
        controller: new AbortController(),
        interruptMode: "none",
        finished: Promise.resolve(this.snapshot(record)),
        syncWait: wait,
        wake: input.wake ?? "never",
      };
      this.entries.set(agentId, entry);
      this.save(entry);
    } else {
      entry.parentSessionId = identity.sessionId;
      entry.syncWait = wait;
      entry.wake = input.wake ?? "never";
      entry.controller = new AbortController();
      entry.interruptMode = "none";
      entry.record.status = "queued";
      this.save(entry);
    }

    return this.launchTurn(entry, promptText, wait, input.timeoutMs, signal);
  }

  async followup(
    identity: SessionIdentity,
    input: AgentDispatchInput,
    signal?: AbortSignal,
  ): Promise<SubagentResult> {
    const targetRef = input.target ?? input.agentId;
    if (!targetRef) throw new HydrogenError("INVALID_INPUT", "followup requires target or agentId");
    const promptText = [
      input.packet ? JSON.stringify(input.packet) : "",
      input.prompt?.trim() ?? "",
      input.message?.trim() ?? "",
    ].filter(Boolean).join("\n\n");

    const caller = this.callerContext(identity);
    const resolved = this.state.resolveAgent(targetRef, { rootId: caller.rootId, callerPath: caller.callerPath });
    if (["closed", "killed"].includes(resolved.status)) {
      throw new HydrogenError("INVALID_INPUT", `Agent ${resolved.taskPath} is closed; spawn a new agent instead`);
    }
    if (!promptText.trim() && this.state.countUnreadMail(resolved.agentId) === 0) {
      throw new HydrogenError("INVALID_INPUT", "followup requires prompt or message");
    }

    let entry = this.entries.get(resolved.agentId);
    if (!entry) {
      const existingSession = this.state.getSession(resolved.sessionId);
      const childIdentity: SessionIdentity = {
        sessionId: resolved.sessionId,
        role: existingSession?.role ?? (resolved.tools.includes("fs_patch") || resolved.tools.includes("bash") ? "writer" : "readonly"),
        epoch: existingSession?.epoch ?? identity.epoch,
        depth: existingSession?.depth ?? (identity.depth + 1),
        parentSessionId: identity.sessionId,
        agentId: resolved.agentId,
        taskPath: resolved.taskPath,
      };
      this.persistPermissions(childIdentity.sessionId, resolved.tools, resolved.writeScope);
      const worktreePath = this.getWorktreePathByAgentId(resolved.agentId);
      entry = {
        record: { ...resolved },
        identity: childIdentity,
        parentSessionId: identity.sessionId,
        workline: this.workline(),
        worktreePath,
        controller: new AbortController(),
        interruptMode: "none",
        finished: Promise.resolve(this.snapshot(resolved)),
        syncWait: input.wait ?? true,
        wake: input.wake ?? "never",
      };
      this.entries.set(resolved.agentId, entry);
    }

    if (BUSY_STATUSES.has(entry.record.status)) {
      if (!input.interrupt) {
        throw new HydrogenError("INVALID_INPUT", `Agent ${entry.record.taskPath} is currently ${entry.record.status}`);
      }
      await this.interrupt(entry.record.agentId);
    }

    const wait = input.wait ?? true;
    if (input.model?.trim() || input.effort?.trim()) {
      const nextModel = this.resolveSubagentModel(input.model?.trim() || entry.record.model, input.effort);
      if (nextModel !== entry.record.model) {
        entry.record.model = nextModel;
        if (entry.handle && this.adapter.setModel) {
          await this.adapter.setModel(entry.handle, nextModel);
        }
      }
    }
    const nextScope = input.writeScope !== undefined && entry.worktreePath
      ? [...new Set([...input.writeScope, entry.worktreePath])]
      : (input.writeScope ?? entry.record.writeScope);
    if (input.tools !== undefined) {
      const { tools, sessionRole } = resolveToolsAndRole(
        input.tools,
        entry.record.role,
        nextScope,
        {
          disableAgentMessage: Boolean(input.disableAgentMessage),
          enableAgentMessage: Boolean(input.enableAgentMessage),
          asyncMode: !wait,
          forceWriter: Boolean(entry.worktreePath),
        },
      );
      entry.record.tools = tools;
      entry.record.writeScope = nextScope;
      entry.identity = { ...entry.identity, role: sessionRole };
      this.persistPermissions(entry.identity.sessionId, tools, nextScope);
    } else if (input.writeScope !== undefined) {
      entry.record.writeScope = nextScope;
      this.persistPermissions(entry.identity.sessionId, entry.record.tools, nextScope);
    }
    entry.parentSessionId = identity.sessionId;
    entry.controller = new AbortController();
    entry.interruptMode = "none";
    entry.syncWait = wait;
    entry.wake = input.wake ?? "never";
    entry.record.status = "queued";
    this.save(entry);

    return this.launchTurn(entry, promptText, wait, input.timeoutMs, signal);
  }

  private async launchTurn(
    entry: LiveAgentEntry,
    promptText: string,
    wait: boolean,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<SubagentResult> {
    const abort = () => {
      if (entry.interruptMode === "none") entry.interruptMode = "interrupt";
      entry.controller.abort(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    entry.finished = this.runTurn(entry, promptText).finally(() => signal?.removeEventListener("abort", abort));

    if (wait) {
      if (timeoutMs === undefined) return entry.finished;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          entry.finished,
          new Promise<SubagentResult>(resolve => {
            timer = setTimeout(() => resolve(this.snapshot(entry.record)), timeoutMs);
          }),
        ]);
      } finally { clearTimeout(timer); }
    }
    return this.snapshot(entry.record);
  }

  private clearIdleTimer(entry: LiveAgentEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  private scheduleIdleHibernate(entry: LiveAgentEntry): void {
    this.clearIdleTimer(entry);
    if (this.closing || entry.record.status !== "idle" || !entry.handle) return;
    const timer = setTimeout(() => {
      if (entry.idleTimer === timer) entry.idleTimer = undefined;
      void this.hibernateEntry(entry);
    }, LIMITS.SUBAGENT_IDLE_TTL_MS);
    timer.unref?.();
    entry.idleTimer = timer;
  }

  private async hibernateEntry(entry: LiveAgentEntry): Promise<void> {
    this.clearIdleTimer(entry);
    if (entry.record.status !== "idle" || !entry.handle) return;
    const handle = entry.handle;
    entry.handle = undefined;
    const pending = (async () => {
      try {
        await this.adapter.close(handle);
      } catch (error) {
        this.state.appendEvent("agent.hibernate_error", entry.record.agentId, { message: String(error) });
      }
    })();
    entry.hibernating = pending;
    try {
      await pending;
    } finally {
      if (entry.hibernating === pending) entry.hibernating = undefined;
    }
  }

  private async evictExcessIdleHandles(): Promise<void> {
    const idleHandles = [...this.entries.values()]
      .filter(entry => entry.handle && entry.record.status === "idle")
      .sort((a, b) => (a.record.updatedAt - b.record.updatedAt) || (a.record.createdAt - b.record.createdAt));
    while (idleHandles.length > LIMITS.MAX_WARM_IDLE_SUBAGENTS) {
      const oldest = idleHandles.shift()!;
      await this.hibernateEntry(oldest);
    }
  }

  private async openSubagent(
    identity: SessionIdentity,
    opts: {
      model?: string;
      allowedTools?: SubagentToolName[];
      resumeSessionId?: string;
      cwd?: string;
      agentId?: string;
      taskPath?: string;
      role?: string;
      writeScope?: string[];
      roleGuidance?: string;
    },
  ): Promise<ManagedSessionHandle> {
    const openOptsBase = this.options(identity, {
      model: opts.model,
      tools: opts.allowedTools,
      agentId: opts.agentId,
      taskPath: opts.taskPath,
      role: opts.role,
      writeScope: opts.writeScope,
      cwd: opts.cwd,
      resumeSessionId: opts.resumeSessionId,
    });
    const openOpts: SessionOpenOptions = {
      ...openOptsBase,
      cwd: opts.cwd ?? openOptsBase.cwd,
      model: opts.model ?? openOptsBase.model,
      resumeSessionId: opts.resumeSessionId ?? openOptsBase.resumeSessionId,
      env: {
        ...openOptsBase.env,
        ...(opts.allowedTools ? { HYDROGEN_ALLOWED_TOOLS: opts.allowedTools.join(",") } : {}),
        ...(opts.agentId ? { HYDROGEN_AGENT_ID: opts.agentId } : {}),
        ...(opts.taskPath ? { HYDROGEN_TASK_PATH: opts.taskPath } : {}),
      },
      appendSystemPrompt: openOptsBase.appendSystemPrompt,
    };
    return this.adapter.open(openOpts);
  }

  private async runTurn(entry: LiveAgentEntry, promptText: string): Promise<SubagentResult> {
    this.clearIdleTimer(entry);
    if (entry.hibernating) {
      await entry.hibernating;
    }
    const wasColdResume = !entry.handle && entry.record.turnCount > 0;
    const previousSummary = entry.record.summary.trim();

    let releaseSlot: (() => void) | undefined;
    let releaseTurn: (() => void) | undefined;
    const signal = entry.controller.signal;
    let cancelledOp: Promise<void> | undefined;
    const onAbort = () => {
      if (!entry.handle) return;
      if (entry.interruptMode === "close") {
        cancelledOp = this.adapter.close(entry.handle).catch(error => {
          this.state.appendEvent("agent.close_error", entry.record.agentId, { message: String(error) });
        });
      } else {
        cancelledOp = this.adapter.cancel(entry.handle).catch(error => {
          this.state.appendEvent("agent.cancel_error", entry.record.agentId, { message: String(error) });
        });
      }
    };
    let errorMessage: string | undefined;
    try {
      releaseSlot = await this.slots.acquire(signal);
      releaseTurn = await agyTurns.acquire(signal);
      signal.throwIfAborted();

      this.state.registerSession({ ...entry.identity, reuseKey: entry.record.reuseKey ?? undefined, status: "opening" });
      let openedFreshHandle = false;
      if (!entry.handle) {
        entry.handle = await this.openSubagent(entry.identity, {
          model: entry.record.model,
          allowedTools: entry.record.tools,
          resumeSessionId: entry.record.conversationId || undefined,
          cwd: entry.worktreePath,
          agentId: entry.record.agentId,
          taskPath: entry.record.taskPath,
          role: entry.record.role,
          writeScope: entry.record.writeScope,
        });
        openedFreshHandle = entry.handle.resumed !== true;
      }
      signal.throwIfAborted();

      entry.record.conversationId = entry.handle.conversationId;
      entry.record.turnCount += 1;
      entry.record.status = "running";
      this.state.registerSession({
        ...entry.identity,
        conversationId: entry.handle.conversationId,
        reuseKey: entry.record.reuseKey ?? undefined,
        status: "running",
      });
      this.save(entry);

      const mails = this.state.drainMail({ recipientId: entry.record.agentId, rootId: entry.record.rootId });
      const contractHeader = entry.record.turnCount === 1 || openedFreshHandle
        ? `[SUBAGENT_CONTRACT]\n${buildRoleGuidance(entry.record, entry.worktreePath)}\n[/SUBAGENT_CONTRACT]`
        : "";
      const resumeContext = wasColdResume && entry.handle.resumed !== true && previousSummary
        ? `[PREVIOUS_SUBAGENT_SUMMARY]\n${previousSummary}\n[/PREVIOUS_SUBAGENT_SUMMARY]`
        : "";
      const mailContext = mails.length > 0 ? formatMailboxNotification(mails) : "";
      const fullPrompt = [contractHeader, resumeContext, mailContext, promptText.trim()].filter(Boolean).join("\n\n");

      signal.addEventListener("abort", onAbort, { once: true });
      let bytes = 0;
      let currentUsage: SessionUsage | undefined;
      const activePolicy = this.policyFor(entry.worktreePath);
      const result = await this.adapter.prompt(entry.handle, fullPrompt, event => {
        if (event.type === "text_delta") bytes += Buffer.byteLength(event.text);
        if (event.type === "usage") currentUsage = event.usage;
        if (event.type === "permission_request") {
          let approved = entry.identity.role === "writer" || entry.record.tools.length > 0;
          let reason: string | undefined;
          if (activePolicy) {
            const decision = activePolicy.preToolUse(entry.identity.sessionId, {
              hookEventName: "PreToolUse",
              toolCall: {
                id: event.requestId,
                name: event.toolName,
                args: event.rawInput as Record<string, unknown> | undefined,
              },
            });
            approved = decision.decision !== "deny";
            reason = decision.reason;
          }
          void this.adapter.respondPermission?.(entry.handle!, event.requestId, { approved, reason });
        }
      }, signal);

      const usage = result.usage ?? currentUsage;
      this.state.recordTurn(entry.identity.sessionId, usage?.inputTokens ?? 0, bytes, fullPrompt.length);
      if (entry.interruptMode === "close" || this.closing) {
        entry.record.status = "closed";
      } else if (result.aborted || signal.aborted || entry.interruptMode === "interrupt") {
        entry.record.status = "interrupted";
      } else {
        entry.record.status = "idle";
      }
      this.summarize(entry, result.finalText);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      if (entry.interruptMode === "close" || this.closing) {
        entry.record.status = "closed";
      } else if (signal.aborted || entry.interruptMode === "interrupt") {
        entry.record.status = "interrupted";
      } else {
        entry.record.status = "failed";
      }
      this.summarize(entry, errorMessage);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await cancelledOp;
      // Preserve live persistent handle for idle/interrupted sessions; close only on closed/failed.
      if ((entry.record.status === "closed" || entry.record.status === "failed") && entry.handle) {
        try { await this.adapter.close(entry.handle); }
        catch (error) { this.state.appendEvent("agent.close_error", entry.record.agentId, { message: String(error) }); }
        entry.handle = undefined;
      }
      releaseTurn?.();
      releaseSlot?.();
      this.state.setSessionStatus(entry.identity.sessionId, entry.record.status);
      this.save(entry);
      if (entry.record.status === "idle" && entry.handle) {
        this.scheduleIdleHibernate(entry);
        await this.evictExcessIdleHandles().catch(error => {
          this.state.appendEvent("agent.hibernate_error", entry.record.agentId, { message: String(error) });
        });
      }

      const parentRecord = entry.record.parentId !== "/root" ? this.state.getSubagent(entry.record.parentId) : undefined;
      const parentPath = parentRecord ? parentRecord.taskPath : "/root";
      if (entry.record.status === "idle" || entry.record.status === "failed") {
        const message = entry.record.status === "idle"
          ? entry.record.summary
          : (errorMessage || entry.record.summary || "Turn failed");
        const shouldEnqueueToParentMailbox =
          entry.record.parentId !== "/root" || !entry.syncWait || entry.wake === "next_turn";
        if (shouldEnqueueToParentMailbox) {
          this.state.enqueueMail({
            rootId: entry.record.rootId,
            senderPath: entry.record.taskPath,
            recipientId: entry.record.parentId,
            recipientPath: parentPath,
            content: message,
            messageType: "FINAL_ANSWER",
          });
        }
        this.state.appendEvent("FINAL_ANSWER", entry.record.agentId, {
          rootId: entry.record.rootId,
          agentId: entry.record.agentId,
          taskPath: entry.record.taskPath,
          parentId: entry.record.parentId,
          senderPath: entry.record.taskPath,
          recipientId: entry.record.parentId,
          recipientPath: parentPath,
          status: entry.record.status,
          turn: entry.record.turnCount,
          message,
          outputRef: entry.record.outputRef,
        });
      } else if (entry.record.status === "interrupted") {
        this.state.appendEvent("TURN_COMPLETED", entry.record.agentId, {
          rootId: entry.record.rootId,
          agentId: entry.record.agentId,
          taskPath: entry.record.taskPath,
          status: "interrupted",
          turn: entry.record.turnCount,
        });
      }
    }
    return this.snapshot(entry.record);
  }

  async wait(input: AgentWaitInput): Promise<{
    noProgress?: true;
    events: unknown[];
    cursor: number;
    nextSeq: number;
    timedOut: boolean;
    agents?: SubagentResult[];
  }> {
    const rootId = input.rootId ?? this.resolveRootId();
    const callerPath = input.callerPath ?? "/root";
    const allInRoot = this.state.listSubagents(rootId);
    let watchedRecords: SubagentRecord[];
    if (input.agentIds && input.agentIds.length > 0) {
      watchedRecords = input.agentIds.map(ref => this.state.resolveAgent(ref, { rootId, callerPath }));
    } else if (callerPath === "/root") {
      watchedRecords = allInRoot;
    } else {
      watchedRecords = allInRoot.filter(a => a.taskPath.startsWith(`${callerPath}/`));
    }
    const watchedIds = new Set(watchedRecords.map(r => r.agentId));
    const cursorKey = JSON.stringify([rootId, callerPath, [...watchedIds].sort()]);
    const afterSeq = input.afterSeq ?? this.state.getWaitCursor(cursorKey);
    const timeoutMs = input.timeoutMs ?? LIMITS.DEFAULT_WAIT_TIMEOUT_MS;

    const matches = (event: { type: string; agentId: string | null; payload: unknown }): boolean => {
      if (!WAIT_EVENT_TYPES.has(event.type)) return false;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (payload.rootId && payload.rootId !== rootId) return false;
      if (event.type === "TURN_COMPLETED" && (payload.status === "idle" || payload.status === "failed")) {
        return false;
      }
      if ((event.type === "MESSAGE" || event.type === "BROADCAST") && payload.senderPath === callerPath) {
        return false;
      }
      if (input.agentIds && input.agentIds.length > 0) {
        return (event.agentId !== null && watchedIds.has(event.agentId))
          || (typeof payload.recipientId === "string" && watchedIds.has(payload.recipientId));
      }
      return (event.agentId !== null && watchedIds.has(event.agentId))
        || (typeof payload.recipientId === "string" && (watchedIds.has(payload.recipientId) || (callerPath === "/root" && payload.recipientId === "/root")));
    };

    const isAllTerminal = (): boolean => {
      const current = watchedIds.size > 0
        ? [...watchedIds].map(id => this.state.getSubagent(id)).filter((r): r is SubagentRecord => Boolean(r))
        : [];
      return current.every(r => TERMINAL_OR_IDLE.has(r.status) || !BUSY_STATUSES.has(r.status));
    };

    const existing = this.state.readEvents(afterSeq).events.filter(matches);
    const hasBusy = watchedRecords.some(r => BUSY_STATUSES.has(r.status));

    if (!input.waitAll && existing.length > 0) {
      const lastSeq = existing[existing.length - 1].seq;
      if (input.afterSeq === undefined) this.state.setWaitCursor(cursorKey, lastSeq);
      return { events: existing, cursor: lastSeq, nextSeq: lastSeq, timedOut: false };
    }

    if (!hasBusy && existing.length === 0) {
      return {
        noProgress: true,
        events: [],
        cursor: afterSeq,
        nextSeq: afterSeq,
        timedOut: false,
        ...(input.waitAll ? { agents: watchedRecords.map(r => this.snapshot(r)) } : {}),
      };
    }

    const predicate = input.waitAll
      ? () => isAllTerminal()
      : (events: Array<{ type: string; agentId: string | null; payload: unknown }>) => events.some(matches);

    const allEventsAfter = await this.state.waitUntil(predicate, afterSeq, timeoutMs);
    const matched = allEventsAfter.filter(matches);
    const lastSeq = matched.length > 0 ? matched[matched.length - 1].seq : afterSeq;
    if (input.afterSeq === undefined && lastSeq > afterSeq) {
      this.state.setWaitCursor(cursorKey, lastSeq);
    }

    if (input.waitAll) {
      const latestAgents = [...watchedIds]
        .map(id => this.state.getSubagent(id))
        .filter((r): r is SubagentRecord => Boolean(r))
        .map(r => this.snapshot(r));
      const allDone = latestAgents.every(r => !BUSY_STATUSES.has(r.status));
      return {
        events: matched,
        cursor: lastSeq,
        nextSeq: lastSeq,
        timedOut: !allDone,
        agents: latestAgents,
      };
    }

    return {
      events: matched,
      cursor: lastSeq,
      nextSeq: lastSeq,
      timedOut: matched.length === 0,
    };
  }

  message(identity: SessionIdentity, input: AgentMessageInput): Record<string, unknown> {
    if (this.closing) throw new HydrogenError("INVALID_INPUT", "Agent manager is closing");
    const isWildcard = (value: string): boolean => {
      const trimmed = value.trim();
      return trimmed === "@all" || trimmed === "*";
    };
    const action = input.action ?? (
      (typeof input.to === "string" && isWildcard(input.to))
      || (Array.isArray(input.to) && input.to.some(isWildcard))
        ? "broadcast"
        : "send"
    );

    if (action === "read") {
      const messages = this.drainMailboxForSession(identity.sessionId);
      return {
        ok: true,
        action: "read",
        count: messages.length,
        messages,
      };
    }

    if (action !== "send" && action !== "broadcast") {
      throw new HydrogenError("INVALID_INPUT", `Unknown agent_message action: ${String(action)}`);
    }

    const content = input.message?.trim();
    if (!content) {
      throw new HydrogenError("INVALID_INPUT", "agent_message requires a non-empty message");
    }

    const caller = this.callerContext(identity);
    const hasWildcardTarget =
      (typeof input.to === "string" && isWildcard(input.to)) ||
      (Array.isArray(input.to) && input.to.some(isWildcard));
    const hasExplicitTarget = Array.isArray(input.to)
      ? input.to.some(v => v.trim().length > 0 && !isWildcard(v))
      : Boolean(input.to?.trim()) && !hasWildcardTarget;
    const isBroadcastAll = hasWildcardTarget || (action === "broadcast" && !hasExplicitTarget);
    const messageType = action === "broadcast" || isBroadcastAll ? "BROADCAST" : "MESSAGE";

    const recipients: Array<{ recipientId: string; recipientPath: string }> = [];
    const seen = new Set<string>();
    const addRecipient = (recipientId: string, recipientPath: string) => {
      if (recipientId === caller.callerId || seen.has(recipientId)) return;
      seen.add(recipientId);
      recipients.push({ recipientId, recipientPath });
    };

    if (isBroadcastAll) {
      const activeSubagents = this.state
        .listSubagents(caller.rootId)
        .filter(agent => ACTIVE_BROADCAST_STATUSES.has(agent.status) && agent.agentId !== caller.callerId);
      for (const sub of activeSubagents) {
        addRecipient(sub.agentId, sub.taskPath);
      }
      if (caller.callerId !== "/root") {
        addRecipient("/root", "/root");
      }
    } else {
      const rawTargets = Array.isArray(input.to) ? input.to : (input.to ? [input.to] : []);
      const targets = rawTargets.map(t => t.trim()).filter(Boolean);
      if (targets.length === 0) {
        throw new HydrogenError("INVALID_INPUT", "agent_message send requires 'to' target(s)");
      }
      const singleTarget = targets.length === 1;
      for (const targetRef of targets) {
        if (targetRef === "/root" || targetRef === "root") {
          if (caller.callerId === "/root") {
            if (singleTarget) throw new HydrogenError("INVALID_INPUT", "Cannot send message to self (/root)");
            continue;
          }
          addRecipient("/root", "/root");
          continue;
        }
        const resolved = this.state.resolveAgent(targetRef, {
          rootId: caller.rootId,
          callerPath: caller.callerPath,
        });
        if (["closed", "killed"].includes(resolved.status)) {
          throw new HydrogenError("INVALID_INPUT", `Agent ${resolved.taskPath} is ${resolved.status}`);
        }
        if (resolved.agentId === caller.callerId) {
          if (singleTarget) throw new HydrogenError("INVALID_INPUT", `Cannot send message to self (${resolved.taskPath})`);
          continue;
        }
        addRecipient(resolved.agentId, resolved.taskPath);
      }
    }

    const deliveries = this.state.transaction(() =>
      recipients.map(recipient => {
        const mail = this.state.enqueueMail({
          rootId: caller.rootId,
          senderPath: caller.callerPath,
          recipientId: recipient.recipientId,
          recipientPath: recipient.recipientPath,
          content,
          messageType,
        });
        const eventAgentId = recipient.recipientId === "/root"
          ? (caller.callerId === "/root" ? null : caller.callerId)
          : recipient.recipientId;
        const event = this.state.appendEvent(messageType, eventAgentId, {
          rootId: caller.rootId,
          senderId: caller.callerId,
          senderPath: caller.callerPath,
          recipientId: recipient.recipientId,
          recipientPath: recipient.recipientPath,
          mailId: mail.id,
          messageType,
          message: content,
        });
        return {
          id: mail.id,
          seq: event.seq,
          recipientId: recipient.recipientId,
          recipientPath: recipient.recipientPath,
        };
      }),
    );

    return {
      ok: true,
      action,
      messageType,
      senderPath: caller.callerPath,
      count: deliveries.length,
      recipients: deliveries.map(d => d.recipientPath),
      deliveries,
      ...(deliveries.length === 1
        ? {
            id: deliveries[0].id,
            recipientId: deliveries[0].recipientId,
            recipientPath: deliveries[0].recipientPath,
          }
        : {}),
    };
  }

  drainMailboxForSession(sessionId: string, conversationId?: string): AgentMailRecord[] {
    const resolved = this.state.resolveSessionAgent(sessionId, conversationId);
    return this.state.drainMail({
      recipientId: resolved.agentId,
      rootId: resolved.rootId,
    });
  }

  drainMailbox(sessionId: string, conversationId?: string): AgentMailRecord[] {
    return this.drainMailboxForSession(sessionId, conversationId);
  }

  private require(agentId: string): SubagentRecord {
    const record = this.state.getSubagent(agentId);
    if (!record) throw new HydrogenError("INVALID_INPUT", `Unknown agentId: ${agentId}`);
    return record;
  }

  private save(entry: LiveAgentEntry): void {
    entry.record.updatedAt = Date.now();
    this.state.putSubagent(entry.record);
  }

  private summarize(entry: LiveAgentEntry, text: string): void {
    const output = spillOutput(
      this.state.projectRoot,
      `agent_${entry.record.agentId}`,
      text,
      text.length > LIMITS.AGENT_SUMMARY_CHARS ? 0 : Buffer.byteLength(text),
      {
        sessionId: entry.identity.sessionId,
        kind: "agent",
        isError: entry.record.status === "failed",
        commandOrPath: `${entry.record.taskPath} (${entry.record.role})`,
      },
    );
    if (entry.worktreePath) {
      const tag = summarizeWorktreeGit(entry.worktreePath);
      const maxBodyChars = Math.max(0, LIMITS.AGENT_SUMMARY_CHARS - tag.length - 1);
      const body = text.slice(0, maxBodyChars).trimEnd();
      entry.record.summary = body ? `${body}\n${tag}` : tag;
    } else {
      entry.record.summary = text.slice(0, LIMITS.AGENT_SUMMARY_CHARS);
    }
    entry.record.outputRef = output.outputRef ?? null;
  }

  async interrupt(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry) {
      const rec = this.require(agentId);
      if (BUSY_STATUSES.has(rec.status)) {
        this.state.putSubagent({ ...rec, status: "interrupted", updatedAt: Date.now() });
      }
      return;
    }
    if (!BUSY_STATUSES.has(entry.record.status)) return;
    entry.interruptMode = "interrupt";
    entry.controller.abort(new Error("Agent interrupted"));
    await entry.finished.catch(() => {});
  }

  private async cleanupSessionPtyJobs(sessionId: string): Promise<void> {
    const aliveJobs = this.state.listPtyJobs(sessionId).filter(job => job.alive);
    if (aliveJobs.length === 0) return;
    if (this.killSessionPtyJobs) {
      await this.killSessionPtyJobs(sessionId).catch(() => {});
    }
    const remaining = this.state.listPtyJobs(sessionId).filter(job => job.alive);
    await Promise.all(remaining.map(async job => {
      if (job.pgid > 1 && groupAlive(job.pgid)) {
        signalGroup(job.pgid, "SIGTERM");
        const deadline = Date.now() + 1_000;
        while (groupAlive(job.pgid) && Date.now() < deadline) {
          await new Promise<void>(resolve => setTimeout(resolve, 50));
        }
        if (groupAlive(job.pgid)) {
          signalGroup(job.pgid, "SIGKILL");
        }
      }
      this.state.setPtyJobAlive(job.jobId, false);
    }));
  }

  private async closeEntry(entry: LiveAgentEntry): Promise<{ agentId: string; taskPath: string; previousStatus: string; status: "closed" }> {
    this.clearIdleTimer(entry);
    if (entry.hibernating) {
      await entry.hibernating;
    }
    const previousStatus = entry.record.status;
    if (BUSY_STATUSES.has(entry.record.status)) {
      entry.interruptMode = "close";
      entry.controller.abort(new Error("Agent closed"));
      await entry.finished.catch(() => {});
    }
    if (entry.handle) {
      await this.adapter.close(entry.handle).catch(error => {
        this.state.appendEvent("agent.close_error", entry.record.agentId, { message: String(error) });
      });
      entry.handle = undefined;
    }
    await this.cleanupSessionPtyJobs(entry.identity.sessionId);
    entry.record.status = "closed";
    this.state.setWriteScope(entry.identity.sessionId, undefined);
    this.state.setSessionStatus(entry.identity.sessionId, "closed");
    this.save(entry);
    this.entries.delete(entry.record.agentId);
    this.state.appendEvent("CLOSED", entry.record.agentId, {
      rootId: entry.record.rootId,
      agentId: entry.record.agentId,
      taskPath: entry.record.taskPath,
      status: "closed",
    });
    return { agentId: entry.record.agentId, taskPath: entry.record.taskPath, previousStatus, status: "closed" };
  }

  async closeSubtree(agentId: string): Promise<Array<{ agentId: string; taskPath: string; previousStatus: string; status: "closed" }>> {
    const target = this.require(agentId);
    const descendants = this.state.listSubagents(target.rootId).filter(
      a => a.agentId === target.agentId || a.taskPath.startsWith(`${target.taskPath}/`),
    );
    descendants.sort((a, b) => b.taskPath.length - a.taskPath.length);
    const results: Array<{ agentId: string; taskPath: string; previousStatus: string; status: "closed" }> = [];
    for (const node of descendants) {
      const live = this.entries.get(node.agentId);
      if (live) {
        results.push(await this.closeEntry(live));
      } else if (node.status !== "closed") {
        const previousStatus = node.status;
        await this.cleanupSessionPtyJobs(node.sessionId);
        this.state.setWriteScope(node.sessionId, undefined);
        this.state.setSessionStatus(node.sessionId, "closed");
        this.state.putSubagent({ ...node, status: "closed", updatedAt: Date.now() });
        this.state.appendEvent("CLOSED", node.agentId, {
          rootId: node.rootId,
          agentId: node.agentId,
          taskPath: node.taskPath,
          status: "closed",
        });
        results.push({ agentId: node.agentId, taskPath: node.taskPath, previousStatus, status: "closed" });
      } else {
        await this.cleanupSessionPtyJobs(node.sessionId);
        results.push({ agentId: node.agentId, taskPath: node.taskPath, previousStatus: "closed", status: "closed" });
      }
    }
    return results;
  }

  async dispose(): Promise<void> {
    this.closing = true;
    for (const entry of this.entries.values()) {
      this.clearIdleTimer(entry);
    }
    const ids = [...this.entries.keys()];
    await Promise.all(ids.map(id => {
      const entry = this.entries.get(id);
      return entry ? this.closeEntry(entry) : Promise.resolve();
    }));
  }
}
