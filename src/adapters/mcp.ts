import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DaemonMethod, SessionRole, SubagentToolName } from "../core/protocol.js";
import { IpcClient } from "./ipc-client.js";

const SUBAGENT_TOOL_ENUM = z.enum([
  "fs_read",
  "fs_glob",
  "fs_grep",
  "fs_patch",
  "bash",
  "agent_message",
  "todo_write",
]);

type TopLevelToolName = SubagentToolName | "agent_dispatch";

function formatMessageResult(r: {
  action?: string;
  ok?: boolean;
  messageType?: string;
  id?: string;
  senderPath?: string;
  recipientId?: string;
  recipientPath?: string;
  count?: number;
  recipients?: string[];
  messages?: Array<{ messageType?: string; senderPath?: string; recipientPath?: string; content?: string }>;
}): string | undefined {
  if (r.action === "read" && Array.isArray(r.messages)) {
    if (r.messages.length === 0) return "[mailbox: empty]";
    const items = r.messages.map(m =>
      `[${m.messageType ?? "MESSAGE"}] ${m.senderPath ?? ""} -> ${m.recipientPath ?? ""}:\n${m.content ?? ""}`,
    );
    return `[mailbox: ${r.messages.length} unread]\n${items.join("\n\n")}`;
  }
  if (r.ok && (Array.isArray(r.recipients) || r.recipientPath)) {
    const count = r.count ?? (Array.isArray(r.recipients) ? r.recipients.length : 1);
    const kind = (r.messageType ?? "MESSAGE").toLowerCase();
    if (count === 0) return `[${kind}: ${r.senderPath ?? "/root"} -> 0 active recipients]`;
    if (count === 1 && r.recipientPath) {
      return `[sent (${kind}): ${r.senderPath ?? "/root"} -> ${r.recipientPath} (${r.recipientId ?? ""}) | id: ${r.id ?? ""}]`;
    }
    const targets = r.recipients?.join(", ") ?? r.recipientPath ?? "";
    return `[${kind}: ${r.senderPath ?? "/root"} -> ${count} recipients (${targets})]`;
  }
  return undefined;
}

export function parseAllowedToolsEnv(raw = process.env.HYDROGEN_ALLOWED_TOOLS): Set<string> | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return new Set<string>();
  return new Set(trimmed.split(",").map(item => item.trim()).filter(Boolean));
}

