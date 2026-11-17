import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentWaitInput, DaemonResponse, HandoffPacket, ObservedFileRecord, SessionIdentity,
  SubagentToolName, ThreadRecord, TimelineItem, TodoItem,
} from "./protocol.js";

export class HydrogenError extends Error {
  constructor(
    public readonly code: NonNullable<DaemonResponse["error"]>["code"],
    message: string,
  ) {
    super(message);
    this.name = "HydrogenError";
  }
}

export interface SessionRecord extends SessionIdentity {
  conversationId: string | null;
  reuseKey: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastInputTokens: number;
  turnCount: number;
  deltaTextBytes: number;
  inputChars: number;
}

export interface PtyJobRecord {
  jobId: string;
  sessionId: string;
  command: string;
  cwd: string;
  pgid: number;
  alive: boolean;
  createdAt: number;
}

export interface EventRecord {
  seq: number;
  ts: number;
  type: string;
  agentId: string | null;
  payload: unknown;
}

export interface SubagentRecord {
  agentId: string;
  sessionId: string;
  conversationId: string;
  taskPath: string;
  parentId: string;
  rootId: string;
  nickname: string;
  role: string;
  model: string;
  tools: SubagentToolName[];
  writeScope?: string[];
  reuseKey: string | null;
  status: string;
  turnCount: number;
  summary: string;
  outputRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMailRecord {
  id: string;
  rootId: string;
  senderPath: string;
  recipientId: string;
  recipientPath: string;
  content: string;
  messageType: string;
  createdAt: number;
  readAt: number | null;
}

export interface WorkflowRecord {
  runId: string;
  status: string;
  steps: unknown[];
  summary: string;
  outputRef: string | null;
  updatedAt: number;
}

const SESSION_COLUMNS = `session_id AS sessionId, conversation_id AS conversationId,
  role, epoch, depth, reuse_key AS reuseKey, status, created_at AS createdAt,
  updated_at AS updatedAt, last_input_tokens AS lastInputTokens,
  turn_count AS turnCount, delta_text_bytes AS deltaTextBytes, input_chars AS inputChars`;
const OBSERVATION_COLUMNS = `session_id AS sessionId, path, dev, ino, size,
  mtime_ns AS mtimeNs, sha256, observed_at AS observedAt`;
const JOB_COLUMNS = `job_id AS jobId, session_id AS sessionId, command, cwd, pgid,
  alive, created_at AS createdAt`;
const SUBAGENT_COLUMNS = `agent_id AS agentId, session_id AS sessionId,
  conversation_id AS conversationId, task_path AS taskPath, parent_id AS parentId,
  root_id AS rootId, nickname, role, model, tools_json AS toolsJson,
  write_scope_json AS writeScopeJson, reuse_key AS reuseKey, status,
  turn_count AS turnCount, summary, output_ref AS outputRef,
  created_at AS createdAt, updated_at AS updatedAt`;

export function normalizeTaskSegment(name: string): string {
  const seg = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!seg) throw new HydrogenError("INVALID_INPUT", `Invalid taskName segment: ${name}`);
  return seg;
}

export function normalizeTaskPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\/+$/, "");
  if (trimmed === "/root") return "/root";
  if (!trimmed.startsWith("/root/")) {
    throw new HydrogenError("INVALID_INPUT", `Canonical taskPath must start with /root: ${rawPath}`);
  }
  const parts = trimmed.slice("/root/".length).split("/");
  if (parts.some(p => !p)) {
    throw new HydrogenError("INVALID_INPUT", `Invalid canonical taskPath: ${rawPath}`);
  }
  return "/root/" + parts.map(normalizeTaskSegment).join("/");
}

