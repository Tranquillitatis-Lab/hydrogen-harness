/// <reference types="node" />
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  ManagedSessionHandle, PromptTurnResult, SessionAdapter, SessionEvent,
  SessionOpenOptions, SessionUsage,
} from "./session.js";

type ObjectValue = Record<string, unknown>;
type Turn = {
  child: ChildProcessWithoutNullStreams;
  finished: Promise<void>;
  aborted: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
};
type Session = {
  handle: ManagedSessionHandle;
  opts: SessionOpenOptions;
  turn?: Turn;
  closing: boolean;
};

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" ? value as ObjectValue : {};
}

function checkOptions(opts: SessionOpenOptions): void {
  if (opts.appendSystemPrompt || Object.keys(opts.mcpServers ?? {}).length > 0) {
    throw new Error("stream-json cannot inject appendSystemPrompt or mcpServers per spawn; use the ACP adapter or an installed Plugin");
  }
}

function usage(value: unknown): SessionUsage | undefined {
  const data = object(value);
  if (typeof data.input_tokens !== "number" && typeof data.output_tokens !== "number") return undefined;
  const result: SessionUsage = {
    inputTokens: typeof data.input_tokens === "number" ? data.input_tokens : 0,
    outputTokens: typeof data.output_tokens === "number" ? data.output_tokens : 0,
    cumulative: true,
  };
  if (typeof data.thinking_tokens === "number") result.thinkingTokens = data.thinking_tokens;
  if (typeof data.cache_read_tokens === "number") result.cacheReadTokens = data.cache_read_tokens;
  return result;
}

export class StreamJsonSessionAdapter implements SessionAdapter {
  readonly backend = "stream-json" as const;
  private readonly sessions = new Map<string, Session>();

  async open(opts: SessionOpenOptions): Promise<ManagedSessionHandle> {
    checkOptions(opts);
    const handle: ManagedSessionHandle = {
      sessionId: randomUUID(), backend: this.backend, conversationId: "",
    };
    this.sessions.set(handle.sessionId, { handle, opts, closing: false });
    return handle;
  }

  async resume(handle: ManagedSessionHandle, opts: SessionOpenOptions): Promise<ManagedSessionHandle> {
    checkOptions(opts);
    if (handle.backend !== this.backend || !handle.conversationId) {
      throw new Error("stream-json resume requires a stream-json conversationId");
    }
    const existing = this.sessions.get(handle.sessionId);
    if (existing?.turn || existing?.closing) throw new Error("stream-json session is busy or closing");
    const resumed = { ...handle, pid: undefined };
    this.sessions.set(handle.sessionId, { handle: resumed, opts, closing: false });
    return resumed;
  }

