export interface SessionOpenOptions {
  cwd: string;
  model?: string;
  agent?: string;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  mcpServers?: Record<
    string,
    {
      type?: "stdio" | "http";
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
    }
  >;
  env?: Record<string, string>;
  autoApprovePermissions?: boolean;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  /** True when backend reports session-cumulative usage rather than single-turn delta. */
  cumulative: boolean;
  contextWindow?: number;
}

export type SessionEvent =
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; status: string; rawInput?: unknown }
  | { type: "tool_call_update"; callId: string; status: string; rawOutput?: unknown }
  | {
      type: "permission_request";
      requestId: string;
      toolName: string;
      title?: string;
      rawInput?: unknown;
    }
  | { type: "usage"; usage: SessionUsage }
  | { type: "done"; finalText: string; stopReason?: string; usage?: SessionUsage }
  | { type: "error"; message: string };

export interface ManagedSessionHandle {
  sessionId: string;
  backend: "acp" | "stream-json";
  conversationId: string;
  pid?: number;
  resumed?: boolean;
}

export interface PromptTurnResult {
  conversationId: string;
  finalText: string;
  stopReason?: string;
  usage?: SessionUsage;
  aborted: boolean;
}

export interface SessionAdapter {
  readonly backend: "acp" | "stream-json";
  open(opts: SessionOpenOptions): Promise<ManagedSessionHandle>;
  resume(handle: ManagedSessionHandle, opts: SessionOpenOptions): Promise<ManagedSessionHandle>;
  prompt(
    handle: ManagedSessionHandle,
    text: string,
    onEvent: (ev: SessionEvent) => void,
    signal?: AbortSignal,
  ): Promise<PromptTurnResult>;
  respondPermission?(
    handle: ManagedSessionHandle,
    requestId: string,
    outcome: { approved: boolean; reason?: string },
  ): Promise<void>;
  setModel?(handle: ManagedSessionHandle, modelId: string): Promise<void>;
  cancel(handle: ManagedSessionHandle): Promise<void>;
  close(handle: ManagedSessionHandle): Promise<void>;
  closeAndFlushHost?(handle: ManagedSessionHandle): Promise<void>;
}