export class StateStore {
  readonly projectRoot: string;
  private readonly db: DatabaseSync;
  private transactionDepth = 0;
  private pendingEvents: EventRecord[] = [];
  private readonly listeners = new Set<(event: EventRecord) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    const directory = join(this.projectRoot, ".hydrogen");
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "state.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT NOT NULL,
        epoch INTEGER NOT NULL, depth INTEGER NOT NULL, reuse_key TEXT,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_input_tokens INTEGER NOT NULL DEFAULT 0,
        turn_count INTEGER NOT NULL DEFAULT 0, delta_text_bytes INTEGER NOT NULL DEFAULT 0,
        input_chars INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS observed_files (
        session_id TEXT NOT NULL, path TEXT NOT NULL, dev INTEGER NOT NULL,
        ino INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL,
        sha256 TEXT NOT NULL, observed_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, path)
      );
      CREATE TABLE IF NOT EXISTS pty_jobs (
        job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, command TEXT NOT NULL,
        cwd TEXT NOT NULL, pgid INTEGER NOT NULL, alive INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
        type TEXT NOT NULL, agent_id TEXT, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subagents (
        agent_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL, role TEXT NOT NULL, reuse_key TEXT,
        status TEXT NOT NULL, summary TEXT NOT NULL, output_ref TEXT,
        updated_at INTEGER NOT NULL,
        task_path TEXT NOT NULL DEFAULT '',
        parent_id TEXT NOT NULL DEFAULT '/root',
        root_id TEXT NOT NULL DEFAULT 'root',
        nickname TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        tools_json TEXT NOT NULL DEFAULT '[]',
        write_scope_json TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS agent_mailbox (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL,
        sender_path TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        recipient_path TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_mailbox_recipient_id ON agent_mailbox (recipient_id, read_at);
      CREATE INDEX IF NOT EXISTS idx_agent_mailbox_recipient_path ON agent_mailbox (recipient_path, read_at);
      CREATE TABLE IF NOT EXISTS wait_cursors (
        cursor_key TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflows (
        run_id TEXT PRIMARY KEY, status TEXT NOT NULL, steps_json TEXT NOT NULL,
        summary TEXT NOT NULL, output_ref TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL,
        approval_mode TEXT NOT NULL, auto_compact INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS timeline_items (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, seq INTEGER NOT NULL,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS todos (
        thread_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
        content TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (thread_id, id)
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('active_epoch', '0');
      INSERT OR IGNORE INTO meta VALUES ('writer_session_id', '');
      INSERT OR IGNORE INTO meta VALUES ('subagent_seq', '0');
      INSERT OR IGNORE INTO meta VALUES
        ('checkpoint_semantic', '{"verifiedFacts":[],"deadEndsTried":[]}');
    `);
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all();
    if (!columns.some(column => column.name === "input_chars")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN input_chars INTEGER NOT NULL DEFAULT 0");
    }
    const subCols = new Set(this.db.prepare("PRAGMA table_info(subagents)").all().map(c => String(c.name)));
    const subMigrations: Array<[string, string]> = [
      ["task_path", "TEXT NOT NULL DEFAULT ''"],
      ["parent_id", "TEXT NOT NULL DEFAULT '/root'"],
      ["root_id", "TEXT NOT NULL DEFAULT 'root'"],
      ["nickname", "TEXT NOT NULL DEFAULT ''"],
      ["model", "TEXT NOT NULL DEFAULT ''"],
      ["tools_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["write_scope_json", "TEXT"],
      ["turn_count", "INTEGER NOT NULL DEFAULT 0"],
      ["created_at", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [col, def] of subMigrations) {
      if (!subCols.has(col)) {
        this.db.exec(`ALTER TABLE subagents ADD COLUMN ${col} ${def}`);
      }
    }
  }

  upsertThread(thread: ThreadRecord): void {
    this.db.prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET title=excluded.title, model=excluded.model,
      approval_mode=excluded.approval_mode, auto_compact=excluded.auto_compact, updated_at=excluded.updated_at`)
      .run(thread.threadId, thread.title, thread.model, thread.approvalMode,
        Number(thread.autoCompact), thread.createdAt, thread.updatedAt);
  }

  getThread(threadId: string): ThreadRecord | undefined {
    const row = this.db.prepare(`SELECT thread_id AS threadId, title, model,
      approval_mode AS approvalMode, auto_compact AS autoCompact, created_at AS createdAt,
      updated_at AS updatedAt FROM threads WHERE thread_id = ?`).get(threadId);
    return row ? { ...row, autoCompact: Boolean(row.autoCompact) } as ThreadRecord : undefined;
  }

  listThreads(): ThreadRecord[] {
    return this.db.prepare("SELECT thread_id FROM threads ORDER BY updated_at DESC, thread_id").all()
      .map(row => this.getThread(String(row.thread_id))!);
  }

  deleteThread(threadId: string): void {
    this.transaction(() => {
      this.clearTimelineItems(threadId);
      this.db.prepare("DELETE FROM todos WHERE thread_id = ?").run(threadId);
      this.db.prepare("DELETE FROM threads WHERE thread_id = ?").run(threadId);
    });
  }

  upsertTimelineItem(item: TimelineItem): void {
    this.db.prepare(`INSERT INTO timeline_items (id, thread_id, seq, payload_json, created_at)
      VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM timeline_items), ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`)
      .run(item.id, item.threadId, JSON.stringify(item), item.createdAt);
  }

  listTimelineItems(threadId: string): TimelineItem[] {
    return this.db.prepare("SELECT payload_json FROM timeline_items WHERE thread_id = ? ORDER BY seq")
      .all(threadId).map(row => JSON.parse(String(row.payload_json)) as TimelineItem);
  }

  clearTimelineItems(threadId: string): void {
    this.db.prepare("DELETE FROM timeline_items WHERE thread_id = ?").run(threadId);
  }

  setTodos(threadId: string, todos: TodoItem[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM todos WHERE thread_id = ?").run(threadId);
      const insert = this.db.prepare("INSERT INTO todos VALUES (?, ?, ?, ?, ?)");
      todos.forEach((todo, seq) => insert.run(threadId, seq, todo.id, todo.content, todo.status));
    });
  }

  getTodos(threadId: string): TodoItem[] {
    return this.db.prepare("SELECT id, content, status FROM todos WHERE thread_id = ? ORDER BY seq")
      .all(threadId) as TodoItem[];
  }

  copyObservations(fromSessionId: string, toSessionId: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO observed_files
      SELECT ?, path, dev, ino, size, mtime_ns, sha256, observed_at FROM observed_files WHERE session_id = ?`)
      .run(toSessionId, fromSessionId);
  }

  migrateSessionResources(fromSessionId: string, toSessionId: string): void {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
    this.transaction(() => {
      this.copyObservations(fromSessionId, toSessionId);
      this.db.prepare("UPDATE pty_jobs SET session_id = ? WHERE session_id = ?")
        .run(toSessionId, fromSessionId);
      this.db.prepare("UPDATE subagents SET session_id = ? WHERE session_id = ?")
        .run(toSessionId, fromSessionId);
    });
  }

  /** Notifications are published only after the outermost transaction commits. */
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth;
    const eventStart = this.pendingEvents.length;
    this.db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT tx_${depth}`);
    this.transactionDepth++;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) {
        throw new TypeError("StateStore.transaction requires a synchronous callback");
      }
      this.db.exec(depth === 0 ? "COMMIT" : `RELEASE tx_${depth}`);
    } catch (error) {
      this.db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO tx_${depth}; RELEASE tx_${depth}`);
      this.pendingEvents.length = eventStart;
      throw error;
    } finally {
      this.transactionDepth--;
    }
    if (depth === 0) {
      const events = this.pendingEvents.splice(0);
      this.notify(events);
    }
    return result;
  }

  getMeta(key: string): string | undefined {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value as
      string | undefined;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT INTO meta VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  get activeEpoch(): number { return Number(this.getMeta("active_epoch")); }
  get writerSessionId(): string | undefined { return this.getMeta("writer_session_id") || undefined; }

  setWriteLease(sessionId: string | null, epoch: number): void {
    this.transaction(() => {
      this.setMeta("active_epoch", String(epoch));
      this.setMeta("writer_session_id", sessionId ?? "");
    });
  }

  assertWriteLease(sessionId: string): SessionRecord {
    const session = this.getSession(sessionId);
    if (!session) throw new HydrogenError("NO_WRITE_LEASE", "Session is not registered");
    if (session.role !== "writer") {
      throw new HydrogenError("NO_WRITE_LEASE", "Session does not hold a writer role");
    }
    return session;
  }

  getCheckpoint(): HandoffPacket["semantic"] {
    return JSON.parse(this.getMeta("checkpoint_semantic")!) as HandoffPacket["semantic"];
  }

  setCheckpoint(checkpoint: HandoffPacket["semantic"]): void {
    this.setMeta("checkpoint_semantic", JSON.stringify(checkpoint));
  }

  registerSession(identity: SessionIdentity & {
    conversationId?: string; reuseKey?: string; status?: string;
  }): SessionRecord {
    const now = Date.now();
    this.db.prepare(`INSERT INTO sessions
      (session_id, conversation_id, role, epoch, depth, reuse_key, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        conversation_id = COALESCE(excluded.conversation_id, sessions.conversation_id),
        role = excluded.role, epoch = excluded.epoch, depth = excluded.depth,
        reuse_key = COALESCE(excluded.reuse_key, sessions.reuse_key),
        status = excluded.status, updated_at = excluded.updated_at`)
      .run(identity.sessionId, identity.conversationId ?? null, identity.role,
        identity.epoch, identity.depth, identity.reuseKey ?? null,
        identity.status ?? "active", now, now);
    return this.getSession(identity.sessionId)!;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`)
      .get(sessionId) as unknown as SessionRecord | undefined;
  }

  listSessions(): SessionRecord[] {
    return this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY created_at, session_id`)
      .all() as unknown as SessionRecord[];
  }

  setSessionStatus(sessionId: string, status: string): void {
    this.db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?")
      .run(status, Date.now(), sessionId);
  }

  recordTurn(sessionId: string, inputTokens: number, deltaTextBytes: number, deltaInputChars = 0): void {
    this.db.prepare(`UPDATE sessions SET last_input_tokens = ?, turn_count = turn_count + 1,
      delta_text_bytes = delta_text_bytes + ?, input_chars = input_chars + ?, updated_at = ? WHERE session_id = ?`)
      .run(inputTokens, deltaTextBytes, deltaInputChars, Date.now(), sessionId);
  }

  resetSessionUsage(sessionId: string, baselineTokens = 0): void {
    this.db.prepare(`UPDATE sessions SET last_input_tokens = ?, delta_text_bytes = 0, input_chars = 0, updated_at = ? WHERE session_id = ?`)
      .run(baselineTokens, Date.now(), sessionId);
  }

  getObservation(sessionId: string, path: string): ObservedFileRecord | undefined {
    const direct = this.db.prepare(`SELECT ${OBSERVATION_COLUMNS} FROM observed_files
      WHERE session_id = ? AND path = ?`).get(sessionId, path) as unknown as
      ObservedFileRecord | undefined;
    if (direct) return direct;
    return this.db.prepare(`SELECT ${OBSERVATION_COLUMNS} FROM observed_files
      WHERE path = ? ORDER BY observed_at DESC LIMIT 1`).get(path) as unknown as
      ObservedFileRecord | undefined;
  }

  putObservation(record: ObservedFileRecord): void {
    this.db.prepare(`INSERT INTO observed_files
      (session_id, path, dev, ino, size, mtime_ns, sha256, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, path) DO UPDATE SET
      dev = excluded.dev, ino = excluded.ino, size = excluded.size,
      mtime_ns = excluded.mtime_ns, sha256 = excluded.sha256, observed_at = excluded.observed_at`)
      .run(record.sessionId, record.path, record.dev, record.ino, record.size,
        record.mtimeNs, record.sha256, record.observedAt);
  }

  deleteObservation(sessionId: string, path: string): void {
    this.db.prepare("DELETE FROM observed_files WHERE session_id = ? AND path = ?")
      .run(sessionId, path);
  }

  listObservations(sessionId?: string): ObservedFileRecord[] {
    const rows = sessionId
      ? this.db.prepare(`SELECT ${OBSERVATION_COLUMNS} FROM observed_files
          WHERE session_id = ? ORDER BY observed_at, path`).all(sessionId)
      : this.db.prepare(`SELECT ${OBSERVATION_COLUMNS} FROM observed_files
          ORDER BY observed_at, path`).all();
    return rows as unknown as ObservedFileRecord[];
  }

  putPtyJob(job: PtyJobRecord): void {
    this.db.prepare(`INSERT INTO pty_jobs VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET alive = excluded.alive`)
      .run(job.jobId, job.sessionId, job.command, job.cwd, job.pgid, Number(job.alive), job.createdAt);
  }

  setPtyJobAlive(jobId: string, alive: boolean): void {
    this.db.prepare("UPDATE pty_jobs SET alive = ? WHERE job_id = ?").run(Number(alive), jobId);
  }

  listPtyJobs(sessionId?: string): PtyJobRecord[] {
    const rows = sessionId === undefined
      ? this.db.prepare(`SELECT ${JOB_COLUMNS} FROM pty_jobs ORDER BY created_at, job_id`).all()
      : this.db.prepare(`SELECT ${JOB_COLUMNS} FROM pty_jobs WHERE session_id = ?
          ORDER BY created_at, job_id`).all(sessionId);
    return rows.map(row => ({ ...row, alive: Boolean(row.alive) })) as unknown as PtyJobRecord[];
  }

  appendEvent(type: string, agentId: string | null, payload: unknown): EventRecord {
    const payloadJson = JSON.stringify(payload);
    const ts = Date.now();
    const result = this.db.prepare(`INSERT INTO events (ts, type, agent_id, payload_json)
      VALUES (?, ?, ?, ?)`).run(ts, type, agentId, payloadJson);
    const event: EventRecord = {
      seq: Number(result.lastInsertRowid), ts, type, agentId, payload: JSON.parse(payloadJson),
    };
    if (this.transactionDepth > 0) this.pendingEvents.push(event);
    else this.notify([event]);
    return event;
  }

  private notify(events: EventRecord[]): void {
    for (const event of events) {
      for (const listener of this.listeners) queueMicrotask(() => {
        if (this.listeners.has(listener)) listener(event);
      });
    }
  }

  onEvent(listener: (event: EventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** One SELECT returns both the events and their committed high-water mark. */
  readEvents(afterSeq: number, agentIds?: string[]): { events: EventRecord[]; nextSeq: number } {
    const rows = this.db.prepare(`SELECT seq, ts, type, agent_id AS agentId,
      payload_json AS payloadJson FROM events WHERE seq > ? ORDER BY seq`).all(afterSeq);
    const nextSeq = rows.length ? Number(rows[rows.length - 1].seq) : afterSeq;
    const events = rows.filter(row => !agentIds || agentIds.includes(String(row.agentId)))
      .map(row => ({ seq: Number(row.seq), ts: Number(row.ts), type: String(row.type),
        agentId: row.agentId as string | null, payload: JSON.parse(String(row.payloadJson)) }));
    return { events, nextSeq };
  }

  waitForEvents(input: AgentWaitInput): Promise<{ events: EventRecord[]; nextSeq: number }> {
    const afterSeq = input.afterSeq ?? 0;
    return new Promise(resolveWait => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        const result = this.readEvents(afterSeq, input.agentIds);
        unsubscribe();
        this.closeListeners.delete(finish);
        if (timer) clearTimeout(timer);
        resolveWait(result);
      };
      // Subscribe before checking the cursor, so a committed event cannot be lost.
      const unsubscribe = this.onEvent(event => {
        if (event.seq > afterSeq &&
            (!input.agentIds || (event.agentId !== null && input.agentIds.includes(event.agentId)))) {
          finish();
        }
      });
      this.closeListeners.add(finish);
      if (this.readEvents(afterSeq, input.agentIds).events.length > 0) finish();
      else timer = setTimeout(finish, input.timeoutMs ?? 30_000);
    });
  }

  waitUntil(
    predicate: (eventsSince: EventRecord[]) => boolean,
    afterSeq: number,
    timeoutMs: number,
  ): Promise<EventRecord[]> {
    return new Promise(resolveWait => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const result = this.readEvents(afterSeq).events;
        unsubscribe();
        this.closeListeners.delete(finish);
        if (timer) clearTimeout(timer);
        resolveWait(result);
      };
      const unsubscribe = this.onEvent(() => {
        const current = this.readEvents(afterSeq).events;
        if (predicate(current)) finish();
      });
      this.closeListeners.add(finish);
      const initial = this.readEvents(afterSeq).events;
      if (predicate(initial)) finish();
      else if (timeoutMs <= 0) finish();
      else timer = setTimeout(finish, timeoutMs);
    });
  }

  private rowToSubagent(row: Record<string, unknown>): SubagentRecord {
    const agentId = String(row.agentId);
    let tools: SubagentToolName[] = [];
    try {
      const parsed = JSON.parse(String(row.toolsJson ?? "[]"));
      if (Array.isArray(parsed)) tools = parsed.filter((t): t is SubagentToolName => typeof t === "string") as SubagentToolName[];
    } catch { /* Ignore malformed toolsJson. */ }
    let writeScope: string[] | undefined;
    if (row.writeScopeJson !== null && row.writeScopeJson !== undefined && String(row.writeScopeJson) !== "") {
      try {
        const parsed = JSON.parse(String(row.writeScopeJson));
        if (Array.isArray(parsed)) writeScope = parsed.filter((s): s is string => typeof s === "string");
      } catch { /* Ignore malformed writeScopeJson. */ }
    }
    const rawPath = String(row.taskPath ?? "");
    const taskPath = rawPath || `/root/${agentId.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`;
    return {
      agentId,
      sessionId: String(row.sessionId),
      conversationId: String(row.conversationId ?? ""),
      taskPath,
      parentId: String(row.parentId ?? "/root") || "/root",
      rootId: String(row.rootId ?? "root") || "root",
      nickname: String(row.nickname ?? ""),
      role: String(row.role ?? ""),
      model: String(row.model ?? ""),
      tools,
      writeScope,
      reuseKey: row.reuseKey === null || row.reuseKey === undefined ? null : String(row.reuseKey),
      status: String(row.status),
      turnCount: Number(row.turnCount ?? 0),
      summary: String(row.summary ?? ""),
      outputRef: row.outputRef === null || row.outputRef === undefined ? null : String(row.outputRef),
      createdAt: Number(row.createdAt ?? 0),
      updatedAt: Number(row.updatedAt ?? 0),
    };
  }

  nextSubagentId(): string {
    return this.transaction(() => {
      let seq = Number(this.getMeta("subagent_seq") || "0") + 1;
      let candidate = `ag-${String(seq).padStart(2, "0")}`;
      while (this.getSubagent(candidate)) {
        seq += 1;
        candidate = `ag-${String(seq).padStart(2, "0")}`;
      }
      this.setMeta("subagent_seq", String(seq));
      return candidate;
    });
  }

  putSubagent(agent: SubagentRecord): void {
    this.db.prepare(`INSERT INTO subagents (
        agent_id, session_id, conversation_id, role, reuse_key, status, summary, output_ref, updated_at,
        task_path, parent_id, root_id, nickname, model, tools_json, write_scope_json, turn_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET session_id = excluded.session_id,
      conversation_id = excluded.conversation_id, role = excluded.role,
      reuse_key = excluded.reuse_key, status = excluded.status, summary = excluded.summary,
      output_ref = excluded.output_ref, updated_at = excluded.updated_at,
      task_path = excluded.task_path, parent_id = excluded.parent_id, root_id = excluded.root_id,
      nickname = excluded.nickname, model = excluded.model, tools_json = excluded.tools_json,
      write_scope_json = excluded.write_scope_json, turn_count = excluded.turn_count,
      created_at = excluded.created_at`)
      .run(
        agent.agentId, agent.sessionId, agent.conversationId, agent.role, agent.reuseKey,
        agent.status, agent.summary, agent.outputRef, agent.updatedAt,
        agent.taskPath, agent.parentId, agent.rootId, agent.nickname, agent.model,
        JSON.stringify(agent.tools), agent.writeScope === undefined ? null : JSON.stringify(agent.writeScope),
        agent.turnCount, agent.createdAt,
      );
  }

  getSubagent(agentId: string): SubagentRecord | undefined {
    const row = this.db.prepare(`SELECT ${SUBAGENT_COLUMNS} FROM subagents WHERE agent_id = ?`).get(agentId) as Record<string, unknown> | undefined;
    return row ? this.rowToSubagent(row) : undefined;
  }

  getSubagentBySessionId(sessionId: string): SubagentRecord | undefined {
    const row = this.db.prepare(`SELECT ${SUBAGENT_COLUMNS} FROM subagents WHERE session_id = ?`).get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.rowToSubagent(row) : undefined;
  }

  getSubagentByConversationId(conversationId: string): SubagentRecord | undefined {
    if (!conversationId) return undefined;
    const row = this.db.prepare(`SELECT ${SUBAGENT_COLUMNS} FROM subagents WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1`).get(conversationId) as Record<string, unknown> | undefined;
    return row ? this.rowToSubagent(row) : undefined;
  }

  resolveSessionAgent(sessionId: string, conversationId?: string): {
    agentId: string;
    taskPath: string;
    rootId: string;
    isRoot: boolean;
    subagent?: SubagentRecord;
  } {
    const effectiveConvId = conversationId ?? this.getSession(sessionId)?.conversationId ?? undefined;
    const sub = this.getSubagentBySessionId(sessionId)
      ?? (effectiveConvId ? this.getSubagentByConversationId(effectiveConvId) : undefined);
    if (sub) {
      return {
        agentId: sub.agentId,
        taskPath: sub.taskPath,
        rootId: sub.rootId,
        isRoot: false,
        subagent: sub,
      };
    }
    return {
      agentId: "/root",
      taskPath: "/root",
      rootId: this.getMeta("active_workline") || this.writerSessionId || "root",
      isRoot: true,
    };
  }

  listSubagents(rootId?: string): SubagentRecord[] {
    const rows = rootId
      ? this.db.prepare(`SELECT ${SUBAGENT_COLUMNS} FROM subagents WHERE root_id = ? ORDER BY created_at, updated_at, agent_id`).all(rootId)
      : this.db.prepare(`SELECT ${SUBAGENT_COLUMNS} FROM subagents ORDER BY created_at, updated_at, agent_id`).all();
    return (rows as Record<string, unknown>[]).map(row => this.rowToSubagent(row));
  }

  resolveAgent(target: string, options?: { rootId?: string; callerPath?: string }): SubagentRecord {
    const trimmed = target.trim();
    if (!trimmed) throw new HydrogenError("INVALID_INPUT", "Agent target must not be empty");
    const direct = this.getSubagent(trimmed);
    if (direct) {
      if (options?.rootId && direct.rootId !== options.rootId) {
        throw new HydrogenError("INVALID_INPUT", `Target ${trimmed} is outside root tree ${options.rootId}`);
      }
      return direct;
    }
    const allInScope = this.listSubagents(options?.rootId);
    let candidates: SubagentRecord[];
    let canonicalPath: string;
    if (trimmed.startsWith("/")) {
      canonicalPath = normalizeTaskPath(trimmed);
      candidates = allInScope.filter(a => a.taskPath === canonicalPath);
    } else {
      const base = (options?.callerPath || "/root").replace(/\/+$/, "") || "/root";
      const seg = normalizeTaskSegment(trimmed);
      canonicalPath = `${base === "/root" ? "/root" : base}/${seg}`;
      candidates = allInScope.filter(a => a.taskPath === canonicalPath);
      if (candidates.length === 0 && base !== "/root") {
        const siblingPath = `/root/${seg}`;
        candidates = allInScope.filter(a => a.taskPath === siblingPath);
        if (candidates.length > 0) canonicalPath = siblingPath;
      }
      if (candidates.length === 0) {
        const lower = trimmed.toLowerCase();
        candidates = allInScope.filter(a => a.nickname.toLowerCase() === lower);
      }
    }
    if (candidates.length === 0) {
      throw new HydrogenError("INVALID_INPUT", `Unknown agent target: ${target}`);
    }
    const live = candidates.filter(a => !["closed", "killed"].includes(a.status));
    if (live.length === 1) return live[0];
    if (live.length > 1) {
      throw new HydrogenError("INVALID_INPUT", `Ambiguous live agent target ${canonicalPath}; specify agentId`);
    }
    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    return candidates[0];
  }

  enqueueMail(mail: {
    id?: string;
    rootId: string;
    senderPath: string;
    recipientId: string;
    recipientPath: string;
    content: string;
    messageType?: string;
    createdAt?: number;
    readAt?: number | null;
  }): AgentMailRecord {
    const record: AgentMailRecord = {
      id: mail.id ?? randomUUID(),
      rootId: mail.rootId,
      senderPath: mail.senderPath,
      recipientId: mail.recipientId,
      recipientPath: mail.recipientPath,
      content: mail.content,
      messageType: mail.messageType ?? "MESSAGE",
      createdAt: mail.createdAt ?? Date.now(),
      readAt: mail.readAt ?? null,
    };
    this.db.prepare(`INSERT INTO agent_mailbox (
      id, root_id, sender_path, recipient_id, recipient_path, content, message_type, created_at, read_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.rootId, record.senderPath, record.recipientId, record.recipientPath,
        record.content, record.messageType, record.createdAt, record.readAt);
    return record;
  }

  getUnreadMail(target: { recipientId?: string; recipientPath?: string; rootId?: string }): AgentMailRecord[] {
    const clauses = ["read_at IS NULL"];
    const args: Array<string> = [];
    if (target.recipientId) { clauses.push("recipient_id = ?"); args.push(target.recipientId); }
    if (target.recipientPath) { clauses.push("recipient_path = ?"); args.push(target.recipientPath); }
    if (target.rootId) { clauses.push("root_id = ?"); args.push(target.rootId); }
    const rows = this.db.prepare(`SELECT id, root_id AS rootId, sender_path AS senderPath,
      recipient_id AS recipientId, recipient_path AS recipientPath, content, message_type AS messageType,
      created_at AS createdAt, read_at AS readAt FROM agent_mailbox
      WHERE ${clauses.join(" AND ")} ORDER BY created_at, rowid`).all(...args);
    return rows as unknown as AgentMailRecord[];
  }

  countUnreadMail(recipientId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM agent_mailbox WHERE recipient_id = ? AND read_at IS NULL").get(recipientId) as { cnt?: number } | undefined;
    return Number(row?.cnt ?? 0);
  }

  markMailRead(ids: string[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare("UPDATE agent_mailbox SET read_at = ? WHERE id = ?");
    this.transaction(() => {
      for (const id of ids) stmt.run(now, id);
    });
  }

  drainMail(target: { recipientId?: string; recipientPath?: string; rootId?: string }): AgentMailRecord[] {
    return this.transaction(() => {
      const items = this.getUnreadMail(target);
      if (items.length > 0) {
        const now = Date.now();
        const stmt = this.db.prepare("UPDATE agent_mailbox SET read_at = ? WHERE id = ?");
        for (const item of items) {
          stmt.run(now, item.id);
          item.readAt = now;
        }
      }
      return items;
    });
  }

  getWaitCursor(cursorKey: string): number {
    const row = this.db.prepare("SELECT last_seq AS lastSeq FROM wait_cursors WHERE cursor_key = ?").get(cursorKey) as { lastSeq?: number } | undefined;
    return Number(row?.lastSeq ?? 0);
  }

  setWaitCursor(cursorKey: string, lastSeq: number): void {
    this.db.prepare(`INSERT INTO wait_cursors (cursor_key, last_seq, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(cursor_key) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`)
      .run(cursorKey, lastSeq, Date.now());
  }

  setAllowedTools(sessionId: string, tools: string[] | undefined): void {
    this.setMeta(`allowed_tools:${sessionId}`, tools === undefined ? "" : JSON.stringify(tools));
  }

  getAllowedTools(sessionId: string): string[] | undefined {
    const raw = this.getMeta(`allowed_tools:${sessionId}`);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === "string");
    } catch { /* Ignore malformed allowedTools metadata. */ }
    return undefined;
  }

  setWriteScope(sessionId: string, scope: string[] | undefined): void {
    this.setMeta(`write_scope:${sessionId}`, scope === undefined ? "" : JSON.stringify(scope));
  }

  getWriteScope(sessionId: string): string[] | undefined {
    const raw = this.getMeta(`write_scope:${sessionId}`);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    } catch { /* Ignore malformed writeScope metadata. */ }
    return undefined;
  }

  putWorkflow(workflow: WorkflowRecord): void {
    this.db.prepare(`INSERT INTO workflows VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, steps_json = excluded.steps_json,
      summary = excluded.summary, output_ref = excluded.output_ref, updated_at = excluded.updated_at`)
      .run(workflow.runId, workflow.status, JSON.stringify(workflow.steps), workflow.summary,
        workflow.outputRef, workflow.updatedAt);
  }

  getWorkflow(runId: string): WorkflowRecord | undefined {
    const row = this.db.prepare(`SELECT run_id AS runId, status, steps_json AS stepsJson,
      summary, output_ref AS outputRef, updated_at AS updatedAt FROM workflows WHERE run_id = ?`)
      .get(runId);
    if (!row) return undefined;
    return { runId: String(row.runId), status: String(row.status),
      steps: JSON.parse(String(row.stepsJson)), summary: String(row.summary),
      outputRef: row.outputRef as string | null, updatedAt: Number(row.updatedAt) };
  }

  listWorkflows(): WorkflowRecord[] {
    return this.db.prepare("SELECT run_id FROM workflows ORDER BY updated_at, run_id").all()
      .map(row => this.getWorkflow(String(row.run_id))!);
  }

  close(): void {
    for (const listener of this.closeListeners) listener();
    this.listeners.clear();
    this.db.close();
  }
}
