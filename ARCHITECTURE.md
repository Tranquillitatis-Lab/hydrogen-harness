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

## 二、自我批判：为什么 `hgy` 现有的内部 Harness 架构与设计原则是一团糟？

虽然我们成功拆掉了 `agy` 的外壳护栏与冗余提示词，但 **`hgy` 目前内部的代码实现（`src/core/*`）沿用了一套过度教条、脱离 LLM 实际工作流的“分布式数据库式”设计原则**，导致模型在实际使用工具时处处受阻。

### 1. 现有设计原则的四大误区

1. **误区一：把单机 Coding Agent 当成“不可信的拜占庭将军”来防（过度设计的租约、Epoch 与路径沙箱）**
   - **表现**：设计了复杂的 `epoch`、写租约（`assertWriteLease`）、`STALE_EPOCH` 报错和死板的 `normPath` 项目根目录沙箱（`src/core/files.ts:19-50`）。
   - **恶果**：
     - 模型想读一下 `/tmp` 下的日志、`/opt/anaconda3` 下的库代码、或者上级目录的参考文件，`normPath` 直接抛 `PERMISSION_DENIED: Path escapes the project root`。
     - 一旦发生 Epoch 切换，旧 `sessionId` 的文件观察记录、子 Agent、工作流全部因为 `epoch !== activeEpoch` 报 `STALE_EPOCH` 作废。

2. **误区二：把 Compact 做成了“强制杀进程重开 + 逼模型手写八股文”（怪异的轮转机制）**
   - **表现**：`src/core/handover.ts` 要求模型在日常工作中分心去调 `handover_checkpoint` 维护 `{ activeGoal, verifiedFacts, deadEndsTried, nextImmediateStep }`；轮转时直接 `SIGTERM` 杀掉当前进程重启。
   - **恶果**：
     - 在 0~300k 上下文完全干净的情况下，逼模型手动填 checkpoint 纯属浪费智商与 token。
     - 杀进程重启会打断用户的 TUI 视觉连续性，且机械拼接的 JSON `HandoffPacket` 既生硬又缺乏代码上下文细节。

3. **误区三：工具输入/输出协议充满“反模型人体工学”的设计（双重 JSON 序列化与糟糕报错）**
   - **表现**：
     - **双重 JSON 转义污染（`src/adapters/mcp.ts:12`）**：所有工具返回值都被 `JSON.stringify(result)` 包成单行 JSON 字符串。模型调用 `fs_read` 读代码或调用 `bash` 看输出时，看到的是满屏 `\n`、`\"`、`\\t` 的转义文本，不仅多耗 15%~20% token，还极易导致后续写 `fs_patch` 时数错缩进和转义符。
     - **`fs_patch` 缺乏全量写模式且报错似谜语（`src/core/files.ts:195-235`）**：
       - `op: "create"` 用了 `flag: "wx"`，对已存在的文件直接报错 `File already exists`；模型想重写一个 30 行的配置文件时，被迫把旧文件全文塞进 `oldText` 走 `patch`。
       - `oldText` 匹配失败时只报 `"Each oldText must match exactly once in the current text"`，**不告诉模型是匹配了 0 次还是匹配了多次（也不给行号）**，导致模型盲目重试。
     - **`fs_read` 空文件与硬截断 Bug（`src/core/files.ts:243-253`）**：空文件 `lines.pop()` 后返回 `startLine: 1, endLine: 0`；且固定一次最多 400 行。
     - **`bash` 硬编码 30 秒超时导致轮询地狱（`src/core/process.ts:65`）**：`yieldMs = Math.min(30_000, ...)` 将单次命令等待时间锁死在 30 秒以内。跑一个 40 秒的构建或测试就会变成后台 job，迫使模型一轮接一轮地调用 `bash({ action: "poll", jobId })`，每轮 `poll` 都白白重算一遍几十万的上下文 Cache Token！而且 `ProcessManager.start` 没有注入本机标准开发工具链 `PATH`。

