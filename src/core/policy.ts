import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  normPath, readSnapshot, requireObservation, resolveReadPath, resolveWritePath, sameObservation,
} from "./files.js";
import type {
  ApprovalMode, HookCommonInput, ObservedFileRecord, PreInvocationOutput, PreToolUseOutput,
} from "./protocol.js";
import { HydrogenError, StateStore, type SessionRecord } from "./state.js";

const READ_TOOLS = new Set(["read_file", "view_file"]);
const CREATE_TOOLS = new Set(["write_file", "write_to_file"]);
const EDIT_TOOLS = new Set([
  "edit_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit",
]);
const BANNED_TOOLS = new Set([
  "run_command", "send_command_input", "command_status", "notebook_execution", "manage_task",
  "schedule", "invoke_subagent", "define_subagent", "manage_subagents", "send_message", "swarm", "run_workflow",
]);
const READONLY_MCP = new Set(["fs_read", "fs_glob", "fs_grep"]);
const PATCH_GUIDANCE = "请使用 mcp_hydrogen_fs_patch。";

function normalizeToolName(name: string): string {
  return name.replace(/^mcp_+hydrogen_+/, "");
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

interface PendingObservation {
  path: string;
  kind: "read" | "edit" | "write";
  before?: ObservedFileRecord;
  expectedText?: string;
}

/** Pre captures the version actually exposed to the tool; Post validates its result. */
export class ObservedStateGate {
  private readonly pending = new Map<string, Map<string, PendingObservation>>();

  constructor(private readonly state: StateStore) {}

  private key(input: HookCommonInput, path: string): string {
    return input.toolCall!.id ?? `${input.toolCall!.name}:${path}`;
  }

  private prepare(sessionId: string, input: HookCommonInput, pending: PendingObservation): void {
    let calls = this.pending.get(sessionId);
    if (!calls) { calls = new Map(); this.pending.set(sessionId, calls); }
    calls.set(this.key(input, pending.path), pending);
  }

  preRead(sessionId: string, input: HookCommonInput, path: string): void {
    const { record } = readSnapshot(sessionId, path);
    this.state.putObservation(record);
    this.prepare(sessionId, input, { path, kind: "read", before: record });
  }

  preEdit(sessionId: string, input: HookCommonInput, path: string,
    edits: Array<{ target: string; replacement: string }>): void {
    const current = requireObservation(this.state, sessionId, path);
    let expectedText = current.text;
    for (const { target, replacement } of edits) {
      const index = expectedText.indexOf(target);
      if (!target || index < 0 || expectedText.indexOf(target, index + 1) !== -1) {
        throw new HydrogenError("MATCH_ERROR", "Target 必须非空且在全文中恰好出现一次。");
      }
      expectedText = expectedText.slice(0, index) + replacement + expectedText.slice(index + target.length);
    }
    this.prepare(sessionId, input, { path, kind: "edit", before: current.record, expectedText });
  }

  preWrite(sessionId: string, input: HookCommonInput, path: string): void {
    this.prepare(sessionId, input, { path, kind: "write" });
  }

  post(sessionId: string, input: HookCommonInput, path: string): void {
    const calls = this.pending.get(sessionId);
    const key = this.key(input, path);
    const pending = calls?.get(key);
    if (!pending) return;
    calls!.delete(key);
    if (calls!.size === 0) this.pending.delete(sessionId);
    if (input.error) {
      this.state.deleteObservation(sessionId, pending.path);
      return;
    }
    if (path !== pending.path) {
      this.state.deleteObservation(sessionId, pending.path);
      throw new HydrogenError("OBSERVATION_STALE", "工具执行期间路径发生变化");
    }
    const current = readSnapshot(sessionId, path);
    if ((pending.kind === "read" && !sameObservation(pending.before!, current.record)) ||
        (pending.kind === "edit" && current.text !== pending.expectedText)) {
      this.state.deleteObservation(sessionId, path);
      throw new HydrogenError("OBSERVATION_STALE", "工具执行结果与 Pre 检查的文件版本不一致，请重新读取文件");
    }
    this.state.putObservation(current.record);
  }
}

interface TurnPolicyState {
  turnCount: number;
  lastUserInput?: string;
  lastBannedTool?: string;
  consecutive: number;
  trippedTool?: string;
}

export class ToolPolicy {
  readonly observedGate: ObservedStateGate;
  private approvalMode: ApprovalMode = "auto-edit";
  private readonly sessionApprovedTools = new Map<string, Set<string>>();
  private readonly writeScopes = new Map<string, string[]>();

  setApprovalMode(mode: ApprovalMode): void { this.approvalMode = mode; }
  getApprovalMode(): ApprovalMode { return this.approvalMode; }

  setAllowedTools(sessionId: string, tools: string[] | undefined): void {
    this.state.setAllowedTools(sessionId, tools);
  }

  getAllowedTools(sessionId: string): string[] | undefined {
    return this.state.getAllowedTools(sessionId);
  }

  setWriteScope(sessionId: string, scope: string[] | undefined): void {
    if (scope === undefined) {
      this.writeScopes.delete(sessionId);
      this.state.setWriteScope(sessionId, undefined);
    } else {
      this.writeScopes.set(sessionId, scope);
      this.state.setWriteScope(sessionId, scope);
    }
  }

  getWriteScope(sessionId: string): string[] | undefined {
    const persisted = this.state.getWriteScope(sessionId);
    if (persisted !== undefined) {
      this.writeScopes.set(sessionId, persisted);
      return persisted;
    }
    this.writeScopes.delete(sessionId);
    return undefined;
  }

  allowForSession(sessionId: string, toolName: string): void {
    let tools = this.sessionApprovedTools.get(sessionId);
    if (!tools) { tools = new Set(); this.sessionApprovedTools.set(sessionId, tools); }
    tools.add(normalizeToolName(toolName));
  }
  isAllowedForSession(sessionId: string, toolName: string): boolean {
    return this.sessionApprovedTools.get(sessionId)?.has(normalizeToolName(toolName)) ?? false;
  }

  private readonly turns = new Map<string, TurnPolicyState>();

  constructor(private readonly projectRoot: string, private readonly state: StateStore) {
    this.observedGate = new ObservedStateGate(state);
  }

  private session(sessionId: string): SessionRecord {
    const session = this.state.getSession(sessionId);
    if (!session) throw new HydrogenError("PERMISSION_DENIED", "会话尚未注册");
    return session;
  }

  private turn(session: SessionRecord, input: HookCommonInput): TurnPolicyState {
    let turn = this.turns.get(session.sessionId);
    if (!turn || turn.turnCount !== session.turnCount ||
        (input.lastUserInput !== undefined && turn.lastUserInput !== undefined &&
          input.lastUserInput !== turn.lastUserInput)) {
      turn = { turnCount: session.turnCount, lastUserInput: input.lastUserInput, consecutive: 0 };
      this.turns.set(session.sessionId, turn);
    } else if (input.lastUserInput !== undefined) turn.lastUserInput = input.lastUserInput;
    return turn;
  }

  private assertWithinWriteScope(rawPath: string, scope: string[]): void {
    if (scope.length === 0) {
      throw new HydrogenError("PERMISSION_DENIED", `Path ${rawPath} is outside session writeScope []`);
    }
    const targetPath = resolveWritePath(this.projectRoot, rawPath);
    const allowed = scope.some(entry => {
      const base = resolveReadPath(this.projectRoot, entry);
      return targetPath === base || inside(base, targetPath);
    });
    if (!allowed) {
      throw new HydrogenError(
        "PERMISSION_DENIED",
        `Path ${rawPath} is outside session writeScope [${scope.join(", ")}]`,
      );
    }
  }

  private target(input: HookCommonInput): { path: string; artifact: boolean } {
    const args = input.toolCall?.args ?? {};
    const raw = args.Path ?? args.AbsolutePath ?? args.TargetFile ?? args.path ?? args.file_path;
    if (typeof raw !== "string" || !raw) throw new HydrogenError("INVALID_INPUT", "工具缺少目标文件路径");
    const absolute = resolve(this.projectRoot, raw);
    const isRead = READ_TOOLS.has(input.toolCall!.name);
    if (input.artifactDirectoryPath) {
      const artifactRoot = resolve(this.projectRoot, input.artifactDirectoryPath);
      if (inside(artifactRoot, absolute)) {
        // Artifact access is rooted at the explicitly supplied artifact directory.
        let path = normPath(artifactRoot, absolute, { allowSpill: isRead });
        if (inside(resolve(this.projectRoot), absolute)) {
          path = normPath(this.projectRoot, absolute, { allowSpill: isRead });
        } else if (inside(realpathSync(this.projectRoot), path)) {
          path = normPath(this.projectRoot, path, { allowSpill: isRead });
        }
        return { path, artifact: true };
      }
    }
    return {
      path: isRead ? resolveReadPath(this.projectRoot, raw) : resolveWritePath(this.projectRoot, raw),
      artifact: false,
    };
  }

  preToolUse(sessionId: string, input: HookCommonInput): PreToolUseOutput {
    try {
      const session = this.session(sessionId);
      const call = input.toolCall;
      if (!call) throw new HydrogenError("INVALID_INPUT", "PreToolUse 缺少 toolCall");
      const target = call.name === "call_mcp_tool"
        ? String(call.args?.toolName ?? call.args?.tool_name ?? call.args?.name ?? "") : call.name;
      const normalized = normalizeToolName(target);
      const turn = this.turn(session, input);
      if (BANNED_TOOLS.has(normalized)) {
        turn.consecutive = turn.lastBannedTool === call.name ? turn.consecutive + 1 : 1;
        turn.lastBannedTool = call.name;
        if (turn.consecutive === 2) {
          turn.trippedTool = call.name;
          this.state.appendEvent("policy.strike", sessionId, {
            toolName: call.name, count: turn.consecutive, turnCount: session.turnCount,
          });
        }
        return { decision: "deny", reason: `${call.name} 已永久禁用，请使用 Hydrogen MCP 工具。` };
      }
      turn.lastBannedTool = undefined;
      turn.consecutive = 0;
      const allowedTools = this.getAllowedTools(sessionId);
      if (allowedTools !== undefined) {
        const permitted = allowedTools.includes(normalized)
          || (normalized === "agent_wait" && allowedTools.includes("agent_dispatch"));
        if (!permitted) {
          return {
            decision: "deny",
            reason: `Tool '${normalized}' is not in this subagent's allowed tools: [${allowedTools.join(", ")}]`,
          };
        }
      } else if (session.role === "readonly" && !READ_TOOLS.has(normalized) && !READONLY_MCP.has(normalized)) {
        return { decision: "deny", reason: "readonly sessions only allow file reads and searches" };
      }
      if (this.approvalMode === "plan" &&
          (CREATE_TOOLS.has(normalized) || EDIT_TOOLS.has(normalized) || ["fs_patch", "bash", "workflow_run"].includes(normalized))) {
        return { decision: "deny", reason: "Tool is unavailable in plan mode" };
      }
      const writerRequiredTools = allowedTools !== undefined
        ? ["fs_patch", "bash", "workflow_run", "handover_checkpoint", "handover_trigger"]
        : ["fs_patch", "bash", "workflow_run", "todo_write", "agent_dispatch", "handover_checkpoint", "handover_trigger"];
      if (writerRequiredTools.includes(normalized)) {
        this.state.assertWriteLease(sessionId);
      }
      if (normalized === "fs_patch") {
        const scope = this.getWriteScope(sessionId);
        if (scope !== undefined) {
          const mcpArgs = call.name === "call_mcp_tool"
            ? ((call.args?.arguments as Record<string, unknown> | undefined) ?? call.args)
            : call.args;
          const rawPath = mcpArgs?.path;
          if (typeof rawPath === "string" && rawPath) {
            this.assertWithinWriteScope(rawPath, scope);
          } else if (scope.length === 0) {
            return { decision: "deny", reason: "PERMISSION_DENIED: Session writeScope is []" };
          }
        }
        return { decision: "allow" };
      }
      if (normalized === "bash" && allowedTools === undefined && this.approvalMode === "auto-edit" && !this.isAllowedForSession(sessionId, "bash")) {
        return { decision: "ask", reason: "Shell command requires user approval in auto-edit mode" };
      }
      if (call.name === "call_mcp_tool") return { decision: "allow" };
      if (READ_TOOLS.has(call.name)) {
        const { path } = this.target(input);
        this.observedGate.preRead(sessionId, input, path);
        return { decision: "allow" };
      }
      if (CREATE_TOOLS.has(call.name)) {
        this.state.assertWriteLease(sessionId);
        const { path, artifact } = this.target(input);
        const scope = this.getWriteScope(sessionId);
        if (scope !== undefined && !artifact) this.assertWithinWriteScope(path, scope);
        let exists = false;
        try { lstatSync(path); exists = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (exists && !artifact) {
          return { decision: "deny", reason: `原生写入不得覆盖既有源码。${PATCH_GUIDANCE}` };
        }
        this.observedGate.preWrite(sessionId, input, path);
        return { decision: "allow" };
      }
      if (EDIT_TOOLS.has(call.name)) {
        this.state.assertWriteLease(sessionId);
        const { path, artifact } = this.target(input);
        const scope = this.getWriteScope(sessionId);
        if (scope !== undefined && !artifact) this.assertWithinWriteScope(path, scope);
        const args = call.args ?? {};
        const blocks = args.Edits ?? args.edits ?? [args];
        if (!Array.isArray(blocks) || !blocks.length) {
          return { decision: "deny", reason: `编辑须提供替换内容。${PATCH_GUIDANCE}` };
        }
        const edits = blocks.map((block: Record<string, unknown>) => {
          const targetText = block.Target ?? block.TargetContent ?? block.oldText;
          const replacement = block.Replacement ?? block.ReplacementContent ?? block.newText;
          if (typeof targetText !== "string" || !targetText || typeof replacement !== "string") {
            throw new HydrogenError("INVALID_INPUT", "编辑须提供非空 Target/TargetContent 与替换内容");
          }
          return { target: targetText, replacement };
        });
        this.observedGate.preEdit(sessionId, input, path, edits);
        return { decision: "allow" };
      }
      return { decision: "allow" };
    } catch (error) {
      const code = error instanceof HydrogenError ? `${error.code}: ` : "";
      const guidance = input.toolCall && EDIT_TOOLS.has(input.toolCall.name) ? ` ${PATCH_GUIDANCE}` : "";
      return { decision: "deny", reason: code + (error instanceof Error ? error.message : String(error)) + guidance };
    }
  }

  postToolUse(sessionId: string, input: HookCommonInput): void {
    const name = input.toolCall?.name;
    if (!name || (!READ_TOOLS.has(name) && !CREATE_TOOLS.has(name) && !EDIT_TOOLS.has(name))) return;
    if (!input.error && !READ_TOOLS.has(name)) this.state.assertWriteLease(sessionId);
    this.observedGate.post(sessionId, input, this.target(input).path);
  }

  preInvocation(sessionId: string, input: HookCommonInput): PreInvocationOutput {
    const turn = this.turn(this.session(sessionId), input);
    if (!turn.trippedTool) return {};
    return { terminationBehavior: "terminate", injectSteps: [{ errorMessage: {
      userMessage: `同回合连续调用永久禁用工具 ${turn.trippedTool}，已记录 strike 并终止循环。请使用 Hydrogen MCP 工具继续。`,
    } }] };
  }
}
