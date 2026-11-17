import { useSyncExternalStore } from "react";
import type { CommandSpec, ModelChoice, Snapshot, StreamMessage } from "./types";

interface StudioState {
  snapshot: Snapshot | null;
  connection: "connecting" | "connected" | "reconnecting";
  commands: CommandSpec[];
  models: ModelChoice[];
  error: string | null;
  hmrVersion: number;
  hmrUpdated: boolean;
  liveTurnId: string | null;
}
let state: StudioState = {
  snapshot: null, connection: "connecting", commands: [], models: [], error: null,
  hmrVersion: 0, hmrUpdated: false, liveTurnId: null,
};
const listeners = new Set<() => void>();
function update(patch: Partial<StudioState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
export function useStudio() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}
export function reportError(error: unknown) { update({ error: error instanceof Error ? error.message : String(error) }); }
export function dismissError() { update({ error: null }); }
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}
export async function act(path: string, body: unknown = {}): Promise<void> {
  try { await api(path, body); }
  catch (error) { reportError(error); }
}

function receive(message: StreamMessage) {
  const current = state.snapshot;
  if (message.type === "snapshot" || message.type === "state_update") {
    const snapshot = message.status;
    const live = current?.timeline.find(item => item.id === state.liveTurnId);
    if (snapshot.busy && live && current?.activeThreadId === snapshot.activeThreadId && !snapshot.timeline.some(item => item.id === live.id)) {
      snapshot.timeline = [...snapshot.timeline, live];
    }
    update({ snapshot });
    return;
  }
  if (!current) return;
  let snapshot = { ...current };
  if (message.type === "turn_start" || message.type === "command_item" || message.type === "rotation") {
    if (message.item && message.item.threadId === snapshot.activeThreadId) {
      snapshot.timeline = [...snapshot.timeline.filter(item => item.id !== message.item!.id), message.item];
      if (message.type === "turn_start") { snapshot.busy = true; update({ liveTurnId: message.item.id }); }
    }
  } else if (message.type === "session_event") {
    const event = message.event;
    snapshot.timeline = snapshot.timeline.map(item => {
      if (item.id !== message.turnId) return item;
      const turn = { ...item, tools: [...item.tools ?? []] };
      if (event.type === "text_delta") turn.assistantText = (turn.assistantText ?? "") + event.text;
      if (event.type === "thought_delta") turn.thoughtText = (turn.thoughtText ?? "") + event.text;
      if (event.type === "tool_call") {
        const previous = turn.tools!.find(tool => tool.callId === event.callId);
        turn.tools = previous ? turn.tools!.map(tool => tool.callId === event.callId ? { ...tool, ...event } : tool) : [...turn.tools!, event];
      }
      if (event.type === "tool_call_update") turn.tools = turn.tools!.map(tool => tool.callId === event.callId ? { ...tool, ...event } : tool);
      if (event.type === "done" && event.finalText) turn.assistantText = event.finalText;
      if (event.type === "error") turn.error = event.message;
      return turn;
    });
    if (event.type === "usage" || (event.type === "done" && event.usage)) snapshot.usage = event.usage;
  } else if (message.type === "turn_end") {
    snapshot.timeline = snapshot.timeline.map(item => item.id === message.turnId ? { ...item, aborted: message.aborted, error: message.error } : item);
    update({ liveTurnId: null });
  } else if (message.type === "permission_request") {
    snapshot.pendingPermissions = [...snapshot.pendingPermissions.filter(item => item.requestId !== message.request.requestId), message.request];
  } else if (message.type === "permission_resolved") {
    snapshot.pendingPermissions = snapshot.pendingPermissions.filter(item => item.requestId !== message.requestId);
  } else if (message.type === "clear_timeline") snapshot = { ...snapshot, timeline: [] };
  update({ snapshot });
}

export function connect() {
  const events = new EventSource("/api/events");
  events.onopen = () => update({ connection: "connected" });
  events.onerror = () => update({ connection: "reconnecting" });
  events.onmessage = event => {
    try { receive(JSON.parse(event.data) as StreamMessage); }
    catch (error) { reportError(error); }
  };
  void api<{ commands: CommandSpec[] }>("commands").then(data => update({ commands: data.commands })).catch(reportError);
  void api<{ models: ModelChoice[] }>("models").then(data => update({ models: data.models })).catch(reportError);
  return () => events.close();
}
let hmrTimer: ReturnType<typeof setTimeout>;
export function hotUpdated() {
  clearTimeout(hmrTimer);
  update({ hmrVersion: state.hmrVersion + 1, hmrUpdated: true });
  hmrTimer = setTimeout(() => update({ hmrUpdated: false }), 2200);
}
