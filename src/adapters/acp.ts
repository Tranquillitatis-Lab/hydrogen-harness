/// <reference types="node" />
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectMediaType } from "../core/files.js";
import { extractEffortFromModelId, resolveModelAndEffort } from "../core/protocol.js";
import type {
  ManagedSessionHandle, PromptTurnResult, SessionAdapter, SessionEvent,
  SessionOpenOptions, SessionUsage,
} from "./session.js";

export const HYDROGEN_APP_DATA_REL_DIR = "hydrogen-cli";

export function ensureHydrogenAppDataDir(): string {
  const geminiDir = join(homedir(), ".gemini");
  const antigravityDir = join(geminiDir, "antigravity-cli");
  const hydrogenDir = join(geminiDir, HYDROGEN_APP_DATA_REL_DIR);
  try {
    mkdirSync(hydrogenDir, { recursive: true });
    for (const sub of [
      "conversations",
      "brain",
      "presence",
      "log",
      "implicit",
      "annotations",
      "crashes",
      "cache",
      "mcp",
      "voice_chats",
    ]) {
      mkdirSync(join(hydrogenDir, sub), { recursive: true });
    }
    for (const shared of [
      "jetski_state.pbtxt",
      "installation_id",
      "settings.json",
      "builtin",
      "last_check.timestamp",
      "updater",
      "bin",
    ]) {
      const src = join(antigravityDir, shared);
      const dst = join(hydrogenDir, shared);
      let dstExists = false;
      try {
        lstatSync(dst);
        dstExists = true;
      } catch {
        dstExists = false;
      }
      if (!dstExists && existsSync(src)) {
        try {
          const isDir = statSync(src).isDirectory();
          symlinkSync(src, dst, process.platform === "win32" ? (isDir ? "junction" : "file") : undefined);
        } catch {
          try {
            if (!statSync(src).isDirectory()) copyFileSync(src, dst);
          } catch { /* Ignore copy fallback errors. */ }
        }
      }
    }
  } catch { /* Best-effort initialization. */ }
  return hydrogenDir;
}

type ObjectValue = Record<string, unknown>;
type RpcId = string | number;
type Permission = { id: RpcId; options: ObjectValue[] };
type Turn = {
  onEvent: (event: SessionEvent) => void;
  text: string;
  usage?: SessionUsage;
  aborted: boolean;
};

type SharedAcpHost = {
  hostKey: string;
  cwd: string;
  agent?: string;
  autoApprovePermissions: boolean;
  env: NodeJS.ProcessEnv;
  child?: ChildProcessWithoutNullStreams;
  exited?: Promise<void>;
  initPromise?: Promise<void>;
  capabilities: ObjectValue;
  pending: Map<RpcId, { resolve: (value: ObjectValue) => void; reject: (error: Error) => void }>;
  activeSessions: Set<string>;
  sessionsByConversationId: Map<string, Session>;
  pendingOpens: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  stderr: string;
  failure?: Error;
  disposing: boolean;
};

type Session = {
  handle: ManagedSessionHandle;
  opts: SessionOpenOptions;
  host: SharedAcpHost;
  permissions: Map<string, Permission>;
  turn?: Turn;
  closing: boolean;
};

const DEFAULT_IDLE_GRACE_MS = 3_000;

const MAX_ACP_PROMPT_MEDIA_BYTES = 20 * 1024 * 1024;

/**
 * Extract local media references (`@path/to/media` or `file:///path/to/media`) from prompt text
 * so ACP `session/prompt` natively attaches inline `image` blocks and `resource_link` blocks.
 */
