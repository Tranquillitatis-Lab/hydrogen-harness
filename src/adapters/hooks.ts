import type {
  HookCommonInput, PreInvocationOutput, PreToolUseOutput, StopHookOutput,
} from "../core/protocol.js";
import { IpcClient } from "./ipc-client.js";

export type HookOutput = PreToolUseOutput | PreInvocationOutput | StopHookOutput | Record<string, never>;

export async function runHook(projectRoot: string, input: HookCommonInput): Promise<HookOutput> {
  const client = new IpcClient(projectRoot, { conversationId: input.conversationId, timeoutMs: 5000 });
  switch (input.hookEventName) {
    case "SessionStart":
      await client.call("session.register", input);
      return {};
    case "PreToolUse":
      return client.call<PreToolUseOutput>("hook.preToolUse", input);
    case "PostToolUse":
      await client.call("hook.postToolUse", input);
      return {};
    case "PreInvocation":
      return client.call<PreInvocationOutput>("hook.preInvocation", input);
    case "Stop":
      return client.call<StopHookOutput>("hook.stop", input);
    default:
      throw new Error(`Unsupported hook event: ${input.hookEventName}`);
  }
}
