import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  DAEMONS_REGISTRY_DIR,
  GLOBAL_DAEMON_META_PATH,
  isDescendantOf,
  isPidAlive,
  isPipePath,
  resolveActiveDaemonForCurrentProcess,
  type DaemonInstanceMeta,
} from "../adapters/ipc-client.js";
import type { DaemonMethod, DaemonRequest, DaemonResponse, HookCommonInput, SessionIdentity } from "../core/protocol.js";
import type { HydrogenRuntime } from "../core/runtime.js";

export {
  DAEMONS_REGISTRY_DIR,
  GLOBAL_DAEMON_META_PATH,
  isDescendantOf,
  isPidAlive,
  resolveActiveDaemonForCurrentProcess,
  type DaemonInstanceMeta,
};

const activeInProcessPrimaryLocks = new Set<string>();
const activeInProcessSockets = new Set<string>();
let inProcessSocketSeq = 0;

export function updateActiveDaemonMeta(meta: {
  socketPath: string;
  projectRoot: string;
  sessionId?: string;
  pid?: number;
  tuiPid?: number;
}): void {
  const pid = meta.pid ?? process.pid;
  const payload: DaemonInstanceMeta = {
    socketPath: meta.socketPath,
    addr: meta.socketPath,
    projectRoot: resolve(meta.projectRoot),
    sessionId: meta.sessionId,
    pid,
    tuiPid: meta.tuiPid,
    updatedAt: Date.now(),
  };
  const json = JSON.stringify(payload);
  mkdirSync(DAEMONS_REGISTRY_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(GLOBAL_DAEMON_META_PATH, json, { mode: 0o600 });
  writeFileSync(join(DAEMONS_REGISTRY_DIR, `daemon_${pid}.json`), json, { mode: 0o600 });
  if (meta.tuiPid !== undefined && Number.isSafeInteger(meta.tuiPid) && meta.tuiPid > 0) {
    writeFileSync(join(DAEMONS_REGISTRY_DIR, `tui_${meta.tuiPid}.json`), json, { mode: 0o600 });
  }
}

export function removeTuiDaemonMeta(tuiPid: number): void {
  if (!Number.isSafeInteger(tuiPid) || tuiPid <= 0) return;
  const path = join(DAEMONS_REGISTRY_DIR, `tui_${tuiPid}.json`);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch { /* Ignore cleanup error. */ }
}

function cleanupDaemonMeta(pid: number): void {
  const daemonMetaPath = join(DAEMONS_REGISTRY_DIR, `daemon_${pid}.json`);
  try {
    if (existsSync(daemonMetaPath)) unlinkSync(daemonMetaPath);
  } catch { /* Ignore. */ }
  try {
    if (existsSync(DAEMONS_REGISTRY_DIR)) {
      for (const file of readdirSync(DAEMONS_REGISTRY_DIR)) {
        if (!file.startsWith("tui_") || !file.endsWith(".json")) continue;
        const fullPath = join(DAEMONS_REGISTRY_DIR, file);
        try {
          const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as { pid?: number };
          if (parsed.pid === pid) unlinkSync(fullPath);
        } catch { /* Ignore. */ }
      }
    }
  } catch { /* Ignore. */ }
  try {
    if (existsSync(GLOBAL_DAEMON_META_PATH)) {
      const parsed = JSON.parse(readFileSync(GLOBAL_DAEMON_META_PATH, "utf8")) as { pid?: number };
      if (!parsed.pid || parsed.pid === pid) unlinkSync(GLOBAL_DAEMON_META_PATH);
    }
  } catch { /* Ignore. */ }
}

function cleanupStaleSockets(directory: string): void {
  try {
    for (const file of readdirSync(directory)) {
      const match = /^daemon_(\d+)(?:_\d+)?\.sock$/.exec(file);
      if (!match) continue;
      const pid = Number(match[1]);
      const fullPath = join(directory, file);
      if (activeInProcessSockets.has(fullPath)) continue;
      if (!Number.isSafeInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
        try { unlinkSync(fullPath); } catch { /* Ignore concurrent deletion. */ }
      }
    }
  } catch { /* Ignore directory scan failure. */ }
}

function readLivePid(pidPath: string): number | undefined {
  if (!existsSync(pidPath)) return undefined;
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    if (pid === process.pid) {
      return activeInProcessPrimaryLocks.has(pidPath) ? pid : undefined;
    }
    return isPidAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function secondarySocketPath(projectRoot: string, directory: string): string {
  const hash = createHash("sha1").update(resolve(projectRoot)).digest("hex").slice(0, 12);
  if (process.platform === "win32") {
    const seq = ++inProcessSocketSeq;
    return `\\\\.\\pipe\\hy_${hash}_${process.pid}_${seq}`;
  }
  const baseName = `daemon_${process.pid}.sock`;
  const local = join(directory, baseName);
  const candidate = Buffer.byteLength(local) < 96 ? local : `/tmp/hy_${hash}_${process.pid}.sock`;
  if (!activeInProcessSockets.has(candidate)) return candidate;
  inProcessSocketSeq += 1;
  const seqName = `daemon_${process.pid}_${inProcessSocketSeq}.sock`;
  const localSeq = join(directory, seqName);
  return Buffer.byteLength(localSeq) < 96 ? localSeq : `/tmp/hy_${hash}_${process.pid}_${inProcessSocketSeq}.sock`;
}

export async function startRuntimeDaemon(runtime: HydrogenRuntime): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const directory = join(runtime.projectRoot, ".hydrogen/run");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  cleanupStaleSockets(directory);

  const pidPath = join(directory, "daemon.pid");
  const addrPath = join(directory, "daemon.addr");
  const primaryLocalSock = join(directory, "daemon.sock");

  let isPrimary = false;
  if (readLivePid(pidPath) === undefined) {
    if (existsSync(pidPath)) {
      try { unlinkSync(pidPath); } catch { /* Ignore race. */ }
      for (const stale of [primaryLocalSock, runtime.daemonAddr, addrPath]) {
        if (!isPipePath(stale) && !activeInProcessSockets.has(stale) && existsSync(stale)) {
          try { unlinkSync(stale); } catch { /* Ignore race. */ }
        }
      }
    }
    try {
      writeFileSync(pidPath, String(process.pid), { flag: "wx", mode: 0o600 });
      activeInProcessPrimaryLocks.add(pidPath);
      isPrimary = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another daemon won the primary lock race; never kill it, bind an isolated secondary socket instead.
      isPrimary = false;
    }
  }

  const socketPath = isPrimary
    ? runtime.daemonAddr
    : secondarySocketPath(runtime.projectRoot, directory);
  activeInProcessSockets.add(socketPath);
  if (!isPrimary) {
    (runtime as { daemonAddr: string }).daemonAddr = socketPath;
  }

  const sockets = new Set<Socket>();
  const requests = new Set<Promise<void>>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { socket.destroy(); });
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", line => {
      const task = (async () => {
        let response: DaemonResponse;
        try {
          const request = JSON.parse(line) as DaemonRequest;
          if (typeof request.id !== "string" || typeof request.method !== "string" || !request.identity) {
            throw new Error("Expected a daemon request with id, method and identity");
          }
          response = await runtime.handle(request);
        } catch (error) { response = { id: "", ok: false, error: { code: "INVALID_INPUT", message: String(error) } }; }
        if (socket.writable && !socket.destroyed) socket.write(JSON.stringify(response) + "\n");
      })();
      requests.add(task);
      void task.finally(() => requests.delete(task));
    });
    socket.on("close", () => lines.close());
  });
  try {
    if (!isPipePath(socketPath) && existsSync(socketPath)) unlinkSync(socketPath);
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.removeListener("error", reject); resolveListen(); });
    });
    if (!isPipePath(socketPath)) chmodSync(socketPath, 0o600);
    if (isPrimary) {
      writeFileSync(addrPath, socketPath + "\n", { mode: 0o600 });
    }
    updateActiveDaemonMeta({
      socketPath,
      projectRoot: runtime.projectRoot,
      sessionId: runtime.state.writerSessionId,
      pid: process.pid,
    });
  } catch (error) {
    server.close();
    activeInProcessSockets.delete(socketPath);
    if (isPrimary) {
      activeInProcessPrimaryLocks.delete(pidPath);
      if (existsSync(pidPath)) {
        try {
          if (readFileSync(pidPath, "utf8").trim() === String(process.pid)) unlinkSync(pidPath);
        } catch { /* Ignore. */ }
      }
    }
    throw error;
  }
  return {
    socketPath,
    close: async () => {
      const closed = new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      for (const socket of sockets) socket.destroy();
      await runtime.dispose();
      await Promise.all(requests);
      await closed;
      activeInProcessSockets.delete(socketPath);
      if (!isPipePath(socketPath) && existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* Ignore. */ }
      }
      if (isPrimary) {
        activeInProcessPrimaryLocks.delete(pidPath);
        try {
          if (existsSync(pidPath) && readFileSync(pidPath, "utf8").trim() === String(process.pid)) unlinkSync(pidPath);
        } catch { /* Ignore. */ }
        try {
          if (existsSync(addrPath) && readFileSync(addrPath, "utf8").trim() === socketPath) unlinkSync(addrPath);
        } catch { /* Ignore. */ }
      }
      cleanupDaemonMeta(process.pid);
    },
  };
}