  async prompt(
    handle: ManagedSessionHandle, text: string,
    onEvent: (event: SessionEvent) => void, signal?: AbortSignal,
  ): Promise<PromptTurnResult> {
    const session = this.get(handle);
    if (session.turn || session.closing) throw new Error("stream-json session already has an active prompt or is closing");
    if (signal?.aborted) {
      const result = { conversationId: session.handle.conversationId, finalText: "", stopReason: "cancelled", aborted: true };
      onEvent({ type: "done", finalText: "", stopReason: "cancelled" });
      return result;
    }
    // Each print process performs one turn; --conversation reconnects subsequent turns.
    const args = ["-p=", "--input-format", "stream-json", "--output-format", "stream-json"];
    if (session.handle.conversationId) args.push("--conversation", session.handle.conversationId);
    if (session.opts.agent) args.push("--agent", session.opts.agent);
    if (session.opts.model) args.push("--model", session.opts.model);
    if (session.opts.autoApprovePermissions) args.push("--dangerously-skip-permissions");
    const child = spawn("agy", args, {
      cwd: session.opts.cwd, env: { ...process.env, ...session.opts.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    session.handle.pid = child.pid;
    let finish!: () => void;
    const turn: Turn = { child, aborted: false, finished: new Promise<void>((resolve) => { finish = resolve; }) };
    session.turn = turn;
    const abort = () => { void this.cancel(handle); };
    let accumulatedText = "";
    let finalResult: ObjectValue | undefined;
    let currentUsage: SessionUsage | undefined;
    let stderr = "";
    let failure: Error | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-32768); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const rememberConversation = (data: ObjectValue) => {
      if (typeof data.conversation_id === "string" && data.conversation_id) {
        session.handle.conversationId = data.conversation_id;
        handle.conversationId = data.conversation_id;
      }
    };
    lines.on("line", (line) => {
      if (!line.trim() || failure) return;
      try {
        const message = object(JSON.parse(line));
        if (message.event === "init") {
          rememberConversation(message);
          rememberConversation(object(message.init));
        } else if (message.event === "step_update") {
          const step = object(message.step_update);
          rememberConversation(step);
          if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
            accumulatedText += step.text_delta;
            onEvent({ type: "text_delta", text: step.text_delta });
          }
          if (typeof step.thinking_delta === "string" && step.thinking_delta) {
            onEvent({ type: "thought_delta", text: step.thinking_delta });
          }
          const nextUsage = usage(step.usage);
          if (nextUsage) { currentUsage = nextUsage; onEvent({ type: "usage", usage: nextUsage }); }
        } else if (message.event === "result") {
          finalResult = object(message.result);
          rememberConversation(finalResult);
          const nextUsage = usage(finalResult.usage);
          if (nextUsage) { currentUsage = nextUsage; onEvent({ type: "usage", usage: nextUsage }); }
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        this.stop(turn);
      }
    });
    child.on("error", (error) => { failure = error; });
    child.stdin.on("error", (error) => { if (!turn.aborted) { failure = error; this.stop(turn); } });
    const completion = new Promise<PromptTurnResult>((resolve, reject) => {
      child.once("close", (code, exitSignal) => {
        lines.close();
        clearTimeout(turn.killTimer);
        signal?.removeEventListener("abort", abort);
        session.handle.pid = undefined;
        session.turn = undefined;
        finish();
        try {
          if (!turn.aborted) {
            if (failure) throw failure;
            if (code !== 0) throw new Error(`agy stream-json exited (code=${code}, signal=${exitSignal})`);
            if (!finalResult) throw new Error("agy stream-json exited without a result event");
            if (finalResult.status !== "SUCCESS") {
              throw new Error(`agy stream-json result: ${finalResult.status}: ${String(finalResult.error ?? finalResult.response ?? "")}`);
            }
          }
          const result: PromptTurnResult = {
            conversationId: session.handle.conversationId,
            finalText: typeof finalResult?.response === "string" ? finalResult.response : accumulatedText,
            stopReason: turn.aborted ? "cancelled" : typeof finalResult?.status === "string" ? finalResult.status : undefined,
            usage: currentUsage, aborted: turn.aborted,
          };
          onEvent({ type: "done", finalText: result.finalText, stopReason: result.stopReason, usage: result.usage });
          resolve(result);
        } catch (error) {
          const diagnostic = new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ""}`);
          try { onEvent({ type: "error", message: diagnostic.message }); }
          finally { reject(diagnostic); }
        }
      });
    });
    child.stdin.end(JSON.stringify({ event: "user", message: { content: text } }) + "\n");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return completion;
  }

  async cancel(handle: ManagedSessionHandle): Promise<void> {
    const turn = this.get(handle).turn;
    if (!turn) return;
    turn.aborted = true;
    this.stop(turn);
    await turn.finished;
  }

  async close(handle: ManagedSessionHandle): Promise<void> {
    const session = this.sessions.get(handle.sessionId);
    if (!session) return;
    session.closing = true;
    await this.cancel(handle);
    this.sessions.delete(handle.sessionId);
  }

  private get(handle: ManagedSessionHandle): Session {
    const session = this.sessions.get(handle.sessionId);
    if (!session || handle.backend !== this.backend) throw new Error("Unknown stream-json session");
    return session;
  }

  private stop(turn: Turn): void {
    if (turn.killTimer) return;
    turn.child.kill("SIGTERM");
    turn.killTimer = setTimeout(() => { turn.child.kill("SIGKILL"); }, 2000);
  }
}
