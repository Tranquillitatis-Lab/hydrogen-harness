一言以蔽之,就是哈基米很聪明但是agy是区,所以清掉了agy里面的一些过于糟糕的东西(比如把调用工具的历史记录变成[数据清除]导致的哈基米忘记上文现象.agy的开发者是SCP出来的吗?),顺便ban掉了一些很糟糕的工具集,替换成了一个近乎白板的小玩具.(令人惊讶的事情是我家的氢基米在上面似乎确实稍微聪明了,一点点?仍需更多测试.)目前处于极小可用线上下,接下来的重点可能是针对子Agent的调度机制做一些调(chao)优(xi)(笑)让我的周额度可以顺利地在它上面烧完


# Hydrogen Harness (`hgy`)

`hgy` 是面向官方 Antigravity CLI（`agy`）的**非反代去壳增强层（macOS / Windows / Linux 跨平台通用）**。  
不修改 `agy` 二进制、不拦截网络流量，仅通过官方扩展面（Custom Agent + MCP + Hooks + ACP）实现：

- **去壳降噪与规则隔离**：通过 `hgy-shell` / `hgy-subagent`（`excludeDefaultComponents: true` + `inheritCustomizations: false` + `tools: []`）彻底剥离全部内置工具、约 12k tokens 默认提示词及外部原生规则污染，避免触发 `CLEARED` 机械清理，同时保证主从系统提示词 100% 静态缓存命中。
- **8 个 Eager MCP 原语**：`fs_read`（500 行完整无损读取与多模态直传）、`fs_glob`、`fs_grep`、`fs_patch`（观察快照安全校验与全量写支持）、`bash`（标准工具链 `PATH`、最高 150s 同步等待与后台 PTY 托管）、`agent_dispatch`（扁平 `explorer` / `worker` / `verifier` 三角色子 Agent 调度，支持显式指定 `model` 与 `effort`，默认 `hydrogen` + `high`，支持 `writeScope` 与 `worktree` 隔离）、`agent_message`、`todo_write`。
- **缓存命中友好的原位 Live Compact**：借鉴 `dsh-live-compact` 的单调地板（Monotonic Floor）与零模型本地切片机制，直接对 `conversations/<id>.db` 的已完成旧工具输出执行原位 Spine 归档（保留最近 3 个工具轮完整原文，先原子落盘 `.hydrogen/shadow` 再改库），完整保留前序 Prefix Cache 与 `thoughtSignature` 签名链（ACP 模式毫秒级热重载，原生 TUI 模式 260k 高水位无缝热续接）。
- **进程树与数据隔离**：原生 `agy` 自动 `<1ms` 放行；`hgy` 使用独立的 `--app_data_dir hydrogen-cli` 运行目录。

---

## 环境要求

1. **Node.js `>= 22.5.0`**（推荐 Node 24 LTS，需内置 `node:sqlite`）
2. **官方 `agy` CLI（已测试兼容 `1.5.9` – `1.5.11`）**，已在 `PATH` 中且完成账号登录（`agy --version` 可运行）
3. *可选*：`ripgrep`（`rg`）可加速 `fs_glob` / `fs_grep`；未安装时会自动回退到内置 Node 实现

### `agy 1.5.10 / 1.5.11` 兼容性说明

- **`1.5.11` 热修兼容**：`1.5.11` 为 `1.5.10` 之上的静默热修版本（无独立 changelog 条目）；经实测 `CustomAgent` 去壳、`CortexStep` SQLite/Protobuf 布局、Hooks、ACP 与 `transcript.jsonl` 均保持 100% 兼容。
- **与 `1.5.10` 运行时特性的协同**：`1.5.10` 引入的长会话内存分层淘汰（按需回读磁盘旧步骤）、`agy acp` 取消/关闭清理、10 分钟思考超时与 4 分钟限流重试均对 `hgy` 长任务与子 Agent 并发直接利好；`hgy` 的 Live Compact 始终遵循“先停宿主再原位改库再重载”的离线切片纪律，避免内存与磁盘状态不一致。
- **为什么仍需要 `hgy`**：`1.5.10/1.5.11` 仍保留了原生工具步骤的 `CLEARED` 机械清理与云端实验触发的 `<CONTEXT_SUMMARY>` 墙，因此零内置工具去壳与缓存友好的 Live Compact 依然有效；同时 `hgy` 的 `bash` 走独立 Node PTY，不受 `1.5.10` 原生终端沙箱收紧影响。

---

## 快速安装（Windows / macOS 通用）

### 方式一：直接安装 Release npm 包（推荐，无需克隆或编译）

在已安装 Node.js 和原生 `agy` 的电脑上执行：

**Windows (PowerShell)：**
```powershell
npm install -g https://github.com/Tranquillitatis-Lab/hydrogen-harness/releases/download/v1.0.0/hydrogen-harness-1.0.0.tgz
hgy setup --with-lean --force
```
*(如从 Releases 页面手动下载了 `.tgz`，则执行 `npm install -g .\hydrogen-harness-1.0.0.tgz`)*

**macOS / Linux：**
```bash
npm install -g https://github.com/Tranquillitatis-Lab/hydrogen-harness/releases/download/v1.0.0/hydrogen-harness-1.0.0.tgz
hgy setup --with-lean --force
```

`hgy setup` 会自动根据当前系统的用户目录与 `node` 路径，将以下配置装配到 `~/.gemini/config/`（Windows 为 `%USERPROFILE%\.gemini\config\`）：
- `agents/hgy-shell.md`（主控零内置工具壳与编排契约）
- `agents/hgy-subagent.md`（100% 静态子 Agent 专职壳，保障跨子任务缓存命中）
- `agents/lean.md`（可选精简原生 Agent）
- `mcp_config.json`（合并 `hydrogen` MCP Server）
- `hooks.json`（合并 `hydrogen-harness` 生命周期钩子）
- 初始化 `~/.gemini/hydrogen-cli` 隔离目录

### 方式二：从源码克隆构建（适合二次开发）

```bash
git clone https://github.com/Tranquillitatis-Lab/hydrogen-harness.git
cd hydrogen-harness
npm install
npm run build
npm install -g .
hgy setup --with-lean --force
```

---

## 常用启动与验收命令

```bash
agy agents                               # 确认已识别 hgy-shell、hgy-subagent 与 lean
hgy -p "列出你当前可用的工具名称"            # 单轮非交互冒烟测试
hgy                                      # 启动原生 agy TUI + 260k 缓存友好 Live Compact 守护
hgy --web                                # 启动 WebUI 控制面板
hgy --repl                               # 使用轻量 readline REPL
hgy setup --dry-run                      # 预览配置路径，不写入磁盘
```

> 仍可直接运行原版 `agy`；未通过 `hgy` 启动的普通 `agy` 会话会被钩子自动放行，零额外开销。
