#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HYDROGEN_APP_DATA_REL_DIR, ensureHydrogenAppDataDir } from "../adapters/acp.js";
import type { SessionEvent } from "../adapters/session.js";
import type { ApprovalMode } from "../core/protocol.js";
import { HydrogenRuntime, runTurnWithHandover } from "../core/runtime.js";
import {
  COMMAND_SPECS,
  applyEffortToModel,
  executeSlashOrShell,
  formatHelp,
  formatSessionsList,
  formatTokenShort,
  getGitSnapshot,
  listAvailableAgents,
  listAvailableModels,
  normalizeApprovalMode,
} from "./commands.js";
import { removeTuiDaemonMeta, startRuntimeDaemon, updateActiveDaemonMeta } from "./runtime-daemon.js";
import { runSetup } from "./setup.js";
import { startWebUi } from "./webui.js";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

/** Wrap non-printing ANSI sequences for node:readline prompt width calculation. */
function rlWrap(ansi: string): string {
  return `\x01${ansi}\x02`;
}

function shortModelName(modelId: string): string {
  return modelId.replace(/^gemini-4-/, "").replace(/^claude-/, "");
}

function toAgyMode(mode: ApprovalMode): string {
  if (mode === "plan") return "plan";
  if (mode === "full-auto") return "auto";
  return "accept-edits";
}

function summarizeToolArgs(rawInput: unknown): string {
  if (!rawInput || typeof rawInput !== "object") return "";
  const obj = rawInput as Record<string, unknown>;
  const args = (obj.arguments && typeof obj.arguments === "object" ? obj.arguments : obj) as Record<string, unknown>;
  if (typeof args.path === "string") {
    const range = args.startLine !== undefined || args.endLine !== undefined
      ? `:${args.startLine ?? 1}-${args.endLine ?? "end"}`
      : "";
    return `${args.path}${range}`;
  }
  if (typeof args.command === "string") return args.command.replace(/\s+/g, " ").slice(0, 72);
  if (typeof args.pattern === "string") return `${args.pattern}${typeof args.path === "string" ? ` in ${args.path}` : ""}`;
  if (typeof args.action === "string") return args.action;
  if (typeof args.activeGoal === "string") return args.activeGoal.slice(0, 60);
  return "";
}

function buildUsageHelp(): string {
  return [
    "Usage: hgy [subcommand] [flags]",
    "",
    "Subcommands (与 agy 对齐):",
    "  (no subcommand)   启动原生 agy TUI + hgy-shell 零内置工具壳 + 300k 主动 Compact 守护",
    "  models            列出所有可用模型",
    "  agents | agent    列出所有可用底层壳 Agent (hgy-shell, lean, default)",
    "  sessions          列出当前工作区可恢复的会话/线程 (alias: threads)",
    "  status            查看当前工作区会话与 300k 检查点状态",
    "  setup | install   将 hgy-shell / mcp_config.json / hooks.json 自动装配到 ~/.gemini/config",
    "  help              显示帮助信息",
    "",
    "Flags (兼容 agy CLI):",
    "  -p, --print, --prompt <TEXT>            非交互单轮执行并输出结果",
    "  -i, --prompt-interactive <TEXT>         先执行初始 Prompt，随后留在交互式 TUI",
    "  -c, --continue                          恢复最近一次会话",
    "  -r, --resume [ID]                       恢复指定会话 (省略 ID 时恢复最近会话)",
    "  --conversation <ID>                     按原生 conversationId 恢复指定会话",
    "  --model <MODEL>                         指定模型 (默认 gemini-4-hydrogen-high)",
    "  --effort <low|medium|high|xhigh|max>    指定模型推理档位",
    "  --agent <AGENT>                         指定底层 agy 壳 Agent (默认 hgy-shell)",
    "  --mode <plan|auto-edit|full-auto>       指定审批模式 (兼容 accept-edits / auto)",
    "  --dangerously-skip-permissions          自动批准所有权限请求 (等同 --mode full-auto)",
    "  --cwd, --add-dir <PATH>                 指定项目工作目录",
    "  --web [--port <PORT>]                   启动 Hydrogen WebUI",
    "  --repl                                  使用轻量级 readline REPL (默认使用原生 agy TUI)",
    "  -h, --help                              显示帮助信息",
    "",
    formatHelp(),
    "",
  ].join("\n");
}

