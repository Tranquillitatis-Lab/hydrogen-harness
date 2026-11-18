# Hydrogen Harness (`hgy`) 架构复盘、底层逆向档案与重构规划

> **文档目的**：沉淀目前已验证成功的 **“`agy` 非反代去壳与原生 TUI 接管方案”**，客观剖析 `hgy` **现有内部 Harness 架构与设计原则的病灶**，并为下一阶段的新会话重构提供完整上下文基线。

---

## 一、已验证的可靠基石：如何在“非反代”前提下拆解 `agy` 并接管底座

### 1. 为什么 `hgy` 不是反代（Reverse Proxy），却能彻底替换 `agy` 的工具集与提示词？

- **不触碰红线**：所有网络请求（`daily-cloudcode-pa.googleapis.com`）、OAuth 凭证刷新、TLS 指纹、gRPC/Protobuf 序列化以及二进制签名，100% 由官方原版 `~/.local/bin/agy`（当前测试版本 `v1.2.15`）直接执行，无任何中间人抓包、流量篡改或二进制 Patch。
- **三大官方扩展接口组合接管**：
  1. **Custom Agent 装配面（`~/.gemini/config/agents/hgy-shell.md`）**：
     - 经反汇编 `agy` 的 `customizations.ParseAgentScriptItemFromMarkdown`（地址 `0x101767850`），`AgentFrontmatter`（结构体定义于 `0x10a8666f0`）支持 19 个 YAML 字段：`name`、`description`、`disabled`、`tools` (`*[]string`)、`excludeDefaultComponents` (`*bool`)、`mainAgent`、`subagent`、`hidden`、`inheritCustomizations`、`inheritMcp`、`model`、`commandExecutionPolicy`、`mcpServers`、`skills`、`preloadSkills`、`plugins`、`rules`、`agents`、`hooks`。
     - 当设置 **`excludeDefaultComponents: true`** 且 **`tools: []`** 时：
       - **内置工具清零**：在 `0x101767a28`–`0x101767a90` 分支中，`agy` 跳过 `defaultTools`（`0x10d297220`–`0x10d2972a0`），甚至连自动追加的 `send_message`（`0x101767a38`）也一并跳过，实现 **0 原生内置工具挂载**。
       - **默认系统提示词清零**：在 `0x1017686d8` 分支中，`agy` 跳过 `defaultPromptSections`（`0x10d2a1100`：`user_information`、`mcp_servers`、`skills`、`user_rules`、`messaging`、`artifacts`、`guidelines`、`communication_style`），直接省去约 **12,000 tokens** 的冗余系统提示词。
     - 注意：外发版 `agy` 在 `customizations.init`（`0x1017633e8`）中调用 `newAgentsCustomization(false)`，关闭了 `.json` Agent 解析，**仅支持 `.md` 格式的自定义 Agent**。
  2. **MCP 工具注入面（`~/.gemini/config/mcp_config.json`）**：
     - 在 `hgy-shell.md` 开启 `inheritMcp: true` 后，`agy` 仅挂载 MCP Server 提供的工具（`hydrogen` -> `dist/entry/mcp-shim.js`）。
  3. **Lifecycle Hooks 拦截与注入面（`~/.gemini/config/hooks.json`）**：
     - 挂载 `SessionStart`、`PreInvocation`、`PreToolUse`、`PostToolUse`、`Stop` 五个生命周期钩子（`dist/entry/hook-cli.js`）。
     - **进程树隔离（`src/entry/hook-cli.ts`）**：`hgy` 启动时将自身 PID 与拉起的 `agy` TUI 子进程 PID（`tuiPid`）写入 `/tmp/hgy_active_daemon.json`。`hook-cli.js` 被调用时检查调用方是否属于 `hgy` 拉起的进程树（`isDescendantOf(tuiPid)` 或 `HYDROGEN_ACTIVE=1`）；**普通 `agy` 会话在 `<1ms` 内直接放行（`{"decision":"allow"}` / `{}`），与 `hgy` 完全隔离**。

---

### 2. `agy` 内部 Compact 机制的逆向真相（为什么以前在 150k~250k 变傻，为什么现在能稳跑 300k）

通过对 `agy` 二进制反汇编与 `transcript.jsonl` 实测，确认 `agy` 内部存在**两套截断机制**：

