import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import type { SessionUsage } from "../adapters/session.js";
import { fsGlob, normPath } from "../core/files.js";
import type { ApprovalMode, HandoffPacket, TimelineItem } from "../core/protocol.js";
import { runTurnWithHandover, type HydrogenRuntime } from "../core/runtime.js";
import { HydrogenError } from "../core/state.js";
import { COMMAND_SPECS, executeSlashOrShell, getGitSnapshot, listAvailableModels } from "./commands.js";

export interface WebUiHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const webRoot = join(packageRoot, "web");
const webDist = join(webRoot, "dist");
const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png",
};

function readToken(req: IncomingMessage, queryToken: string | null): string[] {
  const header = req.headers["x-hydrogen-token"];
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : undefined;
  const cookie = req.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("hydrogen_token="))?.slice(15);
  // Vite uses its own ?token= on the HMR socket; the Hydrogen cookie still authenticates it.
  return [typeof header === "string" ? header : undefined, bearer, queryToken, cookie]
    .filter((value): value is string => typeof value === "string");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function invalid(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function stringField(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== "string" || !body[key].trim()) invalid(`${key} must be a non-empty string`);
  return body[key] as string;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_048_576) invalid("Request body too large", 413);
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const value: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected JSON object");
  return value as Record<string, unknown>;
}

