import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHydrogenAppDataDir } from "../adapters/acp.js";

const PRE_TOOL_USE_MATCHER =
  "^(read_file|view_file|write_file|write_to_file|edit_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit|run_command|send_command_input|command_status|notebook_execution|manage_task|schedule|invoke_subagent|define_subagent|manage_subagents|send_message|swarm|run_workflow|call_mcp_tool)$";

const EAGER_TOOLS = {
  fs_read: { eager: true },
  fs_glob: { eager: true },
  fs_grep: { eager: true },
  fs_patch: { eager: true },
  bash: { eager: true },
  agent_dispatch: { eager: true },
  agent_message: { eager: true },
  todo_write: { eager: true },
};

export function buildPortableHgyShellAgent(): string {
  const pathStyle = process.platform === "win32"
    ? "[文件名](file:///C:/绝对路径#L行号)"
    : "[文件名](file:///绝对路径#L行号)";
  return `---
name: hgy-shell
description: "零内置工具壳 Agent（禁用全部 agy 内置工具与默认提示词，仅挂载 MCP 工具供 hgy 接管）"
mainAgent: true
subagent: true
excludeDefaultComponents: true
inheritCustomizations: true
inheritMcp: true
tools: []
---

# Hydrogen Harness (hgy) 执行环境

你运行在 Hydrogen Harness (\`hgy\`) 托管模式下，仅挂载 8 个 Eager 顶层 \`hydrogen\` MCP 原语（独立调用可直接并行）；上下文压缩与交接由 Spine Compact 引擎自动管理。默认使用中文，直接给出判断、结论和实施动作；引用文件时提供 \`${pathStyle}\` 链接。

## 1. 8 个顶层工具原语

- \`mcp_hydrogen_fs_read\` (\`path\`, \`startLine?\`, \`endLine?\`)：按行读取项目内或本地绝对路径文件（默认最多 800 行）并记录版本观察快照。
- \`mcp_hydrogen_fs_glob\` (\`pattern\`, \`path?\`, \`limit?\`)：按 glob 模式匹配文件路径（支持项目内及外部绝对路径）。
- \`mcp_hydrogen_fs_grep\` (\`pattern\`, \`path?\`, \`glob?\`, \`mode?\`, \`context?\`, \`limit?\`)：正则检索文件内容（\`mode\`: \`"files" | "content" | "count"\`）。
- \`mcp_hydrogen_fs_patch\` (\`path\`, \`op\`, \`hunks?\`, \`content?\`, \`startLine?\`, \`endLine?\`)：并发安全的文件修改工具，支持 \`op: "patch"\`（精准 \`hunks\` 替换）、\`"write"\` / \`"create"\`（全量写入或新建）与 \`"delete"\`。
- \`mcp_hydrogen_bash\` (\`action?\`, \`command?\`, \`jobId?\`, \`input?\`, \`cwd?\`, \`yieldMs?\`, \`timeoutMs?\`, \`background?\`)：有状态命令执行（默认 \`action: "exec"\`，支持 \`stdin\` / \`poll\` / \`kill\`，同步等待最高 \`300s\`，\`background: true\` 后台运行）。
- \`mcp_hydrogen_agent_dispatch\` (\`action?\`, \`target?\`/\`agentId?\`, \`to?\`, \`agentIds?\`, \`taskName?\`, \`role?\`, \`model?\`, \`tools?\`, \`disableAgentMessage?\`, \`writeScope?\`, \`worktree?\`, \`forkTurns?\`, \`tasks?\`, \`prompt?\`, \`message?\`, \`wait?\`, \`waitAll?\`, \`interrupt?\`, \`timeoutMs?\`)：单层扁平 Router-Worker 子 Agent 调度器（\`MAX_AGENT_DEPTH=1\`）：
  - \`spawn\`（默认，兼容 \`dispatch\`）：创建并执行子 Agent。支持通过 \`tools: [...]\` 自定义子 Agent 工具子集（可选 \`"fs_read" | "fs_glob" | "fs_grep" | "fs_patch" | "bash" | "agent_message" | "todo_write"\`，默认 \`["fs_read", "fs_glob", "fs_grep", "agent_message"]\`；除非 \`disableAgentMessage: true\`，默认保留 \`"agent_message"\`）、\`writeScope\` 写范围限制、\`worktree: true\` 创建独立 Git 工作树、\`forkTurns: "none" | "all"\`（\`"all"\` 继承主控上下文与模型以保持 Prefix Cache）、\`tasks: [...]\` 单步批量并行与 \`wait: false\` 后台模式。
  - \`followup\`（兼容 \`send\` / \`resume\`）：向已有 \`agentId\`/\`target\` 发送后续指令（同时排空信箱积压消息），优先复用温热 ACP 会话与 KV Cache；自动休眠的子 Agent 会在调用时按需透明热恢复。
  - \`send_message\` / \`broadcast\`：向指定目标、目标数组或 \`@all\`/\`*\` 发送信箱消息（对 \`idle\` 子 Agent 仅入队不空跑，对运行中子 Agent 通过 \`PreInvocation\` 实时盘中注入）。
  - \`wait\`：免游标等待后台子 Agent 完成（支持 \`waitAll: true\`）。
  - \`interrupt\`：取消当前运行 Turn 但保留会话。
  - \`close\`：关闭子 Agent 会话并自动清理其关联的存活后台进程。
  - \`list\`（兼容 \`status\`）：查看子 Agent 状态与工具集。
- \`mcp_hydrogen_agent_message\` (\`action?\`, \`to?\`, \`message?\`)：Agent 间点对点/多播/广播通讯原语（\`action\`: \`"send" | "broadcast" | "read"\`；\`to\` 支持 \`"@all"\` / \`"*"\`、\`"/root"\`、单个或多个 \`agentId\`/\`taskPath\`）。
- \`mcp_hydrogen_todo_write\` (\`todos\`)：维护当前线程待办清单。

## 2. 运行原则

- 沿用项目已有虚拟环境（\`.conda\`、\`.venv\` 等）、锁文件和包管理器。
- 保留用户原文件和无关修改；用户未要求时不做额外验证。
`;
}

