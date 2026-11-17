import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runHook } from "../adapters/hooks.js";
import { isPidAlive, isPipePath, resolveActiveDaemonForCurrentProcess } from "../adapters/ipc-client.js";
import type { HookCommonInput } from "../core/protocol.js";

function resolveHgySession(candidateRoot: string): { projectRoot: string; socketPath?: string } | undefined {
  const envSocket = (process.env.HYDROGEN_SOCKET_PATH || process.env.HYDROGEN_DAEMON_ADDR)?.trim();
  if (envSocket) {
    if (!isPipePath(envSocket) && !existsSync(envSocket)) return undefined;
    return {
      projectRoot: process.env.HYDROGEN_PROJECT_ROOT ?? candidateRoot,
      socketPath: envSocket,
    };
  }
  const fromHgyEnv = Boolean(
    process.env.HYDROGEN_ACTIVE === "1" ||
    process.env.HYDROGEN_SESSION_ID,
  );
  const resolved = resolveActiveDaemonForCurrentProcess(candidateRoot, {
    strictProcessMatch: !fromHgyEnv,
  });
  if (resolved) {
    return {
      projectRoot: process.env.HYDROGEN_PROJECT_ROOT ?? resolved.projectRoot ?? candidateRoot,
      socketPath: resolved.socketPath,
    };
  }
  if (fromHgyEnv) {
    const localPidPath = join(candidateRoot, ".hydrogen/run/daemon.pid");
    if (existsSync(localPidPath)) {
      const pid = Number(readFileSync(localPidPath, "utf8").trim());
      if (isPidAlive(pid)) return { projectRoot: candidateRoot };
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let json = "";
  for await (const chunk of process.stdin) json += chunk;
  const input = JSON.parse(json) as HookCommonInput;
  const candidateRoot = input.workspacePaths?.[0] ?? input.cwd ?? process.env.HYDROGEN_PROJECT_ROOT ?? process.cwd();
  const active = resolveHgySession(candidateRoot);
  if (!active) {
    // Normal `agy` session (not started via `hgy`): pass through immediately with zero side effects.
    const passthrough = input.hookEventName === "PreToolUse" ? { decision: "allow" } : {};
    process.stdout.write(JSON.stringify(passthrough) + "\n");
    return;
  }
  if (active.socketPath) {
    process.env.HYDROGEN_SOCKET_PATH = active.socketPath;
    process.env.HYDROGEN_DAEMON_ADDR = active.socketPath;
  }
  const output = await runHook(active.projectRoot, input);
  process.stdout.write(JSON.stringify(output) + "\n");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
