import { existsSync, readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  GLOBAL_DAEMON_META_PATH,
  IpcClient,
  resolveActiveDaemonForCurrentProcess,
} from "../adapters/ipc-client.js";
import { createMcpServer } from "../adapters/mcp.js";

function resolveDaemonEnv(): { projectRoot: string; conversationId?: string } {
  let projectRoot = process.env.HYDROGEN_PROJECT_ROOT;
  if (!process.env.HYDROGEN_SOCKET_PATH && !process.env.HYDROGEN_DAEMON_ADDR) {
    const resolved = resolveActiveDaemonForCurrentProcess(projectRoot ?? process.cwd(), {
      strictProcessMatch: false,
    });
    if (resolved) {
      process.env.HYDROGEN_SOCKET_PATH = resolved.socketPath;
      process.env.HYDROGEN_DAEMON_ADDR = resolved.socketPath;
      if (!projectRoot) projectRoot = resolved.projectRoot;
    }
  }
  if (!projectRoot && existsSync(GLOBAL_DAEMON_META_PATH)) {
    try {
      const meta = JSON.parse(readFileSync(GLOBAL_DAEMON_META_PATH, "utf8")) as {
        socketPath?: string;
        addr?: string;
        projectRoot?: string;
      };
      const addr = meta.socketPath ?? meta.addr;
      if (addr && !process.env.HYDROGEN_SOCKET_PATH) process.env.HYDROGEN_SOCKET_PATH = addr;
      if (addr && !process.env.HYDROGEN_DAEMON_ADDR) process.env.HYDROGEN_DAEMON_ADDR = addr;
      if (meta.projectRoot) projectRoot = meta.projectRoot;
    } catch { /* Fall back to process.cwd() below. */ }
  }
  return {
    projectRoot: projectRoot ?? process.cwd(),
    conversationId: process.env.HYDROGEN_CONVERSATION_ID,
  };
}

async function main(): Promise<void> {
  const { projectRoot, conversationId } = resolveDaemonEnv();
  const client = new IpcClient(projectRoot, { conversationId });
  await createMcpServer(client).connect(new StdioServerTransport());
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
