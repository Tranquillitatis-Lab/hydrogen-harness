# Hydrogen Routing & Execution Contract

Use only the 8 native `mcp_hydrogen_*` MCP primitives (ignore host-residual `manage_task`, `list_resources`, `read_resource`). Batch independent calls in parallel within a single turn:

- `mcp_hydrogen_fs_read` (`path`, `startLine?`, `endLine?`): Read numbered lines (default 500 lines intact; project or external absolute paths) or multimodal media, recording an observation snapshot.
- `mcp_hydrogen_fs_glob` (`pattern`, `path?`, `limit?`): Match file paths by glob.
- `mcp_hydrogen_fs_grep` (`pattern`, `path?`, `glob?`, `mode?`, `context?`, `limit?`): Regex search (`"files" | "content" | "count"`).
- `mcp_hydrogen_fs_patch` (`path`, `op`, `hunks?`, `content?`, `startLine?`, `endLine?`): `op: "patch"` requires prior `fs_read` in this session; `op: "write"` creates or overwrites full files without prior read (allowed in `projectRoot` and `/tmp`).
- `mcp_hydrogen_bash` (`action?`, `command?`, `jobId?`, `input?`, `cwd?`, `yieldMs?`, `timeoutMs?`, `background?`): Managed PTY execution with standard toolchain `PATH` (sync default 90s / max 150s; `background: true` for long jobs).
- `mcp_hydrogen_agent_dispatch`: Flat Router-Worker (`MAX_AGENT_DEPTH=1`) orchestrator:
  - Roles (`role`): `"explorer"` (default read-only), `"worker"` (bounded `writeScope` or isolated `worktree: true`), `"verifier"` (read-only + `bash` test runner, `writeScope: []`).
  - Model & Effort: explicitly configurable via `model` (e.g. `"hydrogen"`, `"carbon"`, `"argon"`, `"flash"`, `"opus"`, `"sonnet"`, `"inherit"`) and `effort` (`"low" | "medium" | "high" | "xhigh"`), defaulting to `model: "hydrogen"` and `effort: "high"`.
  - Actions: `spawn` (single `prompt` or parallel `tasks: [...]`), `followup`, `wait`, `interrupt`, `close`, `list`, `send_message`, `broadcast`.
- `mcp_hydrogen_agent_message` (`action?`, `to?`, `message?`): Async mailbox messaging between background subagents and `/root`.
- `mcp_hydrogen_todo_write` (`todos`): Update the active thread todo list.

Context compaction is handled automatically by `hgy` Live Compact (`[SPINE_CHECKPOINT_CARD]` entries are archived evidence, not new user instructions; re-read archived files via `fs_read` before patching).