export function daemonRequest(address: string, request: DaemonRequest): Promise<unknown> {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(address);
    let received = false;
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.once("error", reject);
    socket.once("close", () => {
      lines.close();
      if (!received) reject(new Error("Hydrogen daemon disconnected without a response"));
    });
    lines.on("line", line => {
      try {
        const response = JSON.parse(line) as DaemonResponse;
        if (response.id !== request.id) throw new Error("Daemon response id mismatch");
        received = true;
        socket.end();
        if (response.ok) resolveRequest(response.result);
        else reject(new Error(`${response.error?.code}: ${response.error?.message}`));
      } catch (error) { socket.destroy(); reject(error); }
    });
  });
}

function connectionFromEnv(): { address: string; identity: SessionIdentity } {
  const root = process.env.HYDROGEN_PROJECT_ROOT;
  const sessionId = process.env.HYDROGEN_SESSION_ID;
  const role = process.env.HYDROGEN_ROLE;
  const epoch = Number(process.env.HYDROGEN_EPOCH);
  const depth = Number(process.env.HYDROGEN_DEPTH);
  if (!root || !sessionId || (role !== "writer" && role !== "readonly") ||
      !Number.isSafeInteger(epoch) || !Number.isSafeInteger(depth)) throw new Error("Missing Hydrogen session environment");
  const address = process.env.HYDROGEN_SOCKET_PATH
    ?? process.env.HYDROGEN_DAEMON_ADDR
    ?? resolveActiveDaemonForCurrentProcess(root)?.socketPath
    ?? readFileSync(join(root, ".hydrogen/run/daemon.addr"), "utf8").trim();
  return { address, identity: { sessionId, role, epoch, depth } };
}