1. **第一层：机械步骤清理（`StepCompactionConfig`，内部日志称 `mechanical compaction`）**
   - 在会话远未达到上下文上限时，`agy` 会把较早步骤的**原生内置工具输出**（`read_file`、`run_command` 等）在内存中抹除为 `CLEARED`。
   - 模型看到历史步骤变成空壳后丢失行号与报错细节，开始反复重读文件、原地打转。
   - **破解方式**：在 `hgy-shell` 下原生内置工具为 `0`，所有工具调用均走 MCP，不再触发针对原生工具步骤的 `CLEARED` 清理。

2. **第二层：云端实验参数控制的会话级 Checkpoint（`CheckpointConfig` -> `<CONTEXT_SUMMARY>`）**
   - 本地默认函数 `GetDefaultCheckpointConfigForModel`（`0x101382f20`）原本计算 `tokenThreshold = contextWindow - max(maxOutputTokens, 40000)`（对 1M 模型为 `936,000`）。
   - **但** `selectCheckpointExperimentKey`（`0x1014dd320`）和 `applyFeatureProviderCheckpointOverrideConfig`（`0x1014dd4a0`）会从云端拉取名为 **`checkpoint-variant`** 和 **`context-window`** 的实验参数覆盖本地阈值！
   - 经核查 `transcript.jsonl`（step 268–276），当前云端实验的 `CHECKPOINT` 触发线在 **`input_tokens + cache_read_tokens ≈ 500,000 tokens`**（实测在 `500,946 -> 523,355` tokens 时触发 `<CONTEXT_SUMMARY>`）。
   - **破解方式**：
     - 云端推理 API 本身**不会**暗中截断上下文；触发 `<CONTEXT_SUMMARY>` 的执行器就在本地 `agy` 进程内。
     - 只要 `hgy` 从 `transcript.jsonl` 实时读取真实的 **`input_tokens + cache_read_tokens`**（注意：在 Gemini API 记录中，`input_tokens` 仅代表未命中的尾部增量 token，`cache_read_tokens` 才是缓存前缀 token，两者之和才是真实上下文长度），并在 **300,000 tokens（300k）** 主动执行 `hgy` 自己的 Compact，就**永远不会撞上 `agy` 500k 的劣质 `<CONTEXT_SUMMARY>`**。

---

### 3. 为什么放弃自绘 Readline TUI，改为 `stdio: "inherit"` 托管原生 `agy` TUI？

- Node.js 的 `node:readline`（`terminal: true`）在 macOS 中文输入法（IME）下会频繁调用 `_refreshLine()`（发送 `\r\x1b[0J` 重绘整行），且对 ANSI 颜色码与宽字符列宽计算不准，导致中文候选框乱跳、吞字、以及流式输出与用户输入同屏撞车。
- `agy` 自身拥有成熟的 Go 原生 TUI（`third_party/jetski/cli/editing/` 与 `third_party/jetski/cli/render/`）。
- 因此，`src/entry/cli.ts`（`runNativeAgyTui`）改为**由 `hgy` 在后台运行 `HydrogenRuntime` 守护进程，前台直接以 `stdio: "inherit"` 拉起 `agy --agent hgy-shell`**。输入法体验、人类输入气泡、思考折叠块与工具调用卡片 100% 由原生 `agy` TUI 渲染。

---

### 4. 已落地的外部配置文件清单

| 文件路径 | 作用 |
| :--- | :--- |
| `~/AGENTS.md` | 本机共用规则：固化 Homebrew、Conda、Node v24.15.0、uv Python、TeX、`~/.local/bin` 及 18 个预置 Conda 环境路径 |
| `~/.gemini/config/AGENTS.md` | `agy` 运行与调度规则：无状态命令合并、长输出重定向、防 Compact 原则、Argon/Hydrogen 子 Agent 调度规则 |
| `~/.gemini/config/agents/hgy-shell.md` | `hgy` 专用零内置工具壳 Agent（`excludeDefaultComponents: true`, `tools: []`, `inheritMcp: true`, `inheritCustomizations: true`） |
| `~/.gemini/config/agents/lean.md` | 普通 `agy` 可选精简主控 Agent |
| `~/.gemini/config/mcp_config.json` | 挂载 `hydrogen` MCP Server（`dist/entry/mcp-shim.js`） |
| `~/.gemini/config/hooks.json` | 挂载生命周期钩子（`dist/entry/hook-cli.js`，带进程树校验，普通 `agy` 自动放行） |
| `~/.local/bin/hgy` | `hgy` 全局启动入口脚本 |

---

## 二、核心机制：缓存命中友好的原位 Live Compact 与扁平子 Agent 编排

### 1. 原位 SQLite Live Compact（`src/core/live-compact.ts`）

