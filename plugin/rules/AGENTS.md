# Hydrogen routing

Use the 8 Eager native Hydrogen MCP tools (`mcp_hydrogen_*`) directly; independent calls can run in parallel in a single step:

- `mcp_hydrogen_fs_read` (`path`, `startLine?`, `endLine?`): Read numbered lines (default up to 500 lines; project or external absolute paths), or natively load multimodal media files (images, audio, video, PDF), and record an observation snapshot.
- `mcp_hydrogen_fs_glob` (`pattern`, `path?`, `limit?`): Match file paths by glob pattern.
- `mcp_hydrogen_fs_grep` (`pattern`, `path?`, `glob?`, `mode?`, `context?`, `limit?`): Regex search (`mode`: `"files" | "content" | "count"`).
- `mcp_hydrogen_fs_patch` (`path`, `op`, `hunks?`, `content?`, `startLine?`, `endLine?`): Per-file concurrent edits supporting `op: "patch"`, `"write"`, `"create"`, and `"delete"`.
- `mcp_hydrogen_bash` (`action?`, `command?`, `jobId?`, `input?`, `cwd?`, `yieldMs?`, `timeoutMs?`, `background?`): Managed stateful PTY execution (default `action: "exec"`, sync wait default 90s / up to 150s, `background: true` for long-running jobs, plus `stdin`/`poll`/`kill`).
- `mcp_hydrogen_agent_dispatch`: Flat Router-Worker (`MAX_AGENT_DEPTH=1`) subagent orchestrator:
  - `spawn` (default, alias `dispatch`): Start one or batch `tasks: [...]` workers with custom `tools: [...]` (`"fs_read" | "fs_glob" | "fs_grep" | "fs_patch" | "bash" | "agent_message" | "todo_write"`, default `["fs_read", "fs_glob", "fs_grep", "agent_message"]`; `"agent_message"` is retained unless `disableAgentMessage: true`), optional `writeScope`, `worktree: true` (isolated git worktree under `<projectRoot>/.hydrogen/worktrees/<agentId>` with isolated `cwd` and `writeScope`), `forkTurns: "none" | "all"` (inherits parent model when `"all"`), and `wait: false` async mode.
  - `followup` (aliases `send` / `resume`): Send follow-up instructions to a live or hibernated subagent (draining any queued mailbox messages), reusing warm ACP sessions or transparently resuming cold-hibernated ones on demand.
  - `send_message` / `broadcast`: Queue peer-to-peer, multicast, or `@all`/`*` broadcast mailbox messages without triggering extra turns on idle subagents; running recipients receive them mid-turn via `PreInvocation`.
  - `wait`: Cursorless wait for background subagents (`waitAll`).
  - `interrupt`: Cancel the current turn while keeping the session.
  - `close`: Close a subagent and clean up all alive `pty_jobs` under its `sessionId`.
  - `list` (alias `status`): Inspect active subagents.
- `mcp_hydrogen_agent_message` (`action?`, `to?`, `message?`): Peer-to-peer, multicast (`string[]`), and broadcast (`"@all"` / `"*"` or `action: "broadcast"`) messaging (`action`: `"send" | "broadcast" | "read"`). Subagent broadcasts automatically deliver to all active sibling subagents plus `/root`. Running recipients receive messages mid-turn via `PreInvocation` without breaking prefix cache; idle recipients queue them until `followup`.
- `mcp_hydrogen_todo_write` (`todos`): Update the active thread todo list.

Context compaction and handover are handled automatically by `hgy`'s Spine Compact engine. Session identity comes from the host environment; never supply or override it in tool arguments.
