import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ApprovalMode } from "../core/protocol.js";
import type { HydrogenRuntime } from "../core/runtime.js";
import type { SessionRecord } from "../core/state.js";

const execFileAsync = promisify(execFile);

export interface CommandSpec {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
}

export interface ModelChoice {
  id: string;
  label: string;
}

export interface AgentChoice {
  name: string;
  description: string;
  scope: string;
}

export interface GitSnapshot {
  isGitRepo: boolean;
  branch: string;
  status: string;
  diffStat: string;
  diff: string;
}

export type CommandAction = "clear" | "exit" | "abort" | "rotated" | "reset" | "model_changed";

export type CommandResult =
  | { handled: false }
  | { handled: true; ok: boolean; title: string; output: string; action?: CommandAction };

export const COMMAND_SPECS: CommandSpec[] = [
  { name: "help", aliases: ["h", "?"], usage: "/help", description: "显示全部斜杠命令与快捷键说明" },
  { name: "status", aliases: ["usage", "context"], usage: "/status", description: "查看当前会话、模型、Agent、Epoch 与 300k 上下文进度" },
  { name: "model", aliases: ["models"], usage: "/model [modelId]", description: "查看可用模型或切换当前会话模型" },
  { name: "effort", usage: "/effort [low|medium|high|xhigh]", description: "切换当前模型的推理强度档位 (仿照 agy /effort)" },
  { name: "agent", usage: "/agent [hgy-shell|lean|default]", description: "查看或切换底层 agy 壳 Agent（默认 hgy-shell 零内置工具）" },
  { name: "mode", aliases: ["permissions"], usage: "/mode [plan|auto-edit|full-auto]", description: "查看或设置审批模式 (兼容 accept-edits / auto)" },
  { name: "resume", aliases: ["continue", "threads", "history"], usage: "/resume [id | new <title> | switch <id> | rename <id> <title> | delete <id>]", description: "列出、恢复或管理会话线程 (仿照 agy /resume)" },
  { name: "todos", aliases: ["tasks"], usage: "/todos", description: "查看当前线程待办清单" },
  { name: "compact", aliases: ["rotate"], usage: "/compact [focus | auto on|off | threshold <tokens>]", description: "立即打包检查点轮转 Epoch，或配置 300k 主动压缩阈值" },
  { name: "new", aliases: ["reset"], usage: "/new [title]", description: "清空当前检查点并开启全新主会话线程" },
  { name: "checkpoint", aliases: ["cp", "goal"], usage: "/checkpoint [activeGoal]", description: "查看或更新 HandoffPacket 语义检查点" },
  { name: "agents", usage: "/agents [agentId]", description: "查看 Explorer 子 Agent 列表或详情" },
  { name: "workflows", usage: "/workflows [runId]", description: "查看工作流 (PTC) 执行记录" },
  { name: "jobs", usage: "/jobs", description: "查看托管后台 PTY 命令列表" },
  { name: "diff", aliases: ["git"], usage: "/diff", description: "查看当前仓库 Git 状态与改动摘要" },
  { name: "sh", usage: "/sh <cmd> (或 !<cmd>)", description: "在项目目录内执行托管 Shell 命令" },
  { name: "abort", aliases: ["stop", "cancel"], usage: "/abort", description: "中断当前正在生成的 Turn" },
  { name: "clear", aliases: ["cls"], usage: "/clear", description: "清空当前屏幕并重绘 TUI 状态栏" },
  { name: "exit", aliases: ["quit"], usage: "/exit", description: "退出 hgy TUI 交互模式" },
];