export function formatToolResult(method: DaemonMethod, result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "";

  switch (method) {
    case "tool.fsRead": {
      const r = result as {
        path?: string;
        startLine?: number;
        endLine?: number;
        totalLines?: number;
        sha256?: string;
        truncated?: boolean;
        outputRef?: string;
        content?: string;
        inlineText?: string;
      };
      const sha = r.sha256 ? String(r.sha256).slice(0, 12) : "";
      const body = r.content ?? r.inlineText ?? "";
      return `[file: ${r.path ?? ""} | lines: ${r.startLine ?? 1}-${r.endLine ?? 0} of ${r.totalLines ?? 0} | sha256: ${sha}${
        r.truncated ? ` | shadow: ${r.outputRef}` : ""
      }]\n${body}`;
    }

    case "tool.fsGlob": {
      if (Array.isArray(result)) {
        return `${result.join("\n")}\n[matched ${result.length} paths]`;
      }
      const r = result as {
        paths?: string[];
        count?: number;
        truncated?: boolean;
        outputRef?: string;
      };
      const paths = r.paths ?? [];
      return `${paths.join("\n")}\n[matched ${r.count ?? paths.length} paths${
        r.truncated ? ` (truncated, shadow: ${r.outputRef})` : ""
      }]`;
    }

    case "tool.fsGrep": {
      const r = result as {
        output?: string;
        inlineText?: string;
        exitCode?: number;
        truncated?: boolean;
        outputRef?: string;
      };
      const text = typeof r.output === "string"
        ? r.output
        : typeof r.inlineText === "string"
          ? r.inlineText
          : JSON.stringify(result);
      return `${text}\n[exit: ${r.exitCode ?? 0}${r.truncated ? ` | shadow: ${r.outputRef}` : ""}]`;
    }

    case "tool.fsPatch": {
      const r = result as {
        op?: string;
        path?: string;
        sha256?: string;
        observation?: { sha256?: string };
      };
      const sha = r.sha256 ?? r.observation?.sha256;
      return `[ok: ${r.op ?? "patch"} ${r.path ?? ""}${sha ? ` | sha256: ${String(sha).slice(0, 12)}` : ""}]`;
    }

    case "tool.bash": {
      const r = result as {
        jobId?: string;
        alive?: boolean;
        exitCode?: number | null;
        outputRef?: string;
        output?: string;
        inlineText?: string;
      };
      const body = r.output ?? r.inlineText ?? "";
      return `[job: ${r.jobId ?? ""} | status: ${
        r.alive ? "running (background)" : `exited (${r.exitCode ?? 0})`
      }${r.outputRef ? ` | shadow: ${r.outputRef}` : ""}]\n${body}`;
    }

    case "tool.agentDispatch": {
      if (Array.isArray(result)) {
        if (result.length === 0) return "[subagents: none]";
        return result.map((item, idx) => {
          const t = item as {
            role?: string;
            agentId?: string;
            taskPath?: string;
            nickname?: string;
            status?: string;
            turnCount?: number;
            unreadMailCount?: number;
            tools?: string[];
            worktreePath?: string;
            summary?: string;
            outputRef?: string | null;
          };
          const toolsStr = t.tools?.length ? ` | tools: [${t.tools.join(",")}]` : "";
          const mailStr = t.unreadMailCount ? ` | mail: ${t.unreadMailCount}` : "";
          const wtStr = t.worktreePath ? ` | worktree: ${t.worktreePath}` : "";
          return `### Subagent #${idx + 1} (${t.taskPath ?? t.agentId ?? ""} | ${t.nickname ?? t.role ?? ""} | ${t.status ?? ""} | turns: ${t.turnCount ?? 0}${toolsStr}${mailStr}${wtStr}${
            t.outputRef ? ` | shadow: ${t.outputRef}` : ""
          })\n${t.summary ?? ""}`;
        }).join("\n\n");
      }
      const r = result as {
        tasks?: Array<{
          agentId?: string;
          taskPath?: string;
          nickname?: string;
          role?: string;
          model?: string;
          tools?: string[];
          worktreePath?: string;
          status?: string;
          turnCount?: number;
          summary?: string;
          outputRef?: string | null;
        }>;
        closed?: Array<{
          agentId?: string;
          taskPath?: string;
          previousStatus?: string;
          status?: string;
        }>;
        events?: Array<{ seq?: number; type?: string; agentId?: string | null; payload?: Record<string, unknown> }>;
        agents?: Array<{ agentId?: string; taskPath?: string; status?: string; summary?: string }>;
        cursor?: number;
        timedOut?: boolean;
        noProgress?: boolean;
        action?: string;
        ok?: boolean;
        messageType?: string;
        id?: string;
        senderPath?: string;
        recipientId?: string;
        recipientPath?: string;
        count?: number;
        recipients?: string[];
        agentId?: string;
        taskPath?: string;
        nickname?: string;
        role?: string;
        tools?: string[];
        worktreePath?: string;
        status?: string;
        turnCount?: number;
        unreadMailCount?: number;
        summary?: string;
        outputRef?: string | null;
      };
      if (Array.isArray(r.tasks)) {
        return r.tasks.map((t, idx) =>
          `### Subagent #${idx + 1} (${t.taskPath ?? t.agentId ?? ""} | ${t.nickname ?? t.role ?? ""} | ${t.status ?? ""}${
            t.tools?.length ? ` | tools: [${t.tools.join(",")}]` : ""
          }${t.worktreePath ? ` | worktree: ${t.worktreePath}` : ""}${t.outputRef ? ` | shadow: ${t.outputRef}` : ""})\n${t.summary ?? ""}`,
        ).join("\n\n");
      }
      if (Array.isArray(r.closed)) {
        return r.closed.map(c => `[closed: ${c.taskPath ?? c.agentId} (${c.previousStatus ?? ""} -> ${c.status ?? "closed"})]`).join("\n");
      }
      if (Array.isArray(r.events)) {
        const header = `[wait: cursor=${r.cursor ?? 0} | timedOut=${Boolean(r.timedOut)}${r.noProgress ? " | noProgress=true" : ""} | events=${r.events.length}]`;
        const evLines = r.events.map(ev => {
          const p = ev.payload ?? {};
          const path = typeof p.taskPath === "string" ? p.taskPath : (typeof p.senderPath === "string" ? p.senderPath : (ev.agentId ?? ""));
          const msg = typeof p.message === "string" ? p.message : JSON.stringify(p);
          return `- #${ev.seq ?? "?"} [${ev.type ?? "EVENT"}] ${path}: ${msg}`;
        });
        const agentLines = Array.isArray(r.agents)
          ? r.agents.map(a => `  * ${a.taskPath ?? a.agentId} (${a.status}): ${a.summary ?? ""}`)
          : [];
        return [header, ...evLines, ...agentLines].join("\n");
      }
      const formattedMail = formatMessageResult(r);
      if (formattedMail !== undefined) return formattedMail;
      const metaParts = [
        `agent: ${r.agentId ?? ""}`,
        r.taskPath ? `path: ${r.taskPath}` : "",
        r.nickname ? `nickname: ${r.nickname}` : "",
        `status: ${r.status ?? ""}`,
        r.turnCount !== undefined ? `turns: ${r.turnCount}` : "",
        r.unreadMailCount ? `mail: ${r.unreadMailCount}` : "",
        r.worktreePath ? `worktree: ${r.worktreePath}` : "",
        r.outputRef ? `shadow: ${r.outputRef}` : "",
      ].filter(Boolean);
      return `[${metaParts.join(" | ")}]\n${r.summary ?? ""}`;
    }

    case "tool.agentMessage": {
      const formatted = formatMessageResult(result as Parameters<typeof formatMessageResult>[0]);
      return formatted ?? JSON.stringify(result);
    }

    case "tool.todoWrite": {
      const r = result as { todos?: unknown[] };
      return `[todos updated: ${(r.todos ?? []).length} items]`;
    }

    default:
      return JSON.stringify(result);
  }
}