async function runNativeAgyTui(
  runtime: HydrogenRuntime,
  opts: {
    socketPath: string;
    effort?: string;
    skipPermissions: boolean;
    continueRecent: boolean;
    resumeConversationId?: string;
    initialPrompt?: string;
    addDirs: string[];
    signal: AbortSignal;
  },
): Promise<void> {
  ensureHydrogenAppDataDir();
  const isResume = Boolean(opts.resumeConversationId || opts.continueRecent);
  const explicitTarget = opts.resumeConversationId
    ? runtime.resolveResumeTarget(opts.resumeConversationId)
    : undefined;
  const fallbackTarget = !opts.resumeConversationId && opts.continueRecent
    ? runtime.resolveResumeTarget()
    : undefined;
  const target = explicitTarget ?? fallbackTarget;
  if (target?.threadId) {
    runtime.activateThreadForNative(target.threadId);
  }
  const sessionId = isResume
    ? runtime.openNativeMain(explicitTarget?.conversationId ?? opts.resumeConversationId, true, target?.previousSessionId)
    : runtime.openNativeMain();
  const stats = runtime.contextStats();
  process.stderr.write(
    `${ANSI.cyan}╭─ [hgy]${ANSI.reset} ${ANSI.green}${runtime.currentModel}${ANSI.reset} · shell=${ANSI.yellow}${runtime.currentAgent}${ANSI.reset} · mode=${ANSI.blue}${runtime.approvalMode}${ANSI.reset} · epoch=E${runtime.state.activeEpoch} · compact=${formatTokenShort(stats.softTokens)} (auto=${runtime.autoCompact ? "on" : "off"})\n`,
  );

  const agyArgs: string[] = ["--app_data_dir", HYDROGEN_APP_DATA_REL_DIR];
  if (runtime.currentAgent && runtime.currentAgent !== "default") {
    agyArgs.push("--agent", runtime.currentAgent);
  }
  if (runtime.currentModel) {
    agyArgs.push("--model", runtime.currentModel);
  }
  if (opts.effort) {
    agyArgs.push("--effort", opts.effort);
  }
  agyArgs.push("--mode", toAgyMode(runtime.approvalMode));
  if (opts.skipPermissions || runtime.approvalMode === "full-auto") {
    agyArgs.push("--dangerously-skip-permissions");
  }
  for (const dir of opts.addDirs) {
    agyArgs.push("--add-dir", dir);
  }
  if (opts.resumeConversationId) {
    agyArgs.push("--conversation", explicitTarget?.conversationId ?? opts.resumeConversationId);
  } else if (opts.continueRecent) {
    agyArgs.push("--continue");
  }
  if (opts.initialPrompt) {
    agyArgs.push("-i", opts.initialPrompt);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JETSKI_APP_DATA_DIR: HYDROGEN_APP_DATA_REL_DIR,
    HYDROGEN_ACTIVE: "1",
    HYDROGEN_PROJECT_ROOT: runtime.projectRoot,
    HYDROGEN_SOCKET_PATH: opts.socketPath,
    HYDROGEN_DAEMON_ADDR: opts.socketPath,
    HYDROGEN_SESSION_ID: sessionId,
    HYDROGEN_ROLE: "writer",
    HYDROGEN_EPOCH: String(runtime.state.activeEpoch),
    HYDROGEN_DEPTH: "0",
  };

  const child = spawn("agy", agyArgs, {
    cwd: runtime.projectRoot,
    env,
    stdio: "inherit",
  });
  if (child.pid) {
    updateActiveDaemonMeta({
      pid: process.pid,
      tuiPid: child.pid,
      socketPath: opts.socketPath,
      projectRoot: runtime.projectRoot,
      sessionId,
    });
  }

  try {
    await new Promise<void>((resolveChild, rejectChild) => {
      child.once("error", rejectChild);
      child.once("close", () => resolveChild());
    });
  } finally {
    if (child.pid) removeTuiDaemonMeta(child.pid);
  }
}