4. **误区四：子 Agent 调度器沦为“残废的只读玩具”（`src/core/agents.ts`）**
   - **表现**：
     - 只有 `role: "explorer"` 一种只读角色，连跑个 Python 小脚本或单测验证假设的权限都没有，也无法派发有边界的写任务（Worker）。
     - 模型不可选（写死主会话模型）。
     - 异步等待接口 `agent_wait({ afterSeq })` 要求模型传入内部自增事件序号 `afterSeq`，完全违背 LLM 的直觉。

---

## 三、下一阶段（新 Session）待讨论与重构的核心议题

在新会话中，我们应当**推倒 `hgy` 内部那套繁琐的“租约/Epoch/沙箱”教条**，重新确立一套真正服务于模型生产力与上下文效率的 Harness 设计原则：

### 议题 1：重新定义 `hgy` 的核心设计原则（建议草案）
1. **模型人体工学优先（Model Ergonomics First）**：
   - 工具的输入参数应极其符合直觉，工具的输出必须是**零转义的干净纯文本（Clean Plaintext）**，报错信息必须给出**立即可行动的修正线索**（如匹配行号、相似片段）。
2. **宽进严出、去沙箱枷锁（Frictionless Read, Guarded Write）**：
   - 本机任意路径对读/检索工具（`fs_read`、`fs_glob`、`fs_grep`）完全敞开；写操作默认对工作区与 `/tmp` 敞开，用轻量版本校验（防误覆盖外部修改）代替沉重的分布式租约与 Epoch 锁。
3. **一次调用完结，拒绝轮询刷步数（One-Shot Completion over Polling）**：
   - 无论是 `bash` 执行命令（支持高达 5~10 分钟同步等待）还是 `agent_dispatch` 并行派发多个子 Agent（支持 `Promise.all` 同步扇出/扇入一步返回），都应尽量在**单次工具调用**内返回完整结论，避免模型为了等结果而空转多轮消耗 Cache Token。
4. **对模型隐形的无感 Compact（Invisible Compaction）**：
   - 彻底废除 `handover_checkpoint` 八股文工具与 `STALE_EPOCH` 机制；Compact 完全由 Harness 在 300k 阈值处（或用户手动触发时）自动完成上下文蒸馏与注入。

---

### 议题 2：核心代码模块的重写清单（供新会话逐项拍板实施）

| 模块 | 涉及文件 | 计划重写内容 |
| :--- | :--- | :--- |
| **1. 文件与搜索工具集** | `src/core/files.ts`<br>`src/adapters/mcp.ts` | • 移除 `normPath` 对只读操作的 `projectRoot` 限制<br>• `fs_read` / `fs_grep` / `fs_glob` 改为纯文本格式化输出（去掉双重 JSON 转义）<br>• `fs_patch` 增加 `op: "write"`（全量覆写/新建）、可选 `startLine`/`endLine` 范围锚定、换行符归一化、以及精确到行号的 0-match / multi-match 诊断报错 |
| **2. 命令执行器 (`bash`)** | `src/core/process.ts` | • 默认注入 `~/AGENTS.md` 中的完整开发工具链 `PATH`<br>• 同步执行等待上限提升至 `300_000ms`（5 分钟，默认 `120_000ms`），彻底消除 30 秒强制断连轮询<br>• 显式区分同步命令与 `background: true` 后台任务，直接返回干净的 `[exit: 0] + stdout/stderr` 纯文本 |
| **3. 子 Agent 编排器** | `src/core/agents.ts`<br>`src/core/protocol.ts` | • 支持三类角色：`explorer`（只读检索+只读命令）、`worker`（带 `writeScope` 文件边界锁的并行修改者）、`verifier`（只读源码 + 可跑测试/构建的独立验证者）<br>• 支持 `tasks: [...]` 批量并行派发并默认阻塞汇总返回，砍掉反人类的 `agent_wait(afterSeq)`<br>• 支持按任务指定 `model`（默认 `gemini-4-hydrogen-high`） |
| **4. 300k Compact 引擎** | `src/core/handover.ts`<br>`src/core/runtime.ts`<br>`src/entry/cli.ts` | • 移除 `handover_checkpoint` 工具与 `STALE_EPOCH` 报错，文件观察与后台任务按 `threadId` 持久绑定<br>• 重新设计 300k Compact 的触发与上下文蒸馏机制（探讨如何在尽量不打断用户体验的前提下完成 300k 上下文压缩） |