export function buildPortableLeanAgent(): string {
  return `---
name: lean
description: "精简主控 Agent（剥离内置冗余提示词与无关工具）"
mainAgent: true
subagent: true
excludeDefaultComponents: true
inheritCustomizations: true
inheritMcp: true
tools:
  - read_file
  - edit_file
  - write_file
  - run_command
  - manage_task
  - invoke_subagent
  - manage_subagents
  - send_message
  - swarm
  - ask_question
  - search_web
---

# Agent System Instructions

默认使用中文，直接给出判断、结论和实施动作。引用文件时提供文件绝对路径与行号。
沿用项目已有环境与包管理器；保留用户原文件和无关修改；长输出命令重定向到日志文件并仅返回退出码与尾部摘要。
`;
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export interface SetupOptions {
  force?: boolean;
  dryRun?: boolean;
  withLean?: boolean;
}

export function runSetup(opts: SetupOptions = {}): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const nodeExec = process.execPath;
  const mcpShimPath = join(packageRoot, "dist", "entry", "mcp-shim.js");
  const hookCliPath = join(packageRoot, "dist", "entry", "hook-cli.js");
  const hookCommand = `"${nodeExec}" "${hookCliPath}"`;

  const configDir = join(homedir(), ".gemini", "config");
  const agentsDir = join(configDir, "agents");
  const hgyShellPath = join(agentsDir, "hgy-shell.md");
  const leanPath = join(agentsDir, "lean.md");
  const mcpConfigPath = join(configDir, "mcp_config.json");
  const hooksConfigPath = join(configDir, "hooks.json");

  const mcpExisting = readJsonObject(mcpConfigPath);
  const mcpServers = (
    mcpExisting.mcpServers && typeof mcpExisting.mcpServers === "object" && !Array.isArray(mcpExisting.mcpServers)
      ? { ...(mcpExisting.mcpServers as Record<string, unknown>) }
      : {}
  );
  mcpServers.hydrogen = {
    command: nodeExec,
    args: [mcpShimPath],
    tools: EAGER_TOOLS,
  };
  const nextMcpConfig = { ...mcpExisting, mcpServers };

  const hooksExisting = readJsonObject(hooksConfigPath);
  const nextHooksConfig = {
    ...hooksExisting,
    "hydrogen-harness": {
      SessionStart: [{ type: "command", command: hookCommand }],
      PreInvocation: [{ type: "command", command: hookCommand }],
      PreToolUse: [
        {
          matcher: PRE_TOOL_USE_MATCHER,
          hooks: [{ type: "command", command: hookCommand }],
        },
      ],
      Stop: [{ type: "command", command: hookCommand }],
    },
  };

  const actions: string[] = [];
  const shouldWriteShell = opts.force || !existsSync(hgyShellPath);
  const shouldWriteLean = Boolean(opts.withLean) && (opts.force || !existsSync(leanPath));

  if (!opts.dryRun) {
    mkdirSync(agentsDir, { recursive: true });
    if (shouldWriteShell) {
      writeFileSync(hgyShellPath, buildPortableHgyShellAgent(), "utf8");
    }
    if (shouldWriteLean) {
      writeFileSync(leanPath, buildPortableLeanAgent(), "utf8");
    }
    writeFileSync(mcpConfigPath, JSON.stringify(nextMcpConfig, null, 2) + "\n", "utf8");
    writeFileSync(hooksConfigPath, JSON.stringify(nextHooksConfig, null, 2) + "\n", "utf8");
    ensureHydrogenAppDataDir();
  }

  actions.push(`packageRoot : ${packageRoot}`);
  actions.push(`node        : ${nodeExec}`);
  actions.push(`hgy-shell   : ${hgyShellPath} (${shouldWriteShell ? (opts.dryRun ? "would write" : "written") : "kept existing; pass --force to overwrite"})`);
  if (opts.withLean) {
    actions.push(`lean        : ${leanPath} (${shouldWriteLean ? (opts.dryRun ? "would write" : "written") : "kept existing"})`);
  }
  actions.push(`mcp_config  : ${mcpConfigPath} (${opts.dryRun ? "would merge" : "updated"})`);
  actions.push(`hooks.json  : ${hooksConfigPath} (${opts.dryRun ? "would merge" : "updated"})`);
  actions.push(`app_data    : ${join(homedir(), ".gemini", "hydrogen-cli")} (${opts.dryRun ? "would initialize" : "ready"})`);
  return actions.join("\n");
}