async function renderTuiBanner(runtime: HydrogenRuntime): Promise<void> {
  if (!process.stdout.isTTY) return;
  const stats = runtime.contextStats();
  const git = await getGitSnapshot(runtime.projectRoot);
  const cp = runtime.state.getCheckpoint();
  const branchTag = git.isGitRepo && git.branch ? ` (${ANSI.magenta}git:${git.branch}${ANSI.reset})` : "";
  const compactInfo = `${formatTokenShort(stats.inputTokens)}/${formatTokenShort(stats.softTokens)} (auto=${runtime.autoCompact ? "on" : "off"}, window=${formatTokenShort(stats.contextWindow)})`;
  const lines = [
    `${ANSI.bold}${ANSI.cyan}╭─── Hydrogen Harness REPL (hgy --repl)${ANSI.reset} ${ANSI.gray}· Zero-Bloat Shell + 300k Active Handover${ANSI.reset}`,
    `${ANSI.cyan}│${ANSI.reset} ${ANSI.bold}workspace${ANSI.reset} : ${runtime.projectRoot}${branchTag}`,
    `${ANSI.cyan}│${ANSI.reset} ${ANSI.bold}model${ANSI.reset}     : ${ANSI.green}${runtime.currentModel}${ANSI.reset}  ${ANSI.gray}·${ANSI.reset}  ${ANSI.bold}shell${ANSI.reset}: ${ANSI.yellow}${runtime.currentAgent}${ANSI.reset}  ${ANSI.gray}·${ANSI.reset}  ${ANSI.bold}mode${ANSI.reset}: ${ANSI.blue}${runtime.approvalMode}${ANSI.reset}`,
    `${ANSI.cyan}│${ANSI.reset} ${ANSI.bold}context${ANSI.reset}   : ${compactInfo}  ${ANSI.gray}·${ANSI.reset}  ${ANSI.bold}epoch${ANSI.reset}: E${runtime.state.activeEpoch}  ${ANSI.gray}·${ANSI.reset}  ${ANSI.bold}thread${ANSI.reset}: ${runtime.activeThreadId.slice(0, 8)}`,
  ];
  if (cp.activeGoal) {
    const goalPreview = cp.activeGoal.replace(/\s+/g, " ").slice(0, 76);
    lines.push(`${ANSI.cyan}│${ANSI.reset} ${ANSI.bold}goal${ANSI.reset}      : ${ANSI.dim}${goalPreview}${cp.activeGoal.length > 76 ? "…" : ""}${ANSI.reset}`);
  }
  lines.push(`${ANSI.cyan}╰───${ANSI.reset} ${ANSI.gray}输入 /help 查看命令 · /model 切模型 · /compact 立即轮转 · !<cmd> 跑 Shell${ANSI.reset}`);
  process.stdout.write(lines.join("\n") + "\n\n");
}

