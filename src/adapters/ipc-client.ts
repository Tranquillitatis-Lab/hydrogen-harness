import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { DaemonMethod, DaemonRequest, DaemonResponse } from "../core/protocol.js";

const HGY_TEMP_DIR = process.platform === "win32" ? tmpdir() : "/tmp";
export const GLOBAL_DAEMON_META_PATH = join(HGY_TEMP_DIR, "hgy_active_daemon.json");
export const DAEMONS_REGISTRY_DIR = join(HGY_TEMP_DIR, "hgy_daemons");

export function isPipePath(addr: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(addr);
}

export interface DaemonInstanceMeta {
  socketPath: string;
  addr?: string;
  projectRoot: string;
  sessionId?: string;
  pid: number;
  tuiPid?: number;
  updatedAt: number;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function getAncestorPids(maxDepth = 8): Set<number> {
  const ancestors = new Set<number>();
  if (process.platform === "win32") return ancestors;
  let current = process.ppid;
  for (let depth = 0; depth < maxDepth && Number.isSafeInteger(current) && current > 1; depth++) {
    ancestors.add(current);
    try {
      const out = execFileSync("ps", ["-o", "ppid=", "-p", String(current)], { encoding: "utf8", timeout: 500 }).trim();
      const next = Number(out);
      if (!Number.isSafeInteger(next) || next <= 1 || next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return ancestors;
}

export function isDescendantOf(targetPid: number): boolean {
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0) return false;
  return getAncestorPids().has(targetPid);
}

function isSubpath(root: string, candidate: string): boolean {
  const r = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  const c = process.platform === "win32" ? resolve(candidate).toLowerCase() : resolve(candidate);
  const rel = relative(r, c);
  return rel === "" || (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== "..");
}

function parseMeta(rawText: string): DaemonInstanceMeta | undefined {
  try {
    const raw = JSON.parse(rawText) as Partial<DaemonInstanceMeta>;
    const socketPath = typeof raw.socketPath === "string" && raw.socketPath
      ? raw.socketPath
      : (typeof raw.addr === "string" && raw.addr ? raw.addr : "");
    if (!socketPath || typeof raw.projectRoot !== "string" || !raw.projectRoot) return undefined;
    if (typeof raw.pid !== "number" || !isPidAlive(raw.pid)) return undefined;
    return {
      socketPath,
      addr: socketPath,
      projectRoot: resolve(raw.projectRoot),
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
      pid: raw.pid,
      tuiPid: typeof raw.tuiPid === "number" ? raw.tuiPid : undefined,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    };
  } catch {
    return undefined;
  }
}

export function resolveActiveDaemonForCurrentProcess(
  cwd?: string,
  options?: { strictProcessMatch?: boolean },
): DaemonInstanceMeta | undefined {
  const envSocket = (process.env.HYDROGEN_SOCKET_PATH || process.env.HYDROGEN_DAEMON_ADDR)?.trim();
  if (envSocket) {
    return {
      socketPath: envSocket,
      addr: envSocket,
      projectRoot: resolve(process.env.HYDROGEN_PROJECT_ROOT || cwd || process.cwd()),
      sessionId: process.env.HYDROGEN_SESSION_ID,
      pid: process.ppid,
      updatedAt: Date.now(),
    };
  }

  const liveRecords: DaemonInstanceMeta[] = [];
  if (existsSync(DAEMONS_REGISTRY_DIR)) {
    try {
      const files = readdirSync(DAEMONS_REGISTRY_DIR).filter(file => file.endsWith(".json"));
      for (const file of files) {
        try {
          const parsed = parseMeta(readFileSync(join(DAEMONS_REGISTRY_DIR, file), "utf8"));
          if (parsed) liveRecords.push(parsed);
        } catch { /* Ignore unreadable or concurrently deleted metadata. */ }
      }
    } catch { /* Ignore registry scan failure. */ }
  }

  if (liveRecords.length > 0) {
    // Prefer tui records and newer updates when multiple files refer to the same tree.
    liveRecords.sort((a, b) => (b.tuiPid ? 1 : 0) - (a.tuiPid ? 1 : 0) || b.updatedAt - a.updatedAt);
    const ancestors = getAncestorPids();
    const ancestorHit = liveRecords.find(
      record => (record.tuiPid !== undefined && ancestors.has(record.tuiPid)) || ancestors.has(record.pid),
    );
    if (ancestorHit) return ancestorHit;
  }

  if (options?.strictProcessMatch) return undefined;

  if (liveRecords.length > 0) {
    const targetCwd = resolve(cwd ?? process.cwd());
    const cwdMatches = liveRecords
      .filter(record => isSubpath(record.projectRoot, targetCwd))
      .sort((a, b) => b.projectRoot.length - a.projectRoot.length || b.updatedAt - a.updatedAt);
    if (cwdMatches.length > 0) return cwdMatches[0];
  }

  if (existsSync(GLOBAL_DAEMON_META_PATH)) {
    try {
      const fallback = parseMeta(readFileSync(GLOBAL_DAEMON_META_PATH, "utf8"));
      if (fallback) return fallback;
    } catch { /* Ignore stale global metadata. */ }
  }
  return undefined;
}

export interface IpcClientOptions {
  autoStart?: boolean;
  timeoutMs?: number;
  /** Trusted host metadata, never a model tool argument. */
  conversationId?: string;
}

export class DaemonRpcError extends Error {
  constructor(public readonly code: NonNullable<DaemonResponse["error"]>["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "DaemonRpcError";
  }
}

export function identityFromEnv(conversationId?: string): DaemonRequest["identity"] {
  const identity: DaemonRequest["identity"] = {};
  const sessionId = process.env.HYDROGEN_SESSION_ID;
  if (sessionId) identity.sessionId = sessionId;
  const role = process.env.HYDROGEN_ROLE;
  if (role !== undefined) {
    if (role !== "writer" && role !== "readonly") throw new Error("Invalid HYDROGEN_ROLE");
    identity.role = role;
  } else if (!sessionId) {
    // Track A's native main session is assigned by the daemon.
    identity.role = "writer";
  }
  for (const [key, name] of [["epoch", "HYDROGEN_EPOCH"], ["depth", "HYDROGEN_DEPTH"]] as const) {
    const value = process.env[name];
    if (value === undefined) continue;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`Invalid ${name}`);
    }
    identity[key] = Number(value);
  }
  if (conversationId) identity.conversationId = conversationId;
  return identity;
}

function unavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/** Each call owns one socket and closes it as soon as its response arrives. */
export class IpcClient {
  readonly projectRoot: string;

  constructor(projectRoot: string, private readonly opts: IpcClientOptions = {}) {
    this.projectRoot = resolve(projectRoot);
  }

  async address(): Promise<string> {
    const envAddr = (process.env.HYDROGEN_SOCKET_PATH || process.env.HYDROGEN_DAEMON_ADDR)?.trim();
    if (envAddr) return envAddr;
    const ancestorHit = resolveActiveDaemonForCurrentProcess(this.projectRoot, { strictProcessMatch: true });
    if (ancestorHit?.socketPath) return ancestorHit.socketPath;
    const resolved = resolveActiveDaemonForCurrentProcess(this.projectRoot);
    if (resolved?.socketPath && isSubpath(resolved.projectRoot, this.projectRoot)) {
      return resolved.socketPath;
    }
    try {
      const address = (await readFile(join(this.projectRoot, ".hydrogen/run/daemon.addr"), "utf8")).trim();
      if (address) return address;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (process.platform === "win32") {
      return `\\\\.\\pipe\\hy_${createHash("sha1").update(resolve(this.projectRoot)).digest("hex").slice(0, 12)}`;
    }
    return join(this.projectRoot, ".hydrogen/run/daemon.sock");
  }

  private async connect(timeoutMs = 1000): Promise<Socket> {
    const address = await this.address();
    return new Promise((resolveSocket, reject) => {
      const socket = createConnection(address);
      const timer = setTimeout(() => socket.destroy(new Error("Daemon connection timed out")), timeoutMs);
      const onError = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        resolveSocket(socket);
      });
    });
  }

  private async startAndConnect(): Promise<Socket> {
    const deadline = Date.now() + 3000;
    const runDirectory = join(this.projectRoot, ".hydrogen/run");
    await mkdir(runDirectory, { recursive: true });
    const lockPath = join(runDirectory, "daemon.spawn.lock");
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      try {
        lock = await open(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (lock) {
        // A concurrent starter may have finished before we acquired the lock.
        try {
          return await this.connect(Math.max(1, deadline - Date.now()));
        } catch (error) {
          if (!unavailable(error)) throw error;
        }
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
        const child = spawn(process.execPath, [join(repoRoot, "dist/entry/runtime-daemon.js"), this.projectRoot], {
          detached: true,
          stdio: "ignore",
        });
        await new Promise<void>((resolveSpawn, reject) => {
          child.once("error", reject);
          child.once("spawn", resolveSpawn);
        });
        child.unref();
      }
      while (Date.now() < deadline) {
        try {
          return await this.connect(deadline - Date.now());
        } catch (error) {
          if (!unavailable(error)) throw error;
        }
        await delay(Math.min(50, Math.max(0, deadline - Date.now())));
      }
      throw new Error("Daemon socket was not ready within 3000ms");
    } finally {
      if (lock) {
        await lock.close();
        await unlink(lockPath);
      }
    }
  }

  async call<T = unknown>(method: DaemonMethod, params: unknown): Promise<T> {
    let timeoutMs = this.opts.timeoutMs ?? 120_000;
    if (typeof params === "object" && params !== null && "timeoutMs" in params && typeof params.timeoutMs === "number") {
      timeoutMs = Math.max(timeoutMs, params.timeoutMs + 15_000);
    }
    const request: DaemonRequest = {
      id: randomUUID(), method, identity: identityFromEnv(this.opts.conversationId), params,
    };
    // Serialize before connecting, so a serialization error cannot leak a socket.
    const packet = JSON.stringify(request) + "\n";
    let socket: Socket;
    try {
      socket = await this.connect();
    } catch (error) {
      if (this.opts.autoStart === false || !unavailable(error)) throw error;
      socket = await this.startAndConnect();
    }
    return new Promise<T>((resolveResult, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolveResult(result as T);
      };
      const timer = setTimeout(() => finish(new Error("Daemon RPC timed out")), timeoutMs);
      socket.setEncoding("utf8");
      socket.on("error", error => finish(error));
      socket.once("end", () => finish(new Error("Daemon closed before replying")));
      socket.once("close", () => finish(new Error("Daemon closed before replying")));
      socket.on("data", chunk => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as DaemonResponse<T>;
          if (response.id !== request.id) throw new Error("Daemon response ID mismatch");
          if (!response.ok) {
            throw new DaemonRpcError(response.error?.code ?? "INTERNAL", response.error?.message ?? "Daemon RPC failed");
          }
          finish(undefined, response.result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.write(packet);
    });
  }
}
