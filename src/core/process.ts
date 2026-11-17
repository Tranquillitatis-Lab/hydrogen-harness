import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveReadPath } from "./files.js";
import { spillOutput, type OutputSpill } from "./output.js";
import { LIMITS, type BashInput, type SpillResult } from "./protocol.js";
import { HydrogenError, StateStore, type PtyJobRecord } from "./state.js";

const DEFAULT_TOOL_PATHS = process.platform === "darwin"
  ? [
      join(homedir(), ".local/bin"),
      "/opt/homebrew/bin",
      "/opt/anaconda3/bin",
      join(homedir(), ".nvm/versions/node/v24.15.0/bin"),
      join(homedir(), ".local/share/uv/python/cpython-3.11-macos-aarch64-none/bin"),
      "/Library/TeX/texbin",
    ]
  : process.platform === "win32"
    ? [join(homedir(), ".local", "bin")]
    : [join(homedir(), ".local/bin")];

function buildEnvPath(basePath = process.env.PATH ?? ""): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const entry of [...DEFAULT_TOOL_PATHS, ...basePath.split(delimiter)]) {
    if (entry && !seen.has(entry)) {
      seen.add(entry);
      parts.push(entry);
    }
  }
  return parts.join(delimiter);
}

export interface BashResult extends SpillResult {
  output: string;
  jobId: string;
  alive: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface Job {
  record: PtyJobRecord;
  child: ChildProcessWithoutNullStreams;
  chunks: Buffer[];
  bufferedBytes: number;
  totalBytes: number;
  cursor: number;
  closed: Promise<void>;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function groupAlive(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return false;
  if (process.platform === "win32") {
    try { process.kill(pgid, 0); return true; }
    catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  try { process.kill(-pgid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pgid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch { /* Ignore if already exited. */ }
    return;
  }
  try { process.kill(-pgid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

export class ProcessManager {
  private readonly jobs = new Map<string, Job>();
  private readonly starting = new Set<Promise<Job>>();
  private readonly outputSpill: OutputSpill;
  private disposed = false;

  constructor(
    private readonly projectRoot: string,
    private readonly state: StateStore,
    outputSpill?: OutputSpill,
  ) {
    this.outputSpill = outputSpill ?? ((label, text, maxBytes, options) =>
      spillOutput(projectRoot, label, text, maxBytes, options));
  }

  async execute(sessionId: string, input: BashInput): Promise<BashResult> {
    if (this.disposed) throw new HydrogenError("INVALID_INPUT", "ProcessManager is disposed");
    const session = this.state.getSession(sessionId);
    if (!session || session.role === "readonly") {
      throw new HydrogenError("PERMISSION_DENIED", "A readonly session cannot use bash");
    }
    const action = input.action ?? "exec";
    if (action !== "poll") this.state.assertWriteLease(sessionId);

    let waitBudget: number;
    if (action === "exec" && input.background === true) {
      const requestedBg = input.yieldMs ?? 1_500;
      if (!Number.isFinite(requestedBg)) throw new HydrogenError("INVALID_INPUT", "yieldMs must be finite");
      waitBudget = Math.min(Math.max(0, Math.floor(requestedBg)), 2_000);
    } else {
      const requestedYield = input.timeoutMs ?? input.yieldMs ?? LIMITS.DEFAULT_YIELD_MS;
      if (!Number.isFinite(requestedYield)) throw new HydrogenError("INVALID_INPUT", "timeoutMs/yieldMs must be finite");
      waitBudget = Math.min(LIMITS.MAX_YIELD_MS, Math.max(200, Math.floor(requestedYield)));
    }

    let job: Job;
    if (action === "exec") {
      if (!input.command?.trim()) throw new HydrogenError("INVALID_INPUT", "exec requires command");
      const starting = this.start(sessionId, input.command, input.cwd);
      this.starting.add(starting);
      try { job = await starting; }
      finally { this.starting.delete(starting); }
    } else {
      const found = input.jobId ? this.jobs.get(input.jobId) : undefined;
      if (!found) {
        throw new HydrogenError("INVALID_INPUT", "Unknown jobId");
      }
      job = found;
      if (action === "kill") {
        await this.terminate(job);
        return this.read(job);
      }
      if (action === "stdin") {
        if (input.input === undefined) throw new HydrogenError("INVALID_INPUT", "stdin requires input");
        if (job.exited || !job.child.stdin.writable) {
          throw new HydrogenError("INVALID_INPUT", "Job stdin is closed");
        }
        await new Promise<void>((resolveWrite, reject) => {
          job.child.stdin.write(input.input, error => error ? reject(error) : resolveWrite());
        });
      } else if (action !== "poll") {
        throw new HydrogenError("INVALID_INPUT", "Unknown bash action");
      }
    }
    await this.wait(job, waitBudget);
    if (this.disposed) throw new HydrogenError("INVALID_INPUT", "ProcessManager is disposed");
    return this.read(job);
  }

  private async start(sessionId: string, command: string, cwd?: string): Promise<Job> {
    const directory = resolveReadPath(this.projectRoot, cwd ?? ".");
    const env = {
      ...process.env,
      PATH: buildEnvPath(process.env.PATH),
    };
    const child = process.platform === "win32"
      ? spawn(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", command], {
          cwd: directory, detached: true, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        })
      : spawn(existsSync("/bin/zsh") ? "/bin/zsh" : (process.env.SHELL || "/bin/sh"), ["-lc", command], {
          cwd: directory, detached: true, env, stdio: ["pipe", "pipe", "pipe"],
        });
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn);
      child.once("error", reject);
    });
    const record: PtyJobRecord = { jobId: randomUUID(), sessionId, command, cwd: directory,
      pgid: child.pid!, alive: true, createdAt: Date.now() };
    let resolveClosed!: () => void;
    const job: Job = { record, child, chunks: [], bufferedBytes: 0, totalBytes: 0,
      cursor: 0, closed: new Promise<void>(resolve => { resolveClosed = resolve; }),
      exited: false, exitCode: null, signal: null };
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => this.append(job, stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => this.append(job, stderrDecoder.write(chunk)));
    child.stdin.on("error", error => this.append(job, `\n[stdin error: ${error.message}]\n`));
    child.on("close", (code, signal) => {
      this.append(job, stdoutDecoder.end());
      this.append(job, stderrDecoder.end());
      job.exited = true;
      job.exitCode = code;
      job.signal = signal;
      job.record.alive = groupAlive(record.pgid);
      if (!this.disposed) this.state.setPtyJobAlive(record.jobId, job.record.alive);
      resolveClosed();
    });
    this.jobs.set(record.jobId, job);
    this.state.putPtyJob(record);
    return job;
  }

  private append(job: Job, text: string): void {
    if (!text) return;
    const chunk = Buffer.from(text, "utf8");
    job.chunks.push(chunk);
    job.totalBytes += chunk.length;
    job.bufferedBytes += chunk.length;
    while (job.bufferedBytes > LIMITS.PTY_RING_BUFFER_BYTES) {
      const first = job.chunks[0];
      const excess = job.bufferedBytes - LIMITS.PTY_RING_BUFFER_BYTES;
      if (first.length <= excess) {
        job.chunks.shift();
        job.bufferedBytes -= first.length;
      } else {
        let drop = excess;
        while (drop < first.length && (first[drop] & 0xc0) === 0x80) drop++;
        // Copy the retained portion so the discarded allocation can be collected.
        job.chunks[0] = Buffer.from(first.subarray(drop));
        job.bufferedBytes -= drop;
      }
    }
  }

  private async wait(job: Job, milliseconds: number): Promise<void> {
    if (job.exited || milliseconds <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([job.closed, new Promise<void>(resolve => {
        timer = setTimeout(resolve, milliseconds);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private read(job: Job): BashResult {
    const start = job.totalBytes - job.bufferedBytes;
    const dropped = Math.max(0, start - job.cursor);
    const bytes = Buffer.concat(job.chunks, job.bufferedBytes);
    const text = (dropped ? `[ring buffer dropped ${dropped} unread bytes]\n` : "") +
      bytes.subarray(Math.max(0, job.cursor - start)).toString("utf8");
    const output = this.outputSpill(`bash_${job.record.jobId}`, text, LIMITS.TOOL_INLINE_BYTES, {
      sessionId: job.record.sessionId,
      kind: "bash",
      isError: job.exitCode !== null && job.exitCode !== 0,
      exitCode: job.exitCode,
      commandOrPath: job.record.command,
    });
    job.cursor = job.totalBytes;
    job.record.alive = groupAlive(job.record.pgid);
    this.state.setPtyJobAlive(job.record.jobId, job.record.alive);
    return {
      ...output,
      output: output.inlineText,
      jobId: job.record.jobId,
      alive: job.record.alive,
      exitCode: job.exitCode,
      signal: job.signal,
    };
  }

  private async terminate(job: Job): Promise<void> {
    signalGroup(job.record.pgid, "SIGTERM");
    const deadline = Date.now() + 2_000;
    while (groupAlive(job.record.pgid) && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
    }
    if (groupAlive(job.record.pgid)) signalGroup(job.record.pgid, "SIGKILL");
    await this.wait(job, 200);
    job.record.alive = groupAlive(job.record.pgid);
    this.state.setPtyJobAlive(job.record.jobId, job.record.alive);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.starting]);
    try { await Promise.all([...this.jobs.values()].map(job => this.terminate(job))); }
    finally { this.jobs.clear(); }
  }
}