const FALLBACK_MODELS: ModelChoice[] = [
  { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)" },
  { id: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen (XHigh)" },
  { id: "gemini-4-hydrogen-medium", label: "Gemini 4 Hydrogen (Medium)" },
  { id: "gemini-4-hydrogen-low", label: "Gemini 4 Hydrogen (Low)" },
  { id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "claude-sonnet-4-6-thinking", label: "Claude Sonnet 4.6 (Thinking)" },
];

const FALLBACK_AGENTS: AgentChoice[] = [
  { name: "hgy-shell", description: "零内置工具壳 Agent（禁用全部 agy 内置工具与默认提示词，仅挂载 MCP 工具供 hgy 接管）", scope: "user" },
  { name: "lean", description: "精简主控 Agent（剥离内置冗余提示词与无关工具）", scope: "user" },
  { name: "default", description: "agy 原生默认 Agent（包含全部内置工具与提示词）", scope: "builtin" },
];

let modelCache: { expiresAt: number; models: ModelChoice[] } | undefined;

export async function listAvailableModels(force = false): Promise<ModelChoice[]> {
  if (!force && modelCache && Date.now() < modelCache.expiresAt) return modelCache.models;
  try {
    const { stdout } = await execFileAsync("agy", ["models"], { timeout: 8000 });
    const clean = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r[^\n]*/g, "\n");
    const parsed: ModelChoice[] = [];
    for (const rawLine of clean.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("Fetching")) continue;
      const match = /^([a-z0-9][a-z0-9._-]+)\s+(.+)$/i.exec(line);
      if (match) parsed.push({ id: match[1], label: match[2].trim() });
    }
    if (parsed.length > 0) {
      modelCache = { expiresAt: Date.now() + 60_000, models: parsed };
      return parsed;
    }
  } catch { /* Fall back to curated defaults if CLI query fails. */ }
  return FALLBACK_MODELS;
}

export async function listAvailableAgents(): Promise<AgentChoice[]> {
  try {
    const { stdout } = await execFileAsync("agy", ["agents"], { timeout: 5000 });
    const clean = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r[^\n]*/g, "\n");
    const parsed: AgentChoice[] = [];
    let currentScope = "user";
    for (const rawLine of clean.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.toLowerCase().startsWith("user agents")) { currentScope = "user"; continue; }
      if (line.toLowerCase().startsWith("built-in agents")) { currentScope = "builtin"; continue; }
      const match = /^([a-z0-9][a-z0-9._-]+)\s*·\s*(.+)$/i.exec(line);
      if (match) parsed.push({ name: match[1], description: match[2].trim(), scope: currentScope });
    }
    if (parsed.length > 0) {
      parsed.push({ name: "default", description: "不传 --agent，使用 agy 默认主控配置", scope: "builtin" });
      return parsed;
    }
  } catch { /* Fall back to curated defaults. */ }
  return FALLBACK_AGENTS;
}

export function normalizeApprovalMode(raw: string): ApprovalMode | undefined {
  const clean = raw.trim().toLowerCase();
  if (clean === "plan") return "plan";
  if (clean === "auto-edit" || clean === "accept-edits" || clean === "edit") return "auto-edit";
  if (clean === "full-auto" || clean === "auto" || clean === "yolo") return "full-auto";
  return undefined;
}

export function applyEffortToModel(currentModel: string, effort: string): string | undefined {
  const level = effort.trim().toLowerCase();
  if (!["low", "medium", "high", "xhigh"].includes(level)) return undefined;
  if (/-(low|medium|high|xhigh)$/i.test(currentModel)) {
    return currentModel.replace(/-(low|medium|high|xhigh)$/i, `-${level}`);
  }
  if (/^gemini-/i.test(currentModel)) return `${currentModel}-${level}`;
  return undefined;
}

export function parseTokenCount(raw: string): number | undefined {
  const clean = raw.trim().toLowerCase().replace(/_/g, "");
  const match = /^(\d+(?:\.\d+)?)\s*(k|m)?$/i.exec(clean);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  return Math.round(num * multiplier);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 5000, maxBuffer: 512 * 1024 });
  return stdout.trimEnd();
}

export async function getGitSnapshot(projectRoot: string): Promise<GitSnapshot> {
  try {
    const branch = await runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await runGit(projectRoot, ["status", "-sb"]);
    const diffStat = await runGit(projectRoot, ["diff", "--stat"]);
    const rawDiff = await runGit(projectRoot, ["diff"]);
    const diff = rawDiff.length > 24_000 ? `${rawDiff.slice(0, 24_000)}\n... [truncated ${rawDiff.length - 24_000} chars]` : rawDiff;
    return { isGitRepo: true, branch, status, diffStat, diff };
  } catch {
    return { isGitRepo: false, branch: "", status: "", diffStat: "", diff: "" };
  }
}

