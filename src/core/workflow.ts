import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { fsGlob, fsGrep, normPath, readSnapshot } from "./files.js";
import { spillOutput } from "./output.js";
import { LIMITS, type AgentDispatchInput, type BashInput, type FsGlobInput, type FsGrepInput,
  type SessionIdentity, type WorkflowRunInput } from "./protocol.js";
import { HydrogenError, StateStore, type WorkflowRecord } from "./state.js";
import type { AgentManager } from "./agents.js";
import type { ProcessManager } from "./process.js";

interface Run {
  child: ChildProcessWithoutNullStreams;
  record: WorkflowRecord;
  controller: AbortController;
  agentCalls: number;
  tasks: Set<Promise<void>>;
  finished: Promise<unknown>;
  stop: (error: HydrogenError) => void;
}

export class WorkflowManager {
  private readonly runs = new Map<string, Run>();
  private closing = false;

  constructor(private readonly state: StateStore, private readonly agents: AgentManager,
    private readonly executeBash: (sessionId: string, input: BashInput, signal?: AbortSignal) => ReturnType<ProcessManager["execute"]>) {}

  async run(identity: SessionIdentity, input: WorkflowRunInput): Promise<unknown> {
    if (identity.depth >= LIMITS.MAX_AGENT_DEPTH) throw new HydrogenError("DEPTH_EXCEEDED", "Nested workflow_run is disabled");
    if (this.closing) throw new HydrogenError("INVALID_INPUT", "Workflow manager is closing");
    if (input.action === "status") {
      if (!input.runId) return this.state.listWorkflows();
      const record = this.state.getWorkflow(input.runId);
      if (!record) throw new HydrogenError("INVALID_INPUT", "Unknown runId");
      return record;
    }
    if (input.action === "cancel") {
      const run = input.runId ? this.runs.get(input.runId) : undefined;
      if (!run) throw new HydrogenError("INVALID_INPUT", "Unknown active runId");
      run.stop(new HydrogenError("INVALID_INPUT", "Workflow cancelled"));
      await run.finished.catch(() => {});
      return this.state.getWorkflow(input.runId!);
    }
    if (!input.code?.trim()) throw new HydrogenError("INVALID_INPUT", "workflow_run requires code");
    const timeoutMs = input.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new HydrogenError("INVALID_INPUT", "timeoutMs must be a positive timer interval");
    }
    const runId = randomUUID();
    const workerPath = fileURLToPath(new URL("../entry/ptc-worker.js", import.meta.url));
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "NODE", "LANG", "LC_ALL", "TZ", "TMPDIR"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${workerPath}`,
      "--disable-proto=throw", workerPath], { cwd: this.state.projectRoot, env, stdio: ["pipe", "pipe", "pipe"] });
    const record: WorkflowRecord = { runId, status: "running", steps: [], summary: "", outputRef: null, updatedAt: Date.now() };
    this.state.putWorkflow(record);
    let failure: HydrogenError | undefined;
    let received = false;
    let value: unknown;
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let wallTimer: ReturnType<typeof setTimeout>;
    const run: Run = { child, record, controller: new AbortController(), agentCalls: 0,
      tasks: new Set(), finished: Promise.resolve(), stop: error => {
        if (failure) return;
        failure = error;
        record.status = error.code === "TIMEOUT" ? "timed_out" : "cancelled";
        run.controller.abort(error);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      } };
    const send = (message: unknown) => {
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(JSON.stringify(message) + "\n");
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      try {
        const message = JSON.parse(line) as { id: string | number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
        if (message.method) {
          const task = (async () => {
            try {
              const result = await this.call(run, identity, message.method!, message.params);
              send({ jsonrpc: "2.0", id: message.id, result });
            } catch (error) {
              send({ jsonrpc: "2.0", id: message.id, error: { code: error instanceof HydrogenError ? error.code : "INTERNAL",
                message: error instanceof Error ? error.message : String(error) } });
            }
          })();
          run.tasks.add(task);
          void task.finally(() => run.tasks.delete(task));
        } else if (message.id === "run") {
          received = true;
          value = message.result;
          if (message.error) failure = new HydrogenError("INVALID_INPUT", message.error.message);
          child.stdin.end();
        }
      } catch (error) { run.stop(new HydrogenError("INVALID_INPUT", `Invalid worker message: ${String(error)}`)); }
    });
    child.stdin.on("error", error => run.stop(new HydrogenError("INTERNAL", error.message)));
    run.finished = new Promise<unknown>((resolveRun, reject) => {
      child.once("error", error => { failure = new HydrogenError("INTERNAL", error.message); });
      child.once("close", (code, signal) => {
        clearTimeout(wallTimer);
        clearTimeout(killTimer);
        lines.close();
        void (async () => {
          run.controller.abort(new Error("Workflow finished"));
          await Promise.all(run.tasks);
          if (!failure && (!received || code !== 0)) failure = new HydrogenError("INTERNAL",
            `Workflow worker exited (${code ?? signal}): ${stderr}`);
          record.status = failure ? record.status === "running" ? "failed" : record.status : "completed";
          const text = failure ? failure.message : typeof value === "string" ? value : JSON.stringify(value) ?? "null";
          const output = spillOutput(this.state.projectRoot, `workflow_${runId}`, text, LIMITS.WORKFLOW_INLINE_BYTES);
          record.summary = output.inlineText;
          record.outputRef = output.outputRef ?? null;
          record.updatedAt = Date.now();
          this.state.putWorkflow(record);
          this.state.appendEvent("workflow.completed", null, { runId, status: record.status });
          this.runs.delete(runId);
          if (failure) reject(failure);
          else resolveRun({ runId, ...output });
        })().catch(reject);
      });
    });
    this.runs.set(runId, run);
    wallTimer = setTimeout(() => run.stop(new HydrogenError("TIMEOUT", `Workflow exceeded ${timeoutMs}ms`)), timeoutMs);
    send({ jsonrpc: "2.0", id: "run", method: "run", params: { code: input.code } });
    return run.finished;
  }

  private async call(run: Run, identity: SessionIdentity, method: string, params: unknown): Promise<unknown> {
    run.controller.signal.throwIfAborted();
    const session = this.state.getSession(identity.sessionId);
    if (!session || session.status === "closed") {
      throw new HydrogenError("STALE_EPOCH", "Workflow belongs to an inactive epoch");
    }
    const step: { method: string; params: unknown; status: string; result?: unknown; error?: string } = { method, params, status: "running" };
    run.record.steps.push(step);
    this.state.putWorkflow(run.record);
    try {
      let result: unknown;
      switch (method) {
        case "sys.glob": result = await fsGlob(this.state.projectRoot, params as FsGlobInput); break;
        case "sys.grep": result = await fsGrep(this.state.projectRoot,
          (label, text, max) => spillOutput(this.state.projectRoot, label, text, max), params as FsGrepInput); break;
        case "sys.readSlice": {
          const input = params as { path: string; startLine?: number; endLine?: number };
          const start = input.startLine ?? 1;
          const end = input.endLine ?? start + 199;
          if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) {
            throw new HydrogenError("INVALID_INPUT", "readSlice requires a valid inclusive line range");
          }
          const path = normPath(this.state.projectRoot, input.path, { allowSpill: true });
          const snapshot = readSnapshot(identity.sessionId, path);
          this.state.putObservation(snapshot.record);
          result = spillOutput(this.state.projectRoot, "readSlice", snapshot.text.split("\n").slice(start - 1, end).join("\n"), LIMITS.TOOL_INLINE_BYTES);
          break;
        }
        case "sys.exec": {
          if (session.role !== "writer" || session.depth !== 0) throw new HydrogenError("PERMISSION_DENIED", "sys.exec requires the depth-zero writer");
          this.state.assertWriteLease(identity.sessionId);
          result = await this.executeBash(identity.sessionId, { ...(params as BashInput), action: "exec" }, run.controller.signal);
          break;
        }
        case "agent": {
          if (++run.agentCalls > 12) throw new HydrogenError("PERMISSION_DENIED", "Workflow agent() limit is 12");
          const input = params as { prompt: string; opts?: AgentDispatchInput };
          result = await this.agents.dispatch(identity, { ...input.opts, action: "dispatch", message: input.prompt, wait: true,
            timeoutMs: undefined }, run.controller.signal);
          break;
        }
        default: throw new HydrogenError("INVALID_INPUT", `Unknown workflow operation: ${method}`);
      }
      step.status = "completed";
      step.result = result;
      return result;
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      run.record.updatedAt = Date.now();
      this.state.putWorkflow(run.record);
    }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    for (const run of this.runs.values()) run.stop(new HydrogenError("INVALID_INPUT", "Runtime closing"));
    await Promise.allSettled([...this.runs.values()].map(run => run.finished));
  }
}
