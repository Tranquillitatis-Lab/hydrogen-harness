import { createInterface } from "node:readline";
import { createContext, Script } from "node:vm";

// The worker has no filesystem/child-process grants. User code gets only JSON RPC capabilities.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
let context: ReturnType<typeof createContext> | undefined;
let started = false;
lines.on("line", line => {
  void receive(line).catch(error => {
    send({ jsonrpc: "2.0", id: "run", error: { message: error instanceof Error ? error.message : String(error) } });
    process.exitCode = 1;
    lines.close();
    process.stdin.pause();
  });
});

async function receive(line: string): Promise<void> {
  const message = JSON.parse(line) as { id: string | number; method?: string; params?: { code: string }; result?: unknown; error?: unknown };
  if (message.method === "run") {
    if (started) throw new Error("Worker accepts exactly one workflow");
    started = true;
    const bridge = (json: string) => {
      try { send(JSON.parse(json)); }
      catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
    };
    Object.setPrototypeOf(bridge, null);
    Object.freeze(bridge);
    context = createContext({ __send: bridge }, { codeGeneration: { strings: false, wasm: false } });
    new Script(`
      const rpc = (() => {
        const send = globalThis.__send;
        delete globalThis.__send;
        let nextId = 0;
        const pending = new Map();
        globalThis.__receive = json => {
          const message = JSON.parse(json);
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if (message.error) waiter.reject(new Error(message.error.message));
          else waiter.resolve(message.result);
        };
        return (method, params) => new Promise((resolve, reject) => {
          const id = ++nextId;
          pending.set(id, { resolve, reject });
          send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        });
      })();
      const sys = Object.freeze({
        glob: input => rpc('sys.glob', typeof input === 'string' ? { pattern: input } : input),
        grep: input => rpc('sys.grep', input),
        readSlice: (input, startLine, endLine) => rpc('sys.readSlice', typeof input === 'string' ? { path: input, startLine, endLine } : input),
        exec: (input, opts = {}) => rpc('sys.exec', typeof input === 'string' ? { ...opts, command: input } : input),
      });
      const agent = (prompt, opts = {}) => rpc('agent', { prompt, opts });
      const parallel = thunks => Promise.all(thunks.map(thunk => thunk()));
    `).runInContext(context);
    const value = await new Script(`(async () => {\n${message.params!.code}\n})()`, { filename: "workflow.js" }).runInContext(context);
    // Serialize in the user realm, so hostile getters cannot execute on the host stack.
    context.__value = value;
    const result = new Script("JSON.stringify(__value ?? null)").runInContext(context) as string;
    send({ jsonrpc: "2.0", id: "run", result: JSON.parse(result) });
    lines.close();
    process.stdin.pause();
  } else if (context) {
    new Script(`globalThis.__receive(${JSON.stringify(line)})`).runInContext(context);
  }
}