export function createMcpServer(
  client: Pick<IpcClient, "call">,
  role: SessionRole = process.env.HYDROGEN_ROLE === "readonly" ? "readonly" : "writer",
  allowedTools?: Iterable<string>,
): McpServer {
  const server = new McpServer({ name: "hydrogen", version: "1.0.0" });
  const allowed = allowedTools !== undefined ? new Set(allowedTools) : parseAllowedToolsEnv();
  const canRegister = (toolName: TopLevelToolName): boolean => {
    if (allowed !== undefined) return allowed.has(toolName);
    if (role === "readonly") {
      return toolName === "fs_read" || toolName === "fs_glob" || toolName === "fs_grep";
    }
    return true;
  };

  const forward = async (method: DaemonMethod, params: unknown): Promise<CallToolResult> => {
    try {
      const result = await client.call(method, params);
      const text = formatToolResult(method, result);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  };

  if (canRegister("fs_read")) {
    server.registerTool("fs_read", {
      description: "Read numbered lines (up to 800 lines by default) from any project or local file path and record its snapshot.",
      inputSchema: z.object({
        path: z.string(),
        startLine: z.number().int().optional(),
        endLine: z.number().int().optional(),
      }),
    }, args => forward("tool.fsRead", args));
  }

  if (canRegister("fs_glob")) {
    server.registerTool("fs_glob", {
      description: "Find paths matching a glob pattern (supports project-relative and local absolute paths).",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        limit: z.number().int().optional(),
      }),
    }, args => forward("tool.fsGlob", args));
  }

  if (canRegister("fs_grep")) {
    server.registerTool("fs_grep", {
      description: "Search files for a regex pattern; return matching files, content lines, or counts.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        mode: z.enum(["files", "content", "count"]).optional(),
        context: z.number().int().optional(),
        limit: z.number().int().optional(),
      }),
    }, args => forward("tool.fsGrep", args));
  }

  if (canRegister("fs_patch")) {
    server.registerTool("fs_patch", {
      description: "Write (full overwrite or create), delete, or patch a file using exact or line-anchored text replacements.",
      inputSchema: z.object({
        path: z.string(),
        op: z.enum(["patch", "create", "write", "delete"]),
        hunks: z.array(z.object({
          oldText: z.string(),
          newText: z.string(),
          startLine: z.number().int().optional(),
          endLine: z.number().int().optional(),
        })).optional(),
        content: z.string().optional(),
        startLine: z.number().int().optional(),
        endLine: z.number().int().optional(),
      }),
    }, args => forward("tool.fsPatch", args));
  }

  if (canRegister("bash")) {
    server.registerTool("bash", {
      description: "Execute a shell command (default action='exec', waits up to 300s or returns immediately with background: true), send stdin, poll output, or kill a managed job.",
      inputSchema: z.object({
        action: z.enum(["exec", "stdin", "poll", "kill"]).optional(),
        jobId: z.string().optional(),
        command: z.string().optional(),
        input: z.string().optional(),
        cwd: z.string().optional(),
        yieldMs: z.number().int().optional(),
        timeoutMs: z.number().int().optional(),
        background: z.boolean().optional(),
      }),
    }, args => forward("tool.bash", args));
  }

  if (canRegister("agent_dispatch")) {
    server.registerTool("agent_dispatch", {
      description: "Orchestrate flat Router-Worker subagents (depth=1) with configurable per-agent tools[]. Actions: spawn (default, alias dispatch; supports tasks:[...] batching, tools default ['fs_read','fs_glob','fs_grep','agent_message'], writeScope, worktree:true isolated git worktree, forkTurns='none'|'all', wait), followup (alias send/resume; drains queued mail and transparently warms/resumes idle or hibernated ACP sessions), send_message / broadcast (queue mailbox messages or @all/* broadcast with mid-turn PreInvocation steer for running agents and zero-token queue for idle agents), wait (cursorless waitAll), interrupt, close (auto-cleans alive pty_jobs), list (alias status).",
      inputSchema: z.object({
        action: z.enum([
          "spawn", "dispatch", "followup", "send", "send_input", "resume",
          "send_message", "broadcast",
          "wait", "interrupt", "close", "list", "status",
        ]).optional(),
        agentId: z.string().optional(),
        target: z.string().optional(),
        to: z.union([z.string(), z.array(z.string())]).optional(),
        agentIds: z.array(z.string()).optional(),
        taskName: z.string().optional(),
        role: z.string().optional(),
        model: z.string().optional(),
        tools: z.array(SUBAGENT_TOOL_ENUM).optional(),
        disableAgentMessage: z.boolean().optional(),
        writeScope: z.array(z.string()).optional(),
        forkTurns: z.enum(["none", "all"]).optional(),
        worktree: z.boolean().optional(),
        reuseKey: z.string().optional(),
        prompt: z.string().optional(),
        packet: z.object({
          objective: z.string(),
          relevantFiles: z.array(z.string()).optional(),
          writeScope: z.array(z.string()).optional(),
          knownFacts: z.array(z.string()).optional(),
          constraints: z.array(z.string()).optional(),
          outputContract: z.string().optional(),
        }).optional(),
        tasks: z.array(z.object({
          taskName: z.string().optional(),
          role: z.string().optional(),
          model: z.string().optional(),
          tools: z.array(SUBAGENT_TOOL_ENUM).optional(),
          disableAgentMessage: z.boolean().optional(),
          forkTurns: z.enum(["none", "all"]).optional(),
          worktree: z.boolean().optional(),
          prompt: z.string().optional(),
          objective: z.string().optional(),
          relevantFiles: z.array(z.string()).optional(),
          writeScope: z.array(z.string()).optional(),
          knownFacts: z.array(z.string()).optional(),
          constraints: z.array(z.string()).optional(),
          outputContract: z.string().optional(),
          reuseKey: z.string().optional(),
        })).optional(),
        message: z.string().optional(),
        interrupt: z.boolean().optional(),
        waitAll: z.boolean().optional(),
        wake: z.enum(["never", "next_turn"]).optional(),
        wait: z.boolean().optional(),
        timeoutMs: z.number().int().optional(),
      }),
    }, args => forward("tool.agentDispatch", args));
  }

  if (canRegister("agent_message")) {
    server.registerTool("agent_message", {
      description: "Send peer-to-peer, multicast, or @all/* broadcast messages between agents (queued without triggering new turns on idle agents, and live-steered mid-turn via PreInvocation on running agents) or read unread mailbox messages.",
      inputSchema: z.object({
        action: z.enum(["send", "broadcast", "read"]).optional(),
        to: z.union([z.string(), z.array(z.string())]).optional(),
        message: z.string().optional(),
      }),
    }, args => forward("tool.agentMessage", args));
  }

  if (canRegister("todo_write")) {
    server.registerTool("todo_write", {
      description: "Replace the active thread todo list.",
      inputSchema: z.object({
        todos: z.array(z.object({
          id: z.string(),
          content: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]),
        })),
      }),
    }, args => forward("tool.todoWrite", args));
  }

  return server;
}