针对 `agy` 本地持久化库 `~/.gemini/hydrogen-cli/conversations/<convId>.db`（SQLite 3 `steps` 表，`CortexStep` Protobuf 编码），借鉴 `dsh-live-compact` 的设计纪律实现了零模型调用的原位压缩器：

1. **只压工具结果正文，不动签名与调用配对**：
   - `step_type = 15`（`PLANNER_RESPONSE`）内含 Gemini 3/4 强校验的 `thought_signature` 与 `functionCall` 列表；`step_type = 132`（`MCP_TOOL`）的 `field 140 -> field 2 -> field 1` 则承载实际发往大模型的工具输出文本（实测占长会话总上下文 80%+）。
   - `compactConversationSqlite` 保持全部 `step_type = 14`（用户输入）、`step_type = 15`（模型思考/工具调用签名）及步骤序号 `idx` 100% 原封不动，仅对选中区间内的 `step_type = 132` 输出字段进行原位 Spine 折叠，杜绝 `thoughtSignature` 失效与工具配对断链。
2. **单调右移地板（Monotonic Floor）保死 Prefix Cache**：
   - 每次切片在右边界锚点写入 `[SPINE_CHECKPOINT_CARD v1 | cut=...]` 地板标记；后续切片严格限制 `cutStartIdx > floorBefore`，**绝不触碰左侧已缓存前缀的任何一个字节**。
   - 保留最近 `keepRounds = 3` 个已完成普通工具轮完整原文；若最新轮出现 `>= 24k tokens` 的超大非报错输出，立即触发尾端指针化切片（此时右侧重写尾巴趋近于 0）。
   - **失败诊断门禁与原子备份**：报错步骤完整保留退出码与诊断行；切片前先将原始输出原子落盘至 `.hydrogen/shadow/cut-*.log`（`0o600` 权限 + SHA256/字节数校验），备份失败则拒绝改库。
3. **ACP 与原生 TUI 双通道衔接**：
   - **ACP 模式（`--web` / `--repl` / `-p`）**：通过 `AcpSessionAdapter.closeAndFlushHost` 刷盘并释放 Go 进程内存轨迹缓存后执行毫秒级 SQLite 原位切片，随即 `session/load` 重载同一 `conversationId`，实测云端 `cache_read_tokens` 持续命中前序前缀。
   - **原生 `agy` TUI 模式**：移除早期 `effectiveTokens = 4000` 假账，实时读取 `transcript.jsonl` 的真实 `input_tokens + cache_read_tokens`；到达 `260k` 水位线（远低于 `agy` 云端实验 `500k` `<CONTEXT_SUMMARY>` 墙）且存在可切轮次时，在 `Stop` 钩子收尾后优雅退出当前子进程、原位压缩 `<convId>.db` 并原地无缝重拉 `agy --conversation <convId>`。

### 2. 扁平三角色子 Agent 调度与双壳静态提示词（`src/core/agents.ts` / `src/entry/setup.ts`）

- **三类专职角色（`MAX_AGENT_DEPTH=1`）**：
  - `explorer`（默认）：纯只读（`fs_read`、`fs_glob`、`fs_grep`），同步任务默认不挂载 `agent_message` 以避免双重汇报空转。
  - `worker`：有界读写执行者（含 `fs_patch`、`bash`），支持 `writeScope` 文件边界锁或 `worktree: true` 独立 Git 工作树（完成时自动附带 `git status/diff --stat` 摘要）。
  - `verifier`：独立验收者（只读检索 + `bash`，自动锁定 `writeScope: []`），实现编码与验证硬隔离。
- **显式模型与思考强度控制**：`agent_dispatch` 支持在顶层或每个子任务显式传入 `model`（如 `hydrogen`、`carbon`、`argon`、`flash`、`opus`、`sonnet`、`inherit`）与 `effort`（`low | medium | high | xhigh`），默认设定为 `model: "hydrogen"` + `effort: "high"`（即 `gemini-4-hydrogen-high`），并自动适配不同模型家族的最高档位。
- **双壳零污染静态提示词**：
  - `hgy-shell.md` 与 `hgy-subagent.md` 均设置 `inheritCustomizations: false`，彻底隔绝 `~/.gemini/config/AGENTS.md` 中原生 `agy` 工具指令的跨壳污染。
  - 子 Agent 动态契约（`agentId`、`role`、`writeScope`、`worktree`）统一置于首轮用户消息 `[SUBAGENT_CONTRACT]` 头部，保证 `hgy-subagent` 系统提示词跨任务 100% 字节静态一致。
  - 主会话 `mainAgyTurns` 与子任务池 `agyTurns`（容量 4）信号量解耦，支持单步 4 路子 Agent 满并发扇出。