function findSpec(token: string): CommandSpec | undefined {
  const lower = token.toLowerCase();
  return COMMAND_SPECS.find(spec => spec.name === lower || spec.aliases?.includes(lower));
}

export function formatSessionsList(runtime: HydrogenRuntime): string {
  const threads = runtime.listThreads();
  const sessions = runtime.state.listSessions();
  const writerSessions = sessions.filter(s => s.role === "writer" && s.depth === 0);
  const bySessionId = new Map(sessions.map(s => [s.sessionId, s]));
  const latestByConvId = new Map<string, SessionRecord>();
  for (const s of writerSessions) {
    if (!s.conversationId) continue;
    const prev = latestByConvId.get(s.conversationId);
    if (!prev || s.updatedAt >= prev.updatedAt) latestByConvId.set(s.conversationId, s);
  }
  const latestWriter = [...writerSessions].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];

  const lines: string[] = [];
  const coveredConvIds = new Set<string>();
  const coveredSessIds = new Set<string>();

  for (const thread of threads) {
    const active = thread.threadId === runtime.activeThreadId ? "*" : " ";
    const boundSessId = runtime.state.getMeta(`thread_session:${thread.threadId}`) || undefined;
    const boundConvId = runtime.state.getMeta(`thread_conversation:${thread.threadId}`) || undefined;
    const fallbackSess = threads.length <= 1 ? latestWriter : undefined;
    const sess = (boundSessId ? bySessionId.get(boundSessId) : undefined)
      ?? (boundConvId ? latestByConvId.get(boundConvId) : undefined)
      ?? fallbackSess;
    const convId = boundConvId
      || sess?.conversationId
      || (threads.length <= 1 ? (runtime.state.getMeta("last_conversation_id") || undefined) : undefined);
    if (convId) coveredConvIds.add(convId);
    if (sess?.sessionId) coveredSessIds.add(sess.sessionId);
    const epochStr = sess ? `E${sess.epoch}` : "E-";
    const tokStr = formatTokenShort(sess?.lastInputTokens ?? 0);
    const convDisplay = convId ? convId.slice(0, 12) : "-";
    const ts = new Date(thread.updatedAt).toLocaleString();
    lines.push(
      `${active} ${thread.threadId.slice(0, 8)}  conv=${convDisplay.padEnd(12)}  ${epochStr.padEnd(4)}  tok=${tokStr.padEnd(6)}  [${thread.model}]  ${thread.title}  (${ts})`,
    );
  }

  const orphanWriters = [...writerSessions]
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
    .filter(s => s.conversationId && !coveredConvIds.has(s.conversationId) && !coveredSessIds.has(s.sessionId));
  const seenOrphanConv = new Set<string>();
  for (const s of orphanWriters) {
    if (!s.conversationId || seenOrphanConv.has(s.conversationId)) continue;
    seenOrphanConv.add(s.conversationId);
    const active = s.sessionId === runtime.state.writerSessionId ? "*" : " ";
    const tokStr = formatTokenShort(s.lastInputTokens);
    const ts = new Date(s.updatedAt).toLocaleString();
    lines.push(
      `${active} ${s.sessionId.slice(0, 8)}  conv=${s.conversationId.slice(0, 12).padEnd(12)}  E${String(s.epoch).padEnd(3)}  tok=${tokStr.padEnd(6)}  [${runtime.currentModel}]  (session)  (${ts})`,
    );
  }

  if (lines.length === 0) {
    return "当前工作区暂无可恢复会话。";
  }
  lines.push("", "提示: 使用 hgy -r <id> 或 hgy -c 恢复会话 (支持 threadId / conversationId 前缀)。");
  return lines.join("\n");
}