export async function startWebUi(
  runtime: HydrogenRuntime,
  opts: { port?: number; signal?: AbortSignal; noHmr?: boolean },
): Promise<WebUiHandle> {
  const token = randomBytes(24).toString("hex");
  const clients = new Set<ServerResponse>();
  let viteServer: ViteDevServer | undefined;
  let activeTurnId: string | null = null;
  let rotating = false;
  let lastUsage: SessionUsage | undefined;
  let gitCache = await getGitSnapshot(runtime.projectRoot);
  runtime.ensureThread();

  const authenticated = (req: IncomingMessage, url: URL) => {
    return readToken(req, url.searchParams.get("token")).some(candidate =>
      Buffer.byteLength(candidate) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(candidate), Buffer.from(token)));
  };
  const broadcast = (payload: unknown) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) client.write(frame);
  };
  const buildSnapshot = () => {
    const writerSessionId = runtime.state.writerSessionId;
    const contextStats = runtime.contextStats();
    return {
      projectRoot: runtime.projectRoot, model: runtime.currentModel, epoch: runtime.state.activeEpoch,
      writerSessionId, activeThreadId: runtime.activeThreadId, threads: runtime.listThreads(),
      approvalMode: runtime.approvalMode, autoCompact: runtime.autoCompact, hmrEnabled: Boolean(viteServer),
      busy: activeTurnId !== null, rotating, contextStats, handoverLevel: contextStats.level,
      writer: writerSessionId ? runtime.state.getSession(writerSessionId) : undefined,
      sessions: runtime.state.listSessions(), usage: lastUsage, checkpoint: runtime.state.getCheckpoint(),
      todos: runtime.todos(), pendingPermissions: runtime.listPendingPermissions(),
      subagents: runtime.state.listSubagents(), workflows: runtime.state.listWorkflows(),
      ptyJobs: runtime.state.listPtyJobs(), git: { isGitRepo: gitCache.isGitRepo, branch: gitCache.branch },
      timeline: runtime.state.listTimelineItems(runtime.activeThreadId),
    };
  };
  const broadcastState = () => broadcast({ type: "state_update", status: buildSnapshot() });
  const assertIdle = () => { if (activeTurnId || rotating) invalid("Runtime is busy or compacting", 409); };

  async function runPrompt(text: string, initialTurn: TimelineItem): Promise<void> {
    let turn = initialTurn;
    let continuing = false;
    try {
      await runTurnWithHandover(runtime, text, {
        turnId: turn.id,
        onEvent: event => {
          if (continuing) {
            // The runtime owns the continuation's persistent ID; reconcile onAfterTurn.
            continuing = false;
            turn = { ...initialTurn, id: randomUUID(), userText: "Continuing after handover", epoch: runtime.state.activeEpoch,
              assistantText: "", thoughtText: "", tools: [], createdAt: Date.now() };
            broadcast({ type: "turn_start", item: turn });
          }
          if (event.type === "text_delta") turn.assistantText = (turn.assistantText ?? "") + event.text;
          if (event.type === "thought_delta") turn.thoughtText = (turn.thoughtText ?? "") + event.text;
          if (event.type === "tool_call") {
            const previous = turn.tools!.find(tool => tool.callId === event.callId);
            if (previous) Object.assign(previous, event);
            else turn.tools!.push({ ...event });
          }
          if (event.type === "tool_call_update") {
            const tool = turn.tools!.find(tool => tool.callId === event.callId);
            if (tool) Object.assign(tool, event);
          }
          if (event.type === "usage") lastUsage = event.usage;
          if (event.type === "done") {
            if (event.finalText) turn.assistantText = event.finalText;
            if (event.usage) lastUsage = event.usage;
          }
          if (event.type === "error") turn.error = event.message;
          if (turn.id === initialTurn.id) runtime.state.upsertTimelineItem(turn);
          broadcast({ type: "session_event", turnId: turn.id, event });
          if (event.type === "permission_request") {
            broadcast({ type: "permission_request", request: { requestId: event.requestId, toolName: event.toolName,
              title: event.title, rawInput: event.rawInput } });
            broadcastState();
          }
        },
        onAfterTurn: meta => {
          const saved = runtime.state.listTimelineItems(initialTurn.threadId).filter(item => item.kind === "turn").at(-1)!;
          turn = { ...saved, aborted: meta.aborted, error: turn.error ?? saved.error };
          runtime.state.upsertTimelineItem(turn);
          broadcast({ type: "turn_end", turnId: turn.id, aborted: meta.aborted, error: turn.error });
          continuing = meta.hardRotation && meta.aborted;
          broadcastState();
        },
        onRotation: info => {
          const item = runtime.state.listTimelineItems(initialTurn.threadId).findLast(item => item.kind === "compact" && item.epoch === info.epoch);
          broadcast({ type: "rotation", item, ...info });
          lastUsage = undefined;
          broadcastState();
        },
      }, opts.signal);
    } catch (error) {
      turn.error = error instanceof Error ? error.message : String(error);
      if (runtime.state.listTimelineItems(turn.threadId).some(item => item.id === turn.id)) runtime.state.upsertTimelineItem(turn);
      broadcast({ type: "session_event", turnId: turn.id, event: { type: "error", message: turn.error } });
    } finally {
      activeTurnId = null;
      gitCache = await getGitSnapshot(runtime.projectRoot);
      broadcast({ type: "turn_end", turnId: turn.id, aborted: Boolean(turn.aborted), error: turn.error });
      broadcastState();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!authenticated(req, url)) { sendJson(res, 401, { error: "Unauthorized: valid token required" }); return; }
    if (req.method === "GET" && url.pathname === "/" && url.searchParams.get("token") === token) {
      res.setHeader("Set-Cookie", `hydrogen_token=${token}; HttpOnly; SameSite=Strict; Path=/`);
    }
    if (!url.pathname.startsWith("/api/")) {
      if (viteServer) { viteServer.middlewares(req, res); return; }
      if (req.method !== "GET" && req.method !== "HEAD") invalid("Method not allowed", 405);
      const asset = resolve(webDist, `.${decodeURIComponent(url.pathname)}`);
      if (relative(webDist, asset).startsWith("..")) invalid("Invalid asset path", 403);
      const path = existsSync(asset) && (await stat(asset)).isFile() ? asset : join(webDist, "index.html");
      const data = await readFile(path);
      res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(req.method === "HEAD" ? undefined : data);
      return;
    }
    if (req.method === "GET") {
      switch (url.pathname) {
        case "/api/status": sendJson(res, 200, buildSnapshot()); return;
        case "/api/commands": sendJson(res, 200, { commands: COMMAND_SPECS }); return;
        case "/api/models": sendJson(res, 200, { models: await listAvailableModels() }); return;
        case "/api/git": gitCache = await getGitSnapshot(runtime.projectRoot); sendJson(res, 200, gitCache); return;
        case "/api/files": {
          const q = url.searchParams.get("q") ?? "";
          sendJson(res, 200, { files: await fsGlob(runtime.projectRoot, { pattern: q ? `*${q}*` : "*", limit: 50 }) });
          return;
        }
        case "/api/artifact":
        case "/api/file": {
          const reqPath = url.searchParams.get("path") ?? "";
          const path = normPath(runtime.projectRoot, reqPath, { allowSpill: true });
          if (url.pathname === "/api/artifact" && !path.startsWith(realpathSync(join(runtime.projectRoot, ".hydrogen/spill")) + sep)) invalid("Only spill artifacts may be read here", 403);
          const handle = await open(path, "r");
          try {
            const metadata = await handle.stat();
            if (!metadata.isFile()) invalid("Expected a regular file");
            const buffer = Buffer.alloc(Math.min(metadata.size, 256 * 1024));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            sendJson(res, 200, { path: reqPath, text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: metadata.size > buffer.length });
          } finally { await handle.close(); }
          return;
        }
        case "/api/events":
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
          clients.add(res);
          res.write(`data: ${JSON.stringify({ type: "snapshot", status: buildSnapshot() })}\n\n`);
          res.on("close", () => clients.delete(res));
          return;
      }
    }
    if (req.method !== "POST") invalid("Not found", 404);
    const body = await readBody(req);
    switch (url.pathname) {
      case "/api/abort": await runtime.cancelMain(); sendJson(res, 200, { cancelled: activeTurnId !== null }); return;
      case "/api/permission": {
        const requestId = stringField(body, "requestId");
        if (!["allow_once", "allow_session", "deny"].includes(String(body.choice))) invalid("Invalid permission choice");
        runtime.resolvePermission(requestId, body.choice as "allow_once" | "allow_session" | "deny");
        broadcast({ type: "permission_resolved", requestId, choice: body.choice });
        break;
      }
      case "/api/checkpoint": {
        const update: Partial<HandoffPacket["semantic"]> = {};
        for (const key of ["activeGoal", "nextImmediateStep"] as const) {
          if (body[key] !== undefined) {
            if (typeof body[key] !== "string") invalid(`${key} must be a string`);
            update[key] = body[key];
          }
        }
        for (const key of ["verifiedFacts", "deadEndsTried"] as const) {
          if (body[key] !== undefined) {
            if (!Array.isArray(body[key]) || !body[key].every(value => typeof value === "string")) invalid(`${key} must be a string array`);
            update[key] = body[key] as string[];
          }
        }
        const checkpoint = runtime.handover.updateCheckpoint(update);
        broadcastState(); sendJson(res, 200, { checkpoint }); return;
      }
      case "/api/job": {
        if (!["poll", "stdin", "kill"].includes(String(body.action))) invalid("Invalid job action");
        const writer = runtime.state.writerSessionId;
        if (!writer) invalid("No active writer", 409);
        const result = await runtime.processes.execute(writer, { action: body.action as "poll" | "stdin" | "kill",
          jobId: stringField(body, "jobId"), input: typeof body.input === "string" ? body.input : undefined, yieldMs: 1000 });
        broadcastState(); sendJson(res, 200, result); return;
      }
      case "/api/compact": {
        assertIdle();
        if (body.instructions !== undefined && typeof body.instructions !== "string") invalid("instructions must be a string");
        rotating = true; broadcastState();
        try {
          const result = await runtime.compactMain(body.instructions as string | undefined);
          lastUsage = undefined;
          sendJson(res, 200, result);
        } finally { rotating = false; broadcastState(); }
        return;
      }
      case "/api/new":
      case "/api/thread": {
        assertIdle();
        if (body.title !== undefined && typeof body.title !== "string") invalid("title must be a string");
        const action = url.pathname === "/api/new" ? "create" : body.action;
        switch (action) {
          case "create": await runtime.createThread(body.title as string | undefined); break;
          case "switch": await runtime.switchThread(stringField(body, "threadId")); break;
          case "rename": runtime.renameThread(stringField(body, "threadId"), stringField(body, "title")); break;
          case "delete": await runtime.deleteThread(stringField(body, "threadId")); break;
          default: invalid("Invalid thread action");
        }
        lastUsage = undefined; break;
      }
      case "/api/settings":
        if (body.approvalMode !== undefined && !["plan", "auto-edit", "full-auto"].includes(String(body.approvalMode))) invalid("Invalid approval mode");
        if (body.autoCompact !== undefined && typeof body.autoCompact !== "boolean") invalid("autoCompact must be a boolean");
        if (body.model !== undefined) { assertIdle(); await runtime.setModel(stringField(body, "model")); lastUsage = undefined; }
        if (body.approvalMode !== undefined) runtime.setApprovalMode(body.approvalMode as ApprovalMode);
        if (body.autoCompact !== undefined) runtime.setAutoCompact(body.autoCompact as boolean);
        break;
      case "/api/prompt": {
        const text = stringField(body, "text");
        if (/^\s*[/!]/.test(text)) {
          // Read-only commands and /abort remain available while the writer runs.
          if ((activeTurnId || rotating) && !/^\s*\/(help|h|\?|status|todos|agents|workflows|jobs|diff|git|checkpoint|cp|abort|stop|cancel|exit|quit)\s*$/.test(text)) assertIdle();
          const result = await executeSlashOrShell(runtime, text, "web");
          if (result.handled) {
            if (result.action === "clear") {
              runtime.state.clearTimelineItems(runtime.activeThreadId);
              broadcast({ type: "clear_timeline" });
            } else {
              const item: TimelineItem = { id: randomUUID(), threadId: runtime.activeThreadId, kind: "command", userText: text,
                title: result.title, output: result.output, ok: result.ok, epoch: runtime.state.activeEpoch, createdAt: Date.now() };
              runtime.state.upsertTimelineItem(item);
              broadcast({ type: "command_item", item });
            }
            if (result.action === "reset" || result.action === "rotated") lastUsage = undefined;
            broadcastState(); sendJson(res, 200, result); return;
          }
        }
        assertIdle();
        const turn: TimelineItem = { id: randomUUID(), threadId: runtime.activeThreadId, kind: "turn", userText: text,
          assistantText: "", thoughtText: "", tools: [], epoch: runtime.state.activeEpoch, createdAt: Date.now() };
        runtime.state.upsertTimelineItem(turn);
        activeTurnId = turn.id;
        broadcast({ type: "turn_start", item: turn }); broadcastState();
        sendJson(res, 202, { turnId: turn.id });
        void runPrompt(text, turn);
        return;
      }
      default: invalid("Not found", 404);
    }
    broadcastState(); sendJson(res, 200, { ok: true });
  }

  const server = createServer((req, res) => {
    void route(req, res).catch(error => {
      const status = error.status ?? (error instanceof SyntaxError ? 400 : error instanceof HydrogenError
        ? (error.code === "PERMISSION_DENIED" ? 403 : 409) : error.code === "ENOENT" ? 404 : 500);
      if (res.headersSent) res.destroy(error);
      else sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  if (existsSync(join(webRoot, "src/main.tsx")) && process.env.HYDROGEN_NO_HMR !== "1" && !opts.noHmr) {
    const { createServer: createViteServer } = await import("vite");
    viteServer = await createViteServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server, path: "/__vite_hmr" } }, appType: "spa" });
    server.prependListener("upgrade", (req, socket) => {
      if (!authenticated(req, new URL(req.url ?? "/", "http://127.0.0.1"))) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });
  }
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("WebUI has no TCP address");
  const keepalive = setInterval(() => { for (const client of clients) client.write(": ping\n\n"); }, 15_000);
  const poll = setInterval(() => { if (clients.size && (activeTurnId || rotating)) broadcastState(); }, 1500);
  return {
    url: `http://127.0.0.1:${address.port}/?token=${token}`, port: address.port,
    close: async () => {
      clearInterval(keepalive); clearInterval(poll);
      for (const client of clients) client.end();
      clients.clear();
      await viteServer?.close();
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}