export function buildAcpPromptBlocks(text: string, cwd: string): ObjectValue[] {
  const blocks: ObjectValue[] = [{ type: "text", text }];
  const seenPaths = new Set<string>();
  const refRegex = /(?:^|[\s(])(?:@([^\s,;()"`'<>]+)|((?:file:\/\/\/)[^\s,;()"`'<>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(text)) !== null) {
    const rawRef = match[1] ?? match[2];
    if (!rawRef) continue;
    let absPath: string;
    try {
      if (rawRef.startsWith("file://")) {
        absPath = fileURLToPath(rawRef.replace(/#.*$/, ""));
      } else {
        const cleaned = rawRef.replace(/#.*$/, "").replace(/:\d+(?:-\d+)?$/, "");
        absPath = isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
      }
      if (seenPaths.has(absPath) || !existsSync(absPath)) continue;
      const st = statSync(absPath);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_ACP_PROMPT_MEDIA_BYTES) continue;
      const bytes = readFileSync(absPath);
      const media = detectMediaType(absPath, bytes);
      if (!media) continue;
      seenPaths.add(absPath);
      if (media.mediaKind === "image") {
        blocks.push({
          type: "image",
          data: bytes.toString("base64"),
          mimeType: media.mimeType,
          uri: pathToFileURL(absPath).href,
        });
      } else {
        blocks.push({
          type: "resource_link",
          uri: pathToFileURL(absPath).href,
          name: basename(absPath),
          mimeType: media.mimeType,
        });
      }
    } catch {
      /* Ignore invalid or unreadable candidate paths in prompt text. */
    }
  }
  return blocks;
}
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" ? value as ObjectValue : {};
}

function selectAvailableModelId(requestedModel: string | undefined, modelsPayload: unknown): string | undefined {
  if (!requestedModel?.trim()) return undefined;
  const resolved = resolveModelAndEffort({ model: requestedModel }).modelId;
  const modelsObj = object(modelsPayload);
  const availableList = Array.isArray(modelsObj.availableModels) ? modelsObj.availableModels : [];
  const availableIds = new Set<string>(
    availableList
      .map(item => String(object(item).modelId ?? "").trim())
      .filter(Boolean),
  );
  if (availableIds.size === 0) return resolved;
  if (availableIds.has(resolved)) return resolved;
  if (availableIds.has(requestedModel.trim())) return requestedModel.trim();

  const { base } = extractEffortFromModelId(resolved);
  for (const fallbackEffort of ["high", "medium", "low"] as const) {
    const candidate = `${base}-${fallbackEffort}`;
    if (availableIds.has(candidate)) return candidate;
  }
  if (availableIds.has(base)) return base;
  return resolved;
}

function buildHostKey(opts: SessionOpenOptions): string {
  return JSON.stringify([
    resolve(opts.cwd),
    opts.agent ?? "",
    Boolean(opts.autoApprovePermissions),
    opts.env?.HYDROGEN_ALLOWED_TOOLS ?? "",
    opts.env?.HYDROGEN_SOCKET_PATH ?? opts.env?.HYDROGEN_DAEMON_ADDR ?? "",
    opts.env?.HYDROGEN_ROLE ?? "",
    opts.env?.HYDROGEN_DEPTH ?? "",
  ]);
}

function buildHostEnv(optsEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...optsEnv,
    JETSKI_APP_DATA_DIR: HYDROGEN_APP_DATA_REL_DIR,
  };
  // Strip per-session identity variables so hooks spawned by a shared host resolve via conversationId.
  delete env.HYDROGEN_SESSION_ID;
  delete env.HYDROGEN_AGENT_ID;
  delete env.HYDROGEN_TASK_PATH;
  delete env.HYDROGEN_EPOCH;
  delete env.HYDROGEN_CONVERSATION_ID;
  return env;
}

function usage(value: unknown): SessionUsage | undefined {
  const data = object(value);
  const input = data.inputTokens ?? data.input_tokens ?? data.used;
  const output = data.outputTokens ?? data.output_tokens;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  const thinking = data.thinkingTokens ?? data.thinking_tokens;
  const cache = data.cacheReadTokens ?? data.cache_read_tokens;
  const size = data.contextWindow ?? data.size;
  const rawInput = typeof input === "number" ? input : 0;
  const cacheTokens = typeof cache === "number" ? cache : 0;
  const totalInput = rawInput + cacheTokens;
  const result: SessionUsage = {
    inputTokens: totalInput,
    outputTokens: typeof output === "number" ? output : 0,
    cumulative: true,
  };
  if (typeof thinking === "number") result.thinkingTokens = thinking;
  if (typeof cache === "number") result.cacheReadTokens = cache;
  if (typeof size === "number") result.contextWindow = size;
  return result;
}

export class AcpSessionAdapter implements SessionAdapter {
  readonly backend = "acp" as const;
  private readonly sessions = new Map<string, Session>();
  private readonly hosts = new Map<string, SharedAcpHost>();
  private nextId = 1;

  constructor(private readonly idleGraceMs = DEFAULT_IDLE_GRACE_MS) {}

  async open(opts: SessionOpenOptions): Promise<ManagedSessionHandle> {
    const host = await this.acquireHost(opts);
    const handle: ManagedSessionHandle = {
      sessionId: randomUUID(),
      backend: this.backend,
      conversationId: "",
      pid: host.child?.pid,
    };
    const session: Session = {
      handle,
      opts,
      host,
      permissions: new Map(),
      closing: false,
    };
    try {
      let result: ObjectValue | undefined;
      let resumed = false;
      const resumeId = opts.resumeSessionId?.trim();
      if (resumeId) {
        try {
          result = await this.request(host, "session/load", {
            ...this.sessionParams(host, opts),
            sessionId: resumeId,
          });
          handle.conversationId = resumeId;
          resumed = true;
        } catch (error) {
          if (host.failure || host.disposing || !host.child) throw error;
          result = undefined;
        }
      }
      if (!result) {
        result = await this.request(host, "session/new", this.sessionParams(host, opts));
        if (typeof result.sessionId !== "string" || !result.sessionId) {
          throw new Error("ACP session/new did not return a sessionId");
        }
        handle.conversationId = result.sessionId;
        resumed = false;
      }

      handle.resumed = resumed;
      handle.pid = host.child?.pid;
      this.sessions.set(handle.sessionId, session);
      host.activeSessions.add(handle.conversationId);
      host.sessionsByConversationId.set(handle.conversationId, session);

      const targetModel = selectAvailableModelId(opts.model, result.models);
      if (targetModel !== undefined && targetModel !== object(result.models).currentModelId) {
        await this.request(host, "session/set_model", {
          sessionId: handle.conversationId,
          modelId: targetModel,
        });
      }
      return handle;
    } catch (error) {
      this.sessions.delete(handle.sessionId);
      if (handle.conversationId) {
        host.activeSessions.delete(handle.conversationId);
        if (host.sessionsByConversationId.get(handle.conversationId) === session) {
          host.sessionsByConversationId.delete(handle.conversationId);
        }
        if (host.child && !host.failure && !host.disposing) {
          await this.waitAtMost(
            this.request(host, "session/close", { sessionId: handle.conversationId }).then(() => {}, () => {}),
            1000,
          );
        }
      }
      throw error;
    } finally {
      host.pendingOpens = Math.max(0, host.pendingOpens - 1);
      this.scheduleHostIdleCleanup(host);
    }
  }

  async resume(handle: ManagedSessionHandle, opts: SessionOpenOptions): Promise<ManagedSessionHandle> {
    if (handle.backend !== this.backend || !handle.conversationId) {
      throw new Error("ACP resume requires an ACP conversationId");
    }
    const existing = this.sessions.get(handle.sessionId);
    if (existing && (existing.turn || existing.closing)) {
      throw new Error("ACP session is busy or closing");
    }

    const host = await this.acquireHost(opts);
    const session: Session = existing && existing.host === host
      ? existing
      : {
          handle: { ...handle },
          opts,
          host,
          permissions: new Map(),
          closing: false,
        };
    session.opts = opts;
    session.host = host;

    try {
      const caps = object(host.capabilities.sessionCapabilities ?? host.capabilities.session_capabilities);
      const method = caps.resume !== undefined && caps.resume !== false ? "session/resume"
        : host.capabilities.loadSession === true || host.capabilities.load_session === true
          || (caps.load !== undefined && caps.load !== false) ? "session/load" : undefined;
      if (!method) throw new Error("ACP agent does not support session/resume or session/load");
      const result = await this.request(host, method, {
        ...this.sessionParams(host, opts),
        sessionId: handle.conversationId,
      });
      session.handle.conversationId = handle.conversationId;
      session.handle.pid = host.child?.pid;
      session.handle.resumed = true;
      this.sessions.set(session.handle.sessionId, session);
      host.activeSessions.add(handle.conversationId);
      host.sessionsByConversationId.set(handle.conversationId, session);

      const targetModel = selectAvailableModelId(opts.model, result.models);
      if (targetModel !== undefined && targetModel !== object(result.models).currentModelId) {
        await this.request(host, "session/set_model", {
          sessionId: session.handle.conversationId,
          modelId: targetModel,
        });
      }
      return session.handle;
    } catch (error) {
      if (!existing) {
        this.sessions.delete(session.handle.sessionId);
        host.activeSessions.delete(handle.conversationId);
        if (host.sessionsByConversationId.get(handle.conversationId) === session) {
          host.sessionsByConversationId.delete(handle.conversationId);
        }
      }
      throw error;
    } finally {
      host.pendingOpens = Math.max(0, host.pendingOpens - 1);
      this.scheduleHostIdleCleanup(host);
    }
  }

  async prompt(
    handle: ManagedSessionHandle, text: string,
    onEvent: (event: SessionEvent) => void, signal?: AbortSignal,
  ): Promise<PromptTurnResult> {
    const session = this.get(handle);
    if (session.turn || session.closing) throw new Error("ACP session already has an active prompt or is closing");
    const turn: Turn = { onEvent, text: "", aborted: false };
    session.turn = turn;
    const abort = () => { void this.cancel(handle).catch(() => {}); };
    try {
      if (signal?.aborted) {
        turn.aborted = true;
        const result = { conversationId: session.handle.conversationId, finalText: "", aborted: true, stopReason: "cancelled" };
        onEvent({ type: "done", ...result });
        return result;
      }
      // Register the prompt before observing aborts so cancel follows it on the wire.
      const response = this.request(session.host, "session/prompt", {
        sessionId: session.handle.conversationId,
        prompt: buildAcpPromptBlocks(text, session.opts.cwd),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const data = await response;
      const finalUsage = usage(data.usage) ?? turn.usage;
      const stopReason = typeof data.stopReason === "string" ? data.stopReason : undefined;
      const result: PromptTurnResult = {
        conversationId: session.handle.conversationId,
        finalText: turn.text,
        stopReason,
        usage: finalUsage,
        aborted: turn.aborted || stopReason === "cancelled",
      };
      onEvent({ type: "done", finalText: result.finalText, stopReason, usage: finalUsage });
      return result;
    } catch (error) {
      onEvent({ type: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      // A permission request cannot outlive the turn that issued it.
      for (const [id, permission] of session.permissions) {
        this.replyPermission(session.host, permission);
        session.permissions.delete(id);
      }
      session.turn = undefined;
    }
  }

  async respondPermission(
    handle: ManagedSessionHandle, requestId: string,
    outcome: { approved: boolean; reason?: string },
  ): Promise<void> {
    const session = this.get(handle);
    const permission = session.permissions.get(requestId);
    if (!permission) throw new Error(`Unknown ACP permission request: ${requestId}`);
    session.permissions.delete(requestId);
    this.replyPermission(session.host, permission, outcome.approved);
  }

  async cancel(handle: ManagedSessionHandle): Promise<void> {
    const session = this.get(handle);
    if (!session.turn) return;
    session.turn.aborted = true;
    this.send(session.host, {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: session.handle.conversationId },
    });
    for (const permission of session.permissions.values()) this.replyPermission(session.host, permission);
    session.permissions.clear();
  }

  async setModel(handle: ManagedSessionHandle, modelId: string): Promise<void> {
    const session = this.get(handle);
    if (session.turn || session.closing) throw new Error("ACP session is busy or closing");
    const resolvedModelId = resolveModelAndEffort({ model: modelId }).modelId;
    await this.request(session.host, "session/set_model", {
      sessionId: session.handle.conversationId,
      modelId: resolvedModelId,
    });
  }

  async close(handle: ManagedSessionHandle): Promise<void> {
    const session = this.sessions.get(handle.sessionId);
    if (!session || session.closing) return;
    session.closing = true;
    const host = session.host;
    try {
      if (host.child && !host.failure && !host.disposing) {
        await this.cancel(handle);
        const caps = object(host.capabilities.sessionCapabilities ?? host.capabilities.session_capabilities);
        if (caps.close !== false && session.handle.conversationId) {
          await this.waitAtMost(
            this.request(host, "session/close", {
              sessionId: session.handle.conversationId,
            }).then(() => {}, () => {}),
            2000,
          );
        }
      }
    } finally {
      for (const permission of session.permissions.values()) {
        if (host.child && !host.failure && !host.disposing) {
          try { this.replyPermission(host, permission); } catch { /* Ignore closed pipe. */ }
        }
      }
      session.permissions.clear();
      this.sessions.delete(handle.sessionId);
      if (session.handle.conversationId) {
        host.activeSessions.delete(session.handle.conversationId);
        if (host.sessionsByConversationId.get(session.handle.conversationId) === session) {
          host.sessionsByConversationId.delete(session.handle.conversationId);
        }
      }
      session.handle.pid = undefined;
      this.scheduleHostIdleCleanup(host);
    }
  }

  async closeAndFlushHost(handle: ManagedSessionHandle): Promise<void> {
    const session = this.sessions.get(handle.sessionId);
    const host = session?.host;
    await this.close(handle);
    if (host && host.activeSessions.size === 0 && host.pendingOpens === 0) {
      if (this.hosts.get(host.hostKey) === host) {
        this.hosts.delete(host.hostKey);
      }
      await this.terminateHost(host);
    }
  }

  private get(handle: ManagedSessionHandle): Session {
    const session = this.sessions.get(handle.sessionId);
    if (!session || handle.backend !== this.backend) throw new Error("Unknown ACP session");
    return session;
  }

  private async acquireHost(opts: SessionOpenOptions): Promise<SharedAcpHost> {
    const hostKey = buildHostKey(opts);
    let host = this.hosts.get(hostKey);
    if (host && (host.disposing || host.failure)) {
      this.hosts.delete(hostKey);
      host = undefined;
    }
    if (!host) {
      host = {
        hostKey,
        cwd: resolve(opts.cwd),
        agent: opts.agent,
        autoApprovePermissions: Boolean(opts.autoApprovePermissions),
        env: buildHostEnv(opts.env),
        capabilities: {},
        pending: new Map(),
        activeSessions: new Set(),
        sessionsByConversationId: new Map(),
        pendingOpens: 0,
        stderr: "",
        disposing: false,
      };
      this.hosts.set(hostKey, host);
      const created = host;
      created.initPromise = this.startHost(created).catch((error) => {
        if (this.hosts.get(hostKey) === created) this.hosts.delete(hostKey);
        void this.terminateHost(created);
        throw error;
      });
    }

    if (host.idleTimer) {
      clearTimeout(host.idleTimer);
      host.idleTimer = undefined;
    }
    host.pendingOpens += 1;
    try {
      await host.initPromise;
      if (!host.child || host.failure || host.disposing) {
        throw host.failure ?? new Error("ACP host process is not running");
      }
      return host;
    } catch (error) {
      host.pendingOpens = Math.max(0, host.pendingOpens - 1);
      this.scheduleHostIdleCleanup(host);
      throw error;
    }
  }

  private async startHost(host: SharedAcpHost): Promise<void> {
    await host.exited;
    ensureHydrogenAppDataDir();
    host.failure = undefined;
    host.stderr = "";
    const args = ["acp", "--stdio", "--app_data_dir", HYDROGEN_APP_DATA_REL_DIR];
    if (host.agent) args.push("--agent", host.agent);
    if (host.autoApprovePermissions) args.push("--dangerously-skip-permissions");
    const child = spawn("agy", args, {
      cwd: host.cwd,
      env: host.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    host.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { host.stderr = (host.stderr + chunk).slice(-32768); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const fail = (message: string) => {
      if (host.failure) return;
      const error = new Error(`${message}${host.stderr ? `\n${host.stderr}` : ""}`);
      host.failure = error;
      for (const pending of host.pending.values()) pending.reject(error);
      host.pending.clear();
      for (const session of host.sessionsByConversationId.values()) {
        session.permissions.clear();
        session.handle.pid = undefined;
      }
      if (host.idleTimer) {
        clearTimeout(host.idleTimer);
        host.idleTimer = undefined;
      }
      if (this.hosts.get(host.hostKey) === host) {
        this.hosts.delete(host.hostKey);
      }
    };
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.receive(host, object(JSON.parse(line)));
      } catch (error) {
        fail(`ACP message handling failed: ${error instanceof Error ? error.message : String(error)}`);
        void this.terminateHost(host);
      }
    });
    child.on("error", (error) => fail(`ACP process error: ${error.message}`));
    child.stdin.on("error", (error) => {
      fail(`ACP stdin error: ${error.message}`);
      void this.terminateHost(host);
    });
    host.exited = new Promise<void>((resolveExited) => {
      child.once("close", (code, signal) => {
        lines.close();
        fail(`ACP process exited (code=${code}, signal=${signal})`);
        host.child = undefined;
        resolveExited();
      });
    });
    const initialized = await this.request(host, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "hydrogen-harness", version: "1.0.0" },
    });
    host.capabilities = object(initialized.agentCapabilities);
  }

  private scheduleHostIdleCleanup(host: SharedAcpHost): void {
    if (host.disposing || host.idleTimer) return;
    if (host.activeSessions.size > 0 || host.pendingOpens > 0) return;
    if (!host.child && !host.initPromise) return;
    host.idleTimer = setTimeout(() => {
      host.idleTimer = undefined;
      if (host.disposing || host.activeSessions.size > 0 || host.pendingOpens > 0) return;
      if (this.hosts.get(host.hostKey) === host) {
        this.hosts.delete(host.hostKey);
      }
      void this.terminateHost(host);
    }, this.idleGraceMs);
    host.idleTimer.unref?.();
  }

  private sessionParams(host: SharedAcpHost, opts: SessionOpenOptions): ObjectValue {
    const servers = opts.mcpServers ?? {};
    const entries = Array.isArray(servers)
      ? servers.map((server: unknown) => [object(server).name, server] as const)
      : Object.entries(servers);
    const params: ObjectValue = {
      cwd: opts.cwd,
      mcpServers: entries.map(([name, value]) => {
        const server = object(value);
        return {
          name,
          command: server.command,
          args: server.args ?? [],
          env: Array.isArray(server.env)
            ? server.env
            : Object.entries(object(server.env)).map(([key, val]) => ({ name: key, value: val })),
        };
      }),
    };
    if (object(host.capabilities._meta).antigravity) {
      const antigravity: ObjectValue = {};
      if (opts.appendSystemPrompt !== undefined) {
        antigravity.systemPrompt = { append: opts.appendSystemPrompt };
      }
      if (opts.model !== undefined) antigravity.model = opts.model;
      params._meta = { antigravity };
    }
    return params;
  }

  private send(host: SharedAcpHost, message: ObjectValue): void {
    if (host.failure) throw host.failure;
    if (!host.child?.stdin.writable) throw new Error("ACP process is not running; resume the session first");
    host.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(host: SharedAcpHost, method: string, params: ObjectValue): Promise<ObjectValue> {
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      host.pending.set(id, { resolve: resolveRequest, reject });
      try {
        this.send(host, { jsonrpc: "2.0", id, method, params });
      } catch (error) {
        host.pending.delete(id);
        reject(error);
      }
    });
  }

  private resolveTargetSession(host: SharedAcpHost, params: ObjectValue): Session | undefined {
    const convId = typeof params.sessionId === "string" ? params.sessionId : "";
    if (convId) return host.sessionsByConversationId.get(convId);
    const activeTurns = [...host.sessionsByConversationId.values()].filter(session => Boolean(session.turn));
    return activeTurns.length === 1 ? activeTurns[0] : undefined;
  }

  private receive(host: SharedAcpHost, message: ObjectValue): void {
    const id = message.id;
    const hasId = typeof id === "number" || typeof id === "string";
    if (typeof message.method !== "string") {
      if (!hasId) return;
      const pending = host.pending.get(id);
      if (!pending) return;
      host.pending.delete(id);
      if (message.error) {
        const error = object(message.error);
        pending.reject(new Error(`ACP RPC error ${error.code}: ${error.message}${host.stderr ? `\n${host.stderr}` : ""}`));
      } else {
        pending.resolve(object(message.result));
      }
      return;
    }

    const params = object(message.params);
    if (hasId) {
      if (message.method === "session/request_permission") {
        const permission: Permission = {
          id,
          options: Array.isArray(params.options) ? params.options.map(object) : [],
        };
        const session = this.resolveTargetSession(host, params);
        if (!session || session.turn?.aborted || !session.turn) {
          this.replyPermission(host, permission);
        } else {
          const requestId = String(id);
          session.permissions.set(requestId, permission);
          const tool = object(params.toolCall);
          session.turn.onEvent({
            type: "permission_request",
            requestId,
            toolName: String(tool.name ?? tool.title ?? tool.kind ?? "tool"),
            title: typeof tool.title === "string" ? tool.title : undefined,
            rawInput: tool.rawInput,
          });
        }
      } else {
        this.send(host, {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unsupported method: ${message.method}` },
        });
      }
      return;
    }

    if (message.method !== "session/update") return;
    const convId = typeof params.sessionId === "string" ? params.sessionId : "";
    if (!convId) return;
    const session = host.sessionsByConversationId.get(convId);
    if (!session || !session.turn) return;
    const update = object(params.update);
    const turn = session.turn;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = object(update.content);
        if (content.type !== "text" || typeof content.text !== "string") break;
        const thought = update.sessionUpdate === "agent_thought_chunk";
        if (!thought) turn.text += content.text;
        turn.onEvent({ type: thought ? "thought_delta" : "text_delta", text: content.text });
        break;
      }
      case "tool_call":
        turn.onEvent({
          type: "tool_call",
          callId: String(update.toolCallId),
          name: String(update.title ?? update.kind ?? "tool"),
          status: String(update.status ?? "pending"),
          rawInput: update.rawInput,
        });
        break;
      case "tool_call_update":
        turn.onEvent({
          type: "tool_call_update",
          callId: String(update.toolCallId),
          status: String(update.status ?? "in_progress"),
          rawOutput: update.rawOutput ?? update.content,
        });
        break;
      case "usage_update": {
        const current = usage(update.usage ?? update);
        if (current) {
          turn.usage = current;
          turn.onEvent({ type: "usage", usage: current });
        }
        break;
      }
    }
  }

  private replyPermission(host: SharedAcpHost, permission: Permission, approved = false): void {
    const option = approved ? permission.options.find((option) => option.kind === "allow_once")
      ?? permission.options.find((option) => option.kind === "allow_always")
      ?? permission.options.find((option) => typeof option.kind === "string" && option.kind.startsWith("allow")) : undefined;
    this.send(host, {
      jsonrpc: "2.0",
      id: permission.id,
      result: {
        outcome: option && typeof option.optionId === "string"
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" },
      },
    });
  }

  private async waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([promise, new Promise<void>((resolveTimer) => { timer = setTimeout(resolveTimer, ms); })]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async terminateHost(host: SharedAcpHost): Promise<void> {
    host.disposing = true;
    if (host.idleTimer) {
      clearTimeout(host.idleTimer);
      host.idleTimer = undefined;
    }
    const child = host.child;
    if (!child) return;
    try { child.kill("SIGTERM"); } catch { /* Ignore already exited. */ }
    if (host.exited) await this.waitAtMost(host.exited, 2000);
    if (host.child === child) {
      try { child.kill("SIGKILL"); } catch { /* Ignore already exited. */ }
      await host.exited;
    }
  }
}