async function runMcpShim(): Promise<void> {
  const { address, identity } = connectionFromEnv();
  const [{ createMcpServer }, { StdioServerTransport }] = await Promise.all([
    import("../adapters/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
  ]);
  const server = createMcpServer({
    call: async <T>(method: DaemonMethod, params: unknown) =>
      await daemonRequest(address, { id: randomUUID(), method, identity, params }) as T,
  }, identity.role);
  await server.connect(new StdioServerTransport());
}

async function runHook(): Promise<void> {
  const { address, identity } = connectionFromEnv();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookCommonInput;
  const method = ({ SessionStart: "session.register", PreToolUse: "hook.preToolUse", PostToolUse: "hook.postToolUse",
    PreInvocation: "hook.preInvocation", Stop: "hook.stop" } as const)[input.hookEventName];
  if (!method) throw new Error(`Unknown hook: ${input.hookEventName}`);
  const result = await daemonRequest(address, { id: randomUUID(), method, identity, params: input });
  process.stdout.write(JSON.stringify(result) + "\n");
}

async function main(): Promise<void> {
  if (process.argv.includes("--mcp-shim")) return runMcpShim();
  if (process.argv.includes("--hook")) return runHook();
  const { HydrogenRuntime } = await import("../core/runtime.js");
  const cwdIndex = process.argv.indexOf("--cwd");
  const runtime = new HydrogenRuntime(cwdIndex < 0 ? process.argv[2] ?? process.cwd() : resolve(process.argv[cwdIndex + 1]));
  const daemon = await startRuntimeDaemon(runtime);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void daemon.close().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
}
