# Hydrogen Harness (`hgy`)

`hgy` 是面向官方 Antigravity CLI（`agy`）的**非反代去壳增强层（macOS / Windows / Linux 跨平台通用）**。  
不修改 `agy` 二进制、不拦截网络流量，仅通过官方扩展面（Custom Agent + MCP + Hooks + ACP）实现：

- **去壳降噪**：通过 `hgy-shell`（`excludeDefaultComponents: true` + `tools: []`）剥离全部内置工具与约 12k tokens 的默认提示词，避免内置工具触发 `CLEARED` 机械清理。
- **8 个 Eager MCP 原语**：`fs_read`、`fs_glob`、`fs_grep`、`fs_patch`、`bash`（支持长达 300s 同步等待与后台托管）、`agent_dispatch`（扁平 Router-Worker 子 Agent 调度 + worktree 隔离）、`agent_message`、`todo_write`。
- **300k Spine Compact**：自动监听 `transcript.jsonl` 与上下文用量，通过 `PreInvocation` 注入结构化 Spine 检查点卡片。
- **进程树与数据隔离**：原生 `agy` 自动 `<1ms` 放行；`hgy` 使用独立的 `--app_data_dir hydrogen-cli` 运行目录。

---

## 环境要求

1. **Node.js `>= 22.5.0`**（推荐 Node 24 LTS，需内置 `node:sqlite`）
2. **官方 `agy` CLI（已测试兼容 `1.5.9` – `1.5.10`）**，已在 `PATH` 中且完成账号登录（`agy --version` 可运行）
3. *可选*：`ripgrep`（`rg`）可加速 `fs_glob` / `fs_grep`；未安装时会自动回退到内置 Node 实现

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
- `agents/hgy-shell.md`（去壳与 8 工具契约）
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
agy agents                               # 确认已识别 hgy-shell 与 lean
hgy -p "列出你当前可用的工具名称"            # 单轮非交互冒烟测试
hgy                                      # 启动原生 agy TUI + hgy 300k Compact 守护
hgy --web                                # 启动 WebUI 控制面板
hgy --repl                               # 使用轻量 readline REPL
hgy setup --dry-run                      # 预览配置路径，不写入磁盘
```

> 仍可直接运行原版 `agy`；未通过 `hgy` 启动的普通 `agy` 会话会被钩子自动放行，零额外开销。
