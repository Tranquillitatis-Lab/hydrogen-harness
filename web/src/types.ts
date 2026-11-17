import type { SessionEvent, SessionUsage } from "../../src/adapters/session.js";
import type { ContextStats } from "../../src/core/handover.js";
import type { ApprovalMode, HandoffPacket, ThreadRecord, TimelineItem, TodoItem } from "../../src/core/protocol.js";
import type { PtyJobRecord, SessionRecord, SubagentRecord, WorkflowRecord } from "../../src/core/state.js";
export type { ApprovalMode, TimelineItem, TimelineToolEntry } from "../../src/core/protocol.js";
export type { CommandSpec, ModelChoice, GitSnapshot } from "../../src/entry/commands.js";

export type Permission = { requestId: string; toolName: string; title?: string; rawInput?: unknown };
export type Checkpoint = HandoffPacket["semantic"];
export interface Snapshot {
  projectRoot: string;
  model: string;
  epoch: number;
  writerSessionId?: string;
  activeThreadId: string;
  threads: ThreadRecord[];
  approvalMode: ApprovalMode;
  autoCompact: boolean;
  hmrEnabled: boolean;
  busy: boolean;
  rotating: boolean;
  contextStats: ContextStats;
  handoverLevel: ContextStats["level"];
  writer?: SessionRecord;
  sessions: SessionRecord[];
  usage?: SessionUsage;
  checkpoint: Checkpoint;
  todos: TodoItem[];
  pendingPermissions: Permission[];
  subagents: SubagentRecord[];
  workflows: WorkflowRecord[];
  ptyJobs: PtyJobRecord[];
  git: { isGitRepo: boolean; branch: string };
  timeline: TimelineItem[];
}
export type StreamMessage =
  | { type: "snapshot" | "state_update"; status: Snapshot }
  | { type: "turn_start" | "command_item"; item: TimelineItem }
  | { type: "rotation"; item?: TimelineItem; epoch: number }
  | { type: "session_event"; turnId: string; event: SessionEvent }
  | { type: "turn_end"; turnId: string; aborted: boolean; error?: string }
  | { type: "permission_request"; request: Permission }
  | { type: "permission_resolved"; requestId: string }
  | { type: "clear_timeline" };
export interface FileContent { path: string; text: string; truncated: boolean }