export function formatTokenShort(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1)}k`;
  return String(tokens);
}

export async function executeSlashOrShell(
  runtime: HydrogenRuntime,
  rawInput: string,
  source: "cli" | "web",
): Promise<CommandResult> {
  const trimmed = rawInput.trim();
  if (!trimmed) return { handled: false };

  if (trimmed.startsWith("!")) {
    const command = trimmed.slice(1).trim();
    return runShellCommand(runtime, command);
  }
  if (!trimmed.startsWith("/")) return { handled: false };

  const space = trimmed.search(/\s/);
  const nameToken = (space < 0 ? trimmed.slice(1) : trimmed.slice(1, space)).trim();
  const arg = space < 0 ? "" : trimmed.slice(space).trim();
  if (!nameToken) return { handled: true, ok: true, title: "/help", output: formatHelp() };

  const spec = findSpec(nameToken);
  if (!spec) {
    return {
      handled: true,
      ok: false,
      title: `/${nameToken}`,
      output: `未知命令: /${nameToken}\n输入 /help 查看全部可用斜杠命令。`,
    };
  }

  switch (spec.name) {
    case "help":
      return { handled: true, ok: true, title: "/help", output: formatHelp() };

    case "status": {
      const writerId = runtime.state.writerSessionId;
      const writer = writerId ? runtime.state.getSession(writerId) : undefined;
      const stats = runtime.contextStats();
      const level = stats.level;
      const cp = runtime.state.getCheckpoint();
      const compactRatio = stats.softTokens > 0 ? ((stats.inputTokens / stats.softTokens) * 100).toFixed(1) : "0.0";
      const lines = [
        `projectRoot     : ${runtime.projectRoot}`,
        `model           : ${runtime.currentModel}`,
        `agent (shell)   : ${runtime.currentAgent}`,
        `thread          : ${runtime.activeThreadId}`,
        `mode            : ${runtime.approvalMode}`,
        `context (300k)  : ${stats.inputTokens.toLocaleString()} / ${stats.softTokens.toLocaleString()} compact target (${compactRatio}%, hard=${stats.hardTokens.toLocaleString()}, rawWindow=${stats.contextWindow.toLocaleString()}, ${stats.source})`,
        `autoCompact     : ${runtime.autoCompact ? "on" : "off"} (threshold=${formatTokenShort(runtime.handover.compactThreshold)})`,
        `epoch           : ${runtime.state.activeEpoch} (level: ${level})`,
        `writer          : ${writerId ?? "-"} [${writer?.status ?? "none"}]`,
        `turns/bytes     : ${writer?.turnCount ?? 0} turns / ${writer?.deltaTextBytes ?? 0} deltaBytes / ${writer?.lastInputTokens ?? 0} inTokens`,
        `activeGoal      : ${cp.activeGoal ?? "-"}`,
        `verifiedFacts   : ${cp.verifiedFacts.length} facts / ${cp.deadEndsTried.length} deadEnds`,
        `subagents       : ${runtime.state.listSubagents().length}`,
        `workflows       : ${runtime.state.listWorkflows().length}`,
        `ptyJobs         : ${runtime.state.listPtyJobs().filter(j => j.alive).length} alive / ${runtime.state.listPtyJobs().length} total`,
      ];
      return { handled: true, ok: true, title: "/status", output: lines.join("\n") };
    }

    case "model": {
      if (!arg) {
        const models = await listAvailableModels();
        const lines = models.map(m => `${m.id === runtime.currentModel ? "* " : "  "}${m.id.padEnd(32)} ${m.label}`);
        return {
          handled: true,
          ok: true,
          title: "/model",
          output: `当前模型: ${runtime.currentModel}\n\n${lines.join("\n")}\n\n切换用法: /model <modelId> 或 /effort <low|medium|high|xhigh>`,
        };
      }
      const next = await runtime.setModel(arg);
      return {
        handled: true,
        ok: true,
        title: `/model ${next}`,
        output: `已切换模型为: ${next}`,
        action: "model_changed",
      };
    }

    case "effort": {
      if (!arg) {
        const currentMatch = /-(low|medium|high|xhigh)$/i.exec(runtime.currentModel);
        return {
          handled: true,
          ok: true,
          title: "/effort",
          output: `当前模型: ${runtime.currentModel} (effort=${currentMatch?.[1] ?? "default"})\n用法: /effort <low|medium|high|xhigh>`,
        };
      }
      const targetModel = applyEffortToModel(runtime.currentModel, arg);
      if (!targetModel) {
        return {
          handled: true,
          ok: false,
          title: "/effort",
          output: `无法将档位 "${arg}" 应用于模型 ${runtime.currentModel}。支持档位: low | medium | high | xhigh`,
        };
      }
      const next = await runtime.setModel(targetModel);
      return {
        handled: true,
        ok: true,
        title: `/effort ${arg}`,
        output: `已切换推理强度 -> 模型: ${next}`,
        action: "model_changed",
      };
    }

    case "agent": {
      if (!arg) {
        const agents = await listAvailableAgents();
        const lines = agents.map(a => `${a.name === runtime.currentAgent ? "* " : "  "}${a.name.padEnd(16)} [${a.scope}] ${a.description}`);
        return {
          handled: true,
          ok: true,
          title: "/agent",
          output: `当前壳 Agent: ${runtime.currentAgent}\n\n${lines.join("\n")}\n\n切换用法: /agent <hgy-shell|lean|default>`,
        };
      }
      const next = await runtime.setAgent(arg);
      return {
        handled: true,
        ok: true,
        title: `/agent ${next}`,
        output: `已切换底层壳 Agent 为: ${next} (Epoch ${runtime.state.activeEpoch})`,
        action: "rotated",
      };
    }

    case "mode": {
      if (!arg) {
        return { handled: true, ok: true, title: "/mode", output: `当前审批模式: ${runtime.approvalMode}\n可选: plan | auto-edit (accept-edits) | full-auto (auto)` };
      }
      const mode = normalizeApprovalMode(arg);
      if (!mode) {
        return { handled: true, ok: false, title: "/mode", output: "用法: /mode [plan|auto-edit|full-auto]" };
      }
      runtime.setApprovalMode(mode);
      return { handled: true, ok: true, title: "/mode", output: `审批模式已设为: ${runtime.approvalMode}` };
    }

    case "todos":
      return { handled: true, ok: true, title: "/todos", output: JSON.stringify(runtime.todos(), null, 2) };

    case "resume": {
      const tokens = arg.split(/\s+/).filter(Boolean);
      const [action, id, ...rest] = tokens;
      if (action === "new") {
        await runtime.createThread([id, ...rest].filter(Boolean).join(" ") || undefined);
      } else if (action === "switch" && id) {
        const target = runtime.resolveResumeTarget(id);
        if (target.threadId) {
          await runtime.switchThread(target.threadId, target.conversationId);
        } else if (target.previousSessionId || runtime.state.listSessions().some(s => s.conversationId === target.conversationId)) {
          await runtime.openMain({ resume: true, resumeConversationId: target.conversationId, previousSessionId: target.previousSessionId });
        } else {
          await runtime.switchThread(id);
        }
      } else if (action === "rename" && id) {
        const match = runtime.listThreads().find(t => t.threadId === id || t.threadId.startsWith(id));
        runtime.renameThread(match ? match.threadId : id, rest.join(" "));
      } else if (action === "delete" && id) {
        const match = runtime.listThreads().find(t => t.threadId === id || t.threadId.startsWith(id));
        await runtime.deleteThread(match ? match.threadId : id);
      } else if (action) {
        const target = runtime.resolveResumeTarget(action);
        const matchedInDb = Boolean(target.threadId || target.previousSessionId);
        if (!matchedInDb) {
          return {
            handled: true,
            ok: false,
            title: "/resume",
            output: `未找到线程或会话 "${action}"。\n用法: /resume [threadId或conversationId前缀 | new <title> | switch <id> | rename <id> <title> | delete <id>]`,
          };
        }
        if (target.threadId) {
          await runtime.switchThread(target.threadId, target.conversationId);
        } else {
          await runtime.openMain({
            resume: true,
            resumeConversationId: target.conversationId,
            previousSessionId: target.previousSessionId,
          });
        }
      }
      return {
        handled: true,
        ok: true,
        title: "/resume",
        output: formatSessionsList(runtime),
      };
    }

    case "compact": {
      if (arg === "auto on" || arg === "auto off") {
        runtime.setAutoCompact(arg === "auto on");
        return {
          handled: true,
          ok: true,
          title: "/compact",
          output: `自动压缩: ${runtime.autoCompact ? "on" : "off"} (主动压缩阈值: ${runtime.handover.compactThreshold.toLocaleString()} tokens)`,
        };
      }
      if (arg.startsWith("threshold")) {
        const rawVal = arg.slice("threshold".length).trim();
        if (!rawVal) {
          return {
            handled: true,
            ok: true,
            title: "/compact threshold",
            output: `当前主动 Compact 阈值: ${runtime.handover.compactThreshold.toLocaleString()} tokens (${formatTokenShort(runtime.handover.compactThreshold)})\n修改用法: /compact threshold <tokens> (如 /compact threshold 300k)`,
          };
        }
        const parsed = parseTokenCount(rawVal);
        if (!parsed) {
          return { handled: true, ok: false, title: "/compact threshold", output: `无效 token 数量: ${rawVal} (示例: 300k 或 300000)` };
        }
        const nextThreshold = runtime.handover.setCompactThreshold(parsed);
        return {
          handled: true,
          ok: true,
          title: "/compact threshold",
          output: `已将主动 Compact 阈值设为: ${nextThreshold.toLocaleString()} tokens (${formatTokenShort(nextThreshold)})`,
        };
      }
      const result = await runtime.compactMain(arg || undefined);
      return {
        handled: true,
        ok: true,
        title: "/compact",
        action: "rotated",
        output: `已主动压缩 ${result.beforeTokens.toLocaleString()} tokens -> Epoch ${result.epoch} (session ${result.newSessionId.slice(0, 8)})\n${result.summary}`,
      };
    }

    case "new": {
      if (arg) {
        const thread = await runtime.createThread(arg);
        return {
          handled: true,
          ok: true,
          title: "/new",
          output: `已创建新线程 "${thread.title}" -> Epoch ${runtime.state.activeEpoch} (session ${runtime.state.writerSessionId?.slice(0, 8) ?? "-"})`,
          action: "reset",
        };
      }
      const nextId = await runtime.resetMain();
      return {
        handled: true,
        ok: true,
        title: "/new",
        output: `已开启全新主会话 -> Epoch ${runtime.state.activeEpoch} (session ${nextId.slice(0, 8)})`,
        action: "reset",
      };
    }

    case "checkpoint": {
      if (arg) {
        const updated = runtime.handover.updateCheckpoint({ activeGoal: arg, nextImmediateStep: arg });
        return { handled: true, ok: true, title: "/checkpoint", output: JSON.stringify(updated, null, 2) };
      }
      return {
        handled: true,
        ok: true,
        title: "/checkpoint",
        output: JSON.stringify(runtime.state.getCheckpoint(), null, 2),
      };
    }

    case "agents": {
      const list = runtime.state.listSubagents();
      if (arg) {
        const found = list.find(a => a.agentId === arg || a.agentId.startsWith(arg) || a.reuseKey === arg);
        if (!found) return { handled: true, ok: false, title: `/agents ${arg}`, output: `未找到 Subagent: ${arg}` };
        return { handled: true, ok: true, title: `/agents ${found.agentId.slice(0, 8)}`, output: JSON.stringify(found, null, 2) };
      }
      if (!list.length) return { handled: true, ok: true, title: "/agents", output: "暂无 Explorer 子 Agent 记录。" };
      return {
        handled: true,
        ok: true,
        title: "/agents",
        output: list.map(a => `${a.agentId.slice(0, 8)} [${a.status}] key=${a.reuseKey ?? "-"} :: ${a.summary.slice(0, 100)}`).join("\n"),
      };
    }

    case "workflows": {
      const list = runtime.state.listWorkflows();
      if (arg) {
        const found = list.find(w => w.runId === arg || w.runId.startsWith(arg));
        if (!found) return { handled: true, ok: false, title: `/workflows ${arg}`, output: `未找到 Workflow: ${arg}` };
        return { handled: true, ok: true, title: `/workflows ${found.runId.slice(0, 8)}`, output: JSON.stringify(found, null, 2) };
      }
      if (!list.length) return { handled: true, ok: true, title: "/workflows", output: "暂无 Workflow (PTC) 记录。" };
      return {
        handled: true,
        ok: true,
        title: "/workflows",
        output: list.map(w => `${w.runId.slice(0, 8)} [${w.status}] steps=${w.steps.length} :: ${w.summary.slice(0, 100)}`).join("\n"),
      };
    }

    case "jobs": {
      const jobs = runtime.state.listPtyJobs();
      if (!jobs.length) return { handled: true, ok: true, title: "/jobs", output: "暂无托管 PTY 任务。" };
      return {
        handled: true,
        ok: true,
        title: "/jobs",
        output: jobs.map(j => `${j.jobId.slice(0, 8)} [${j.alive ? "alive" : "done"}] ${j.command}`).join("\n"),
      };
    }

    case "diff": {
      const snap = await getGitSnapshot(runtime.projectRoot);
      if (!snap.isGitRepo) return { handled: true, ok: false, title: "/diff", output: "当前目录不是 Git 仓库。" };
      const sections = [`branch: ${snap.branch}`, snap.status || "(clean)"];
      if (snap.diffStat) sections.push("\n" + snap.diffStat);
      if (snap.diff) sections.push("\n" + snap.diff);
      return { handled: true, ok: true, title: "/diff", output: sections.join("\n") };
    }

    case "sh":
      return runShellCommand(runtime, arg);

    case "abort":
      await runtime.cancelMain();
      return { handled: true, ok: true, title: "/abort", output: "已发送中断信号。", action: "abort" };

    case "clear":
      return { handled: true, ok: true, title: "/clear", output: "已清空视图。", action: "clear" };

    case "exit":
      if (source === "web") {
        return { handled: true, ok: true, title: "/exit", output: "WebUI 模式下请在终端按 Ctrl+C 停止服务。" };
      }
      return { handled: true, ok: true, title: "/exit", output: "Bye.", action: "exit" };

    default:
      return { handled: false };
  }
}

async function runShellCommand(runtime: HydrogenRuntime, command: string): Promise<CommandResult> {
  if (!command) return { handled: true, ok: false, title: "/sh", output: "用法: /sh <command> 或 !<command>" };
  const writerId = runtime.state.writerSessionId;
  if (!writerId) return { handled: true, ok: false, title: `! ${command}`, output: "主会话尚未就绪。" };
  const res = await runtime.processes.execute(writerId, { action: "exec", command, yieldMs: 8000 });
  const footer = `[job=${res.jobId.slice(0, 8)} ${res.alive ? "running in background" : `exit=${res.exitCode ?? res.signal ?? 0}`}]${res.outputRef ? ` full=${res.outputRef}` : ""}`;
  const body = res.inlineText ? `${res.inlineText.trimEnd()}\n\n${footer}` : footer;
  return { handled: true, ok: (res.exitCode ?? 0) === 0, title: `$ ${command}`, output: body };
}

export function formatHelp(): string {
  const rows = COMMAND_SPECS.map(spec => {
    const aliasText = spec.aliases?.length ? ` (${spec.aliases.map(a => "/" + a).join(", ")})` : "";
    return `  ${(spec.usage + aliasText).padEnd(44)} ${spec.description}`;
  });
  return [
    "Hydrogen TUI (hgy) 斜杠命令与快捷键:",
    "",
    ...rows,
    "",
    "快捷键与技巧:",
    "  !<command>      直接执行项目目录受管 Shell 命令 (如 !git status)",
    "  \\ (行尾)        多行输入续行",
    "  Tab             斜杠命令与参数自动补全",
    "  Ctrl+C          生成中按一次中断当前 Turn；空闲时退出 TUI",
    "  Ctrl+D          退出 TUI",
  ].join("\n");
}