function buildReplPrompt(runtime: HydrogenRuntime): string {
  const stats = runtime.contextStats();
  const ratio = stats.softTokens > 0 ? stats.inputTokens / stats.softTokens : 0;
  const tokenColor = ratio >= 0.9 ? ANSI.red : ratio >= 0.75 ? ANSI.yellow : ANSI.green;
  const modeColor = runtime.approvalMode === "plan" ? ANSI.yellow
    : runtime.approvalMode === "full-auto" ? ANSI.magenta : ANSI.blue;
  const modeLabel = runtime.approvalMode === "plan" ? "plan"
    : runtime.approvalMode === "full-auto" ? "auto" : "edit";
  return [
    rlWrap(ANSI.gray), "[", rlWrap(ANSI.reset),
    rlWrap(ANSI.cyan), shortModelName(runtime.currentModel), rlWrap(ANSI.reset),
    rlWrap(ANSI.gray), "|", rlWrap(ANSI.reset),
    rlWrap(modeColor), modeLabel, rlWrap(ANSI.reset),
    rlWrap(ANSI.gray), `|E${runtime.state.activeEpoch}|`, rlWrap(ANSI.reset),
    rlWrap(tokenColor), `${formatTokenShort(stats.inputTokens)}/${formatTokenShort(stats.softTokens)}`, rlWrap(ANSI.reset),
    rlWrap(ANSI.gray), "] ", rlWrap(ANSI.reset),
    rlWrap(ANSI.bold + ANSI.cyan), ">", rlWrap(ANSI.reset), " ",
  ].join("");
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const first = args[0];
  if (first === "help") {
    process.stdout.write(buildUsageHelp());
    return;
  }
  if (first === "models") {
    const models = await listAvailableModels(true);
    for (const m of models) process.stdout.write(`${m.id.padEnd(32)} ${m.label}\n`);
    return;
  }
  if (first === "agents" || first === "agent") {
    const agents = await listAvailableAgents();
    for (const a of agents) process.stdout.write(`${a.name.padEnd(16)} [${a.scope}] ${a.description}\n`);
    return;
  }
  if (first === "setup" || first === "install") {
    const force = args.includes("--force") || args.includes("-f");
    const dryRun = args.includes("--dry-run");
    const withLean = args.includes("--with-lean");
    const summary = runSetup({ force, dryRun, withLean });
    process.stdout.write(summary + "\n");
    return;
  }

  let cwd = process.cwd();
  const addDirs: string[] = [];
  let model: string | undefined;
  let effort: string | undefined;
  let agent: string | undefined;
  let mode: ApprovalMode | undefined;
  let skipPermissions = false;
  let prompt: string | undefined;
  let interactivePrompt: string | undefined;
  let continueRecent = false;
  let resumeThreadId: string | undefined;
  let web = false;
  let repl = false;
  let port = 0;
  let statusOnly = false;
  let sessionsOnly = false;

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "status") { statusOnly = true; continue; }
    if (flag === "sessions" || flag === "threads") { sessionsOnly = true; continue; }
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(buildUsageHelp());
      return;
    }
    if (flag === "--web") { web = true; continue; }
    if (flag === "--repl") { repl = true; continue; }
    if (flag === "-c" || flag === "--continue") { continueRecent = true; continue; }
    if (flag === "-r" || flag === "--resume") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("-")) {
        continueRecent = true;
      } else {
        resumeThreadId = next;
        index++;
      }
      continue;
    }
    if (flag === "--dangerously-skip-permissions") { skipPermissions = true; mode = "full-auto"; continue; }
    if (
      ![
        "--cwd", "--add-dir", "--model", "--effort", "--agent", "--mode",
        "-p", "--print", "--prompt", "-i", "--prompt-interactive",
        "--conversation", "--port",
      ].includes(flag) ||
      args[index + 1] === undefined
    ) {
      throw new Error(`Invalid argument: ${flag}\nRun 'hgy --help' for usage.`);
    }
    const value = args[++index];
    if (flag === "--cwd") cwd = resolve(value);
    else if (flag === "--add-dir") addDirs.push(resolve(value));
    else if (flag === "--model") model = value;
    else if (flag === "--effort") effort = value;
    else if (flag === "--agent") agent = value;
    else if (flag === "--mode") {
      const parsedMode = normalizeApprovalMode(value);
      if (!parsedMode) throw new Error(`Invalid mode: ${value} (expected plan | auto-edit | full-auto)`);
      mode = parsedMode;
    } else if (flag === "--conversation") resumeThreadId = value;
    else if (flag === "--port") {
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${value}`);
    } else if (flag === "-i" || flag === "--prompt-interactive") interactivePrompt = value;
    else prompt = value;
  }
  if (web && (prompt !== undefined || interactivePrompt !== undefined)) {
    throw new Error("--web cannot be combined with -p or -i");
  }

  const runtime = new HydrogenRuntime(cwd, model ?? "gemini-4-hydrogen-high", undefined, agent);
  if (model) await runtime.setModel(model);
  if (effort) {
    const withEffort = applyEffortToModel(runtime.currentModel, effort);
    if (withEffort) await runtime.setModel(withEffort);
  }
  if (mode) runtime.setApprovalMode(mode);
  if (skipPermissions) runtime.autoApproveOnNoUi = true;

  if (statusOnly) {
    const res = await executeSlashOrShell(runtime, "/status", "cli");
    if (res.handled && res.output) process.stdout.write(res.output + "\n");
    await runtime.dispose();
    return;
  }
  if (sessionsOnly) {
    process.stdout.write(formatSessionsList(runtime) + "\n");
    await runtime.dispose();
    return;
  }

  let daemon: Awaited<ReturnType<typeof startRuntimeDaemon>>;
  try { daemon = await startRuntimeDaemon(runtime); }
  catch (error) { await runtime.dispose(); throw error; }

  const sessionController = new AbortController();
  let turnController: AbortController | undefined;
  let terminal: ReturnType<typeof createInterface> | undefined;

  // Default interactive TUI mode uses native `agy` TUI (`stdio: "inherit"`) so IME and rendering are 100% native `agy`.
  const useNativeAgyTui = !web && prompt === undefined && !repl && Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const handleSigint = () => {
    if (useNativeAgyTui) return; // Native `agy` TUI handles SIGINT directly in its own foreground process.
    if (turnController && !turnController.signal.aborted) {
      process.stderr.write(`\n${ANSI.yellow}⚡ 已中断当前生成 Turn (按 Ctrl+D 或输入 /exit 退出)${ANSI.reset}\n`);
      turnController.abort(new Error("Turn interrupted by user"));
      void runtime.cancelMain().catch(() => {});
      return;
    }
    sessionController.abort(new Error("Interrupted"));
  };
  process.on("SIGINT", handleSigint);
  process.once("SIGTERM", () => sessionController.abort(new Error("Terminated")));

  let outputSeen = false;
  let thoughtSeen = false;
  let finalText = "";
  const activeTools = new Map<string, string>();

  const render = (event: SessionEvent) => {
    if (event.type === "thought_delta") {
      if (!thoughtSeen && process.stderr.isTTY) {
        thoughtSeen = true;
        process.stderr.write(`${ANSI.gray}✻ Thinking...${ANSI.reset}\r`);
      }
    } else if (event.type === "text_delta") {
      if (thoughtSeen && !outputSeen && process.stderr.isTTY) {
        process.stderr.write("\x1b[2K\r");
      }
      process.stdout.write(event.text);
      outputSeen = true;
    } else if (event.type === "tool_call") {
      if (thoughtSeen && !outputSeen && process.stderr.isTTY) {
        process.stderr.write("\x1b[2K\r");
      }
      const cleanName = event.name.replace(/^mcp_+hydrogen_+/, "");
      const summary = summarizeToolArgs(event.rawInput);
      activeTools.set(event.callId, cleanName);
      process.stderr.write(`\n${ANSI.cyan}● ${ANSI.bold}${cleanName}${ANSI.reset}${summary ? ` ${ANSI.gray}(${summary})${ANSI.reset}` : ""}\n`);
    } else if (event.type === "tool_call_update") {
      const cleanName = activeTools.get(event.callId);
      if (cleanName && (event.status === "completed" || event.status === "failed")) {
        activeTools.delete(event.callId);
        const badge = event.status === "completed" ? `${ANSI.green}  ⎿  ✓ completed${ANSI.reset}` : `${ANSI.red}  ⎿  ✗ failed${ANSI.reset}`;
        process.stderr.write(`${badge}\n`);
      }
    } else if (event.type === "done") {
      finalText = event.finalText;
    } else if (event.type === "permission_request") {
      if (!terminal || !process.stdin.isTTY || skipPermissions) {
        runtime.resolvePermission(event.requestId, skipPermissions ? "allow_session" : "deny");
      } else {
        terminal.resume();
        void terminal.question(
          `\n${ANSI.yellow}? 批准执行 ${event.toolName}${ANSI.reset} ${ANSI.gray}${JSON.stringify(event.rawInput)}${ANSI.reset} [y=一次 / s=本会话 / N=拒绝] `,
          { signal: turnController?.signal ?? sessionController.signal },
        ).then(answer => {
          terminal?.pause();
          const normalized = answer.trim().toLowerCase();
          if (runtime.listPendingPermissions().some(request => request.requestId === event.requestId)) {
            runtime.resolvePermission(
              event.requestId,
              normalized === "y" ? "allow_once" : normalized === "s" ? "allow_session" : "deny",
            );
          }
        }, error => {
          terminal?.pause();
          if (!sessionController.signal.aborted) process.stderr.write(String(error) + "\n");
        });
      }
    } else if (event.type === "error") {
      process.stderr.write(`\n${ANSI.red}✗ ${event.message}${ANSI.reset}\n`);
    }
  };

  const run = async (text: string) => {
    outputSeen = false;
    thoughtSeen = false;
    finalText = "";
    activeTools.clear();
    turnController = new AbortController();
    const onSessionAbort = () => turnController?.abort(sessionController.signal.reason);
    sessionController.signal.addEventListener("abort", onSessionAbort, { once: true });
    // Pause readline during model generation so user keystrokes/IME never trigger _refreshLine() over streaming output.
    if (process.stdin.isTTY && !(terminal as unknown as { closed?: boolean })?.closed) terminal?.pause();
    try {
      await runTurnWithHandover(runtime, text, {
        onEvent: render,
        onRotation: info => {
          process.stderr.write(
            `\n${ANSI.magenta}⟳ [300k Active Handover] 已打包 HandoffPacket 并无损切换至 Epoch ${info.epoch} (${info.reason})${ANSI.reset}\n`,
          );
        },
        onAfterTurn: () => {
          if (!outputSeen && finalText) process.stdout.write(finalText);
          process.stdout.write("\n");
          outputSeen = false;
          thoughtSeen = false;
          finalText = "";
        },
      }, turnController.signal);
    } catch (error) {
      if (!turnController.signal.aborted) throw error;
    } finally {
      sessionController.signal.removeEventListener("abort", onSessionAbort);
      turnController = undefined;
      if (!sessionController.signal.aborted && process.stdin.isTTY && !(terminal as unknown as { closed?: boolean })?.closed) {
        terminal?.resume();
      }
    }
  };

  let webUi: Awaited<ReturnType<typeof startWebUi>> | undefined;
  try {
    if (useNativeAgyTui) {
      await runNativeAgyTui(runtime, {
        socketPath: daemon.socketPath,
        effort,
        skipPermissions,
        continueRecent,
        resumeConversationId: resumeThreadId,
        initialPrompt: interactivePrompt,
        addDirs,
        signal: sessionController.signal,
      });
      return;
    }

    if (resumeThreadId) {
      const target = runtime.resolveResumeTarget(resumeThreadId);
      if (target.threadId) {
        await runtime.switchThread(target.threadId, target.conversationId);
      } else {
        await runtime.openMain({
          resume: true,
          resumeConversationId: target.conversationId,
          previousSessionId: target.previousSessionId,
        });
      }
    } else if (continueRecent) {
      const target = runtime.resolveResumeTarget();
      if (target.threadId) {
        await runtime.switchThread(target.threadId, target.conversationId);
      } else if (target.conversationId || target.previousSessionId) {
        await runtime.openMain({
          resume: true,
          resumeConversationId: target.conversationId,
          previousSessionId: target.previousSessionId,
        });
      } else {
        await runtime.openMain();
      }
    } else {
      await runtime.openMain();
    }

    if (web) {
      webUi = await startWebUi(runtime, { port, signal: sessionController.signal });
      process.stdout.write(`Hydrogen WebUI running at:\n  ${webUi.url}\nPress Ctrl+C to stop.\n`);
      if (process.platform === "darwin") {
        const opener = spawn("open", [webUi.url], { stdio: "ignore", detached: true });
        opener.on("error", () => {});
        opener.unref();
      } else if (process.platform === "win32") {
        const opener = spawn("cmd", ["/c", "start", "", webUi.url], { stdio: "ignore", detached: true, windowsHide: true });
        opener.on("error", () => {});
        opener.unref();
      } else if (process.platform === "linux") {
        const opener = spawn("xdg-open", [webUi.url], { stdio: "ignore", detached: true });
        opener.on("error", () => {});
        opener.unref();
      }
      await new Promise<void>(resolveWait => {
        if (sessionController.signal.aborted) { resolveWait(); return; }
        sessionController.signal.addEventListener("abort", () => resolveWait(), { once: true });
      });
    } else if (prompt !== undefined) {
      await run(prompt);
    } else {
      const slashCompletions = [
        ...COMMAND_SPECS.flatMap(spec => [`/${spec.name}`, ...(spec.aliases ?? []).map(a => `/${a}`)]),
        "/compact auto on",
        "/compact auto off",
        "/compact threshold 300k",
        "/mode plan",
        "/mode auto-edit",
        "/mode full-auto",
        "/effort low",
        "/effort medium",
        "/effort high",
        "/effort xhigh",
        "/agent hgy-shell",
        "/agent lean",
        "/agent default",
        "/model gemini-4-hydrogen-high",
        "/model gemini-4-hydrogen-xhigh",
        "/model gemini-4-argon-high",
      ];
      terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: Boolean(process.stdin.isTTY),
        prompt: buildReplPrompt(runtime),
        completer: (line: string): [string[], string] => {
          if (!line.startsWith("/")) return [[], line];
          const hits = slashCompletions.filter(name => name.startsWith(line));
          return [hits.length ? hits : slashCompletions, line];
        },
      });
      const closeTerminal = () => terminal!.close();
      terminal.on("SIGINT", handleSigint);
      sessionController.signal.addEventListener("abort", closeTerminal, { once: true });
      try {
        await renderTuiBanner(runtime);
        if (interactivePrompt !== undefined && interactivePrompt.trim()) {
          await run(interactivePrompt);
        }
        let pending = "";
        if (process.stdin.isTTY) {
          terminal.setPrompt(buildReplPrompt(runtime));
          terminal.prompt();
        }
        for await (const line of terminal) {
          if (line.endsWith("\\")) {
            pending += line.slice(0, -1) + "\n";
            if (process.stdin.isTTY) {
              terminal.setPrompt(`${rlWrap(ANSI.gray)}  ... >${rlWrap(ANSI.reset)} `);
              terminal.prompt();
            }
            continue;
          }
          const text = pending + line;
          pending = "";
          if (text.trim()) {
            if (process.stdin.isTTY && !(terminal as unknown as { closed?: boolean })?.closed) terminal.pause();
            const cmd = await executeSlashOrShell(runtime, text, "cli").catch(error => ({
              handled: true as const,
              ok: false,
              title: text.trim(),
              output: error instanceof Error ? error.message : String(error),
              action: undefined,
            }));
            if (process.stdin.isTTY && !(terminal as unknown as { closed?: boolean })?.closed) terminal.resume();
            if (cmd.handled) {
              if (cmd.action === "exit") break;
              if (cmd.action === "clear") {
                process.stdout.write("\x1Bc");
                await renderTuiBanner(runtime);
              } else if (cmd.output) {
                (cmd.ok ? process.stdout : process.stderr).write(cmd.output + "\n");
              }
            } else {
              await run(text);
            }
          }
          if (sessionController.signal.aborted) break;
          if (process.stdin.isTTY) {
            terminal.setPrompt(buildReplPrompt(runtime));
            terminal.prompt();
          }
        }
        if (pending.trim() && !sessionController.signal.aborted) await run(pending);
      } finally {
        sessionController.signal.removeEventListener("abort", closeTerminal);
        terminal.close();
      }
    }
  } finally {
    await webUi?.close().catch(() => {});
    process.removeListener("SIGINT", handleSigint);
    await daemon.close();
  }
}

function isDirectEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const selfPath = realpathSync(fileURLToPath(import.meta.url));
    const argPath = realpathSync(resolve(invoked));
    if (process.platform === "win32") return selfPath.toLowerCase() === argPath.toLowerCase();
    return selfPath === argPath;
  } catch {
    return import.meta.url === pathToFileURL(resolve(invoked)).href;
  }
}

if (isDirectEntrypoint()) {
  void main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
}
