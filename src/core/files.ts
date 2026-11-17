import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LIMITS } from "./protocol.js";
import type { FsReadInput, FsGlobInput, FsGrepInput, FsPatchInput, ObservedFileRecord, SpillResult } from "./protocol.js";
import type { OutputSpill } from "./output.js";
import { HydrogenError, StateStore } from "./state.js";

function inside(root: string, path: string): boolean {
  const r = process.platform === "win32" ? resolve(root).toLowerCase() : root;
  const p = process.platform === "win32" ? resolve(path).toLowerCase() : path;
  const rel = relative(r, p);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Resolve existing symlinks, including the existing parent of a non-existent path. */
function resolveWithSymlinks(candidate: string): string {
  let ancestor = candidate;
  const missing: string[] = [];
  for (;;) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  return resolve(realpathSync(ancestor), ...missing);
}

/**
 * Resolve any readable path on disk: arbitrary absolute paths are allowed
 * (e.g. /tmp, /opt/anaconda3, /Users/...), while relative paths resolve against projectRoot.
 */
export function resolveReadPath(projectRoot: string, rawPath: string): string {
  const lexicalRoot = resolve(projectRoot);
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(lexicalRoot, rawPath);
  return resolveWithSymlinks(candidate);
}

const TEMP_WRITE_ROOTS = [...new Set([
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
  tmpdir(),
  process.env.TEMP ?? "",
  process.env.TMP ?? "",
].filter(Boolean))];

/**
 * Resolve a writable path: allows files inside projectRoot (excluding .hydrogen)
 * and temporary files under OS temp directories.
 */
export function resolveWritePath(projectRoot: string, rawPath: string): string {
  const lexicalRoot = resolve(projectRoot);
  const realRoot = realpathSync(lexicalRoot);
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(lexicalRoot, rawPath);
  const normalized = resolveWithSymlinks(candidate);

  if (inside(realRoot, normalized)) {
    const privateRoot = join(realRoot, ".hydrogen");
    if (inside(privateRoot, normalized)) {
      throw new HydrogenError("PERMISSION_DENIED", "Cannot write inside .hydrogen directory");
    }
    return normalized;
  }

  for (const tempRoot of TEMP_WRITE_ROOTS) {
    let realTempRoot = tempRoot;
    try { realTempRoot = realpathSync(tempRoot); }
    catch { /* Keep lexical temp root if not present on disk. */ }
    if (inside(tempRoot, normalized) || inside(realTempRoot, normalized)) {
      return normalized;
    }
  }

  throw new HydrogenError(
    "PERMISSION_DENIED",
    `Write path escapes allowed roots (projectRoot, /tmp, /private/tmp, /var/folders): ${rawPath}`,
  );
}

/** Resolve existing symlinks within projectRoot, including the existing parent of a new file. */
export function normPath(
  projectRoot: string, path: string, options: { allowSpill?: boolean } = {},
): string {
  const lexicalRoot = resolve(projectRoot);
  const root = realpathSync(lexicalRoot);
  const candidate = resolve(lexicalRoot, path);
  if (!inside(lexicalRoot, candidate) && !inside(root, candidate)) {
    throw new HydrogenError("PERMISSION_DENIED", "Path escapes the project root");
  }
  const normalized = resolveWithSymlinks(candidate);
  if (!inside(root, normalized)) {
    throw new HydrogenError("PERMISSION_DENIED", "Symlink escapes the project root");
  }
  for (const [base, target] of [[lexicalRoot, candidate], [root, normalized]]) {
    const privateRoot = join(base, ".hydrogen");
    const allowedPrivate = options.allowSpill && (
      inside(join(privateRoot, "spill"), target) ||
      inside(join(privateRoot, "shadow"), target)
    );
    if (inside(privateRoot, target) && !allowedPrivate) {
      throw new HydrogenError("PERMISSION_DENIED", "Only explicit reads of .hydrogen/spill or .hydrogen/shadow are allowed");
    }
  }
  return normalized;
}

export function readSnapshot(sessionId: string, absPath: string): {
  record: ObservedFileRecord; text: string; mode: number;
} {
  const fd = openSync(absPath, "r");
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new HydrogenError("INVALID_INPUT", "Expected a regular file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size) {
      throw new HydrogenError("OBSERVATION_STALE", "File changed while being read");
    }
    return {
      record: { sessionId, path: absPath, dev: Number(after.dev), ino: Number(after.ino),
        size: Number(after.size), mtimeNs: after.mtimeNs.toString(),
        sha256: createHash("sha256").update(bytes).digest("hex"), observedAt: Date.now() },
      text: bytes.toString("utf8"), mode: Number(after.mode),
    };
  } finally { closeSync(fd); }
}

export function recordReadObservation(
  state: StateStore, sessionId: string, absPath: string,
): ObservedFileRecord {
  const path = resolveReadPath(state.projectRoot, absPath);
  const { record } = readSnapshot(sessionId, path);
  state.putObservation(record);
  return record;
}

export function sameObservation(a: ObservedFileRecord, b: ObservedFileRecord): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.sha256 === b.sha256;
}

export function requireObservation(state: StateStore, sessionId: string, path: string) {
  const observed = state.getObservation(sessionId, path);
  if (!observed) {
    throw new HydrogenError("OBSERVATION_REQUIRED", "Read the file before editing or deleting it");
  }
  let current: ReturnType<typeof readSnapshot>;
  try { current = readSnapshot(sessionId, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HydrogenError("OBSERVATION_STALE", "The observed file no longer exists");
    }
    throw error;
  }
  if (!sameObservation(observed, current.record)) {
    throw new HydrogenError("OBSERVATION_STALE", "File version changed; read it again before editing");
  }
  return current;
}

const fileLocks = new Map<string, Promise<void>>();

/** Per-file FIFO mutex so concurrent patches on different files execute in parallel. */
export function withFileLock<T>(absPath: string, fn: () => T | Promise<T>): Promise<T> {
  const key = resolve(absPath);
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const result = previous.then(fn);
  const tail = result.then(() => {}, () => {});
  fileLocks.set(key, tail);
  void tail.then(() => { if (fileLocks.get(key) === tail) fileLocks.delete(key); });
  return result;
}

export function withProjectLock<T>(projectRoot: string, fn: () => T | Promise<T>): Promise<T> {
  let key: string;
  try { key = realpathSync(projectRoot); }
  catch { key = resolve(projectRoot); }
  return withFileLock(key, fn);
}

function runRg(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolveRg, reject) => {
    const command = process.platform === "darwin" && existsSync("/opt/homebrew/bin/rg") ? "/opt/homebrew/bin/rg" : "rg";
    const child = spawn(command, ["--no-config", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0 || code === 1) {
        resolveRg({ stdout: Buffer.concat(stdout).toString("utf8"), exitCode: code });
      } else {
        reject(new HydrogenError("INVALID_INPUT", Buffer.concat(stderr).toString("utf8") || `rg exited with ${code}`));
      }
    });
  });
}

function globToRegExp(globPattern: string): RegExp {
  const norm = globPattern.replace(/\\/g, "/");
  let re = "^";
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        if (norm[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\.^$+{}()|[]".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`${re}$`, process.platform === "win32" ? "i" : "");
}

function walkFilesFallback(baseDir: string, includeHydrogen: boolean, maxFiles = 20_000): string[] {
  const results: string[] = [];
  const stack = [baseDir];
  while (stack.length > 0 && results.length < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (!includeHydrogen && entry.name === ".hydrogen") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        results.push(full);
        if (results.length >= maxFiles) break;
      }
    }
  }
  return results;
}

function searchTarget(projectRoot: string, path?: string): {
  cwd: string; rgTarget: string; realRoot: string; absTarget: string; spillOrShadow: boolean; args: string[];
} {
  const realRoot = realpathSync(resolve(projectRoot));
  const target = path !== undefined ? resolveReadPath(projectRoot, path) : realRoot;
  const inProject = inside(realRoot, target);
  const spillOrShadow = inProject && (
    inside(join(realRoot, ".hydrogen", "spill"), target) ||
    inside(join(realRoot, ".hydrogen", "shadow"), target)
  );
  const args = ["--hidden", "--glob", "!.git/**", ...(spillOrShadow ? [] : ["--glob", "!.hydrogen/**"])];
  return {
    cwd: realRoot,
    rgTarget: inProject ? (relative(realRoot, target) || ".") : target,
    realRoot,
    absTarget: target,
    spillOrShadow,
    args,
  };
}

export async function fsGlob(projectRoot: string, input: FsGlobInput): Promise<string[]> {
  const limit = input.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new HydrogenError("INVALID_INPUT", "limit must be nonnegative");
  const target = searchTarget(projectRoot, input.path);
  let rawPaths: string[] = [];
  try {
    const { stdout } = await runRg(
      target.cwd,
      ["--files", "--null", "--glob", input.pattern, ...target.args, "--", target.rgTarget],
    );
    rawPaths = stdout.split("\0").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const matcher = globToRegExp(input.pattern.includes("/") || input.pattern.includes("\\") ? input.pattern : `**/${input.pattern}`);
    const base = statSync(target.absTarget).isFile() ? [target.absTarget] : walkFilesFallback(target.absTarget, target.spillOrShadow);
    rawPaths = base.filter(abs => {
      const rel = relative(target.absTarget, abs).replace(/\\/g, "/");
      return matcher.test(rel || basename(abs));
    });
  }
  const files: Array<{ path: string; mtime: bigint }> = [];
  for (const raw of rawPaths) {
    const absPath = isAbsolute(raw) ? raw : resolve(target.cwd, raw);
    const displayPath = inside(target.realRoot, absPath) ? relative(target.realRoot, absPath) : absPath;
    try {
      files.push({ path: displayPath, mtime: statSync(absPath, { bigint: true }).mtimeNs });
    } catch {
      /* Ignore transient or broken symlinks during globbing. */
    }
  }
  files.sort((a, b) => a.mtime === b.mtime ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    : a.mtime > b.mtime ? -1 : 1);
  return files.slice(0, limit).map(file => file.path);
}

export async function fsGrep(
  projectRoot: string, outputSpill: OutputSpill, input: FsGrepInput,
): Promise<SpillResult & { output: string; exitCode: number }> {
  const target = searchTarget(projectRoot, input.path);
  const args = ["--color", "never", "--with-filename"];
  if (input.mode === "files") args.push("--files-with-matches");
  else if (input.mode === "count") args.push("--count");
  else {
    args.push("--line-number");
    if (input.context !== undefined) {
      if (!Number.isSafeInteger(input.context) || input.context < 0) {
        throw new HydrogenError("INVALID_INPUT", "context must be nonnegative");
      }
      args.push("--context", String(input.context));
    }
  }
  if (input.glob !== undefined) args.push("--glob", input.glob);
  if (input.limit !== undefined) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new HydrogenError("INVALID_INPUT", "limit must be positive");
    }
    args.push("--max-count", String(input.limit));
  }
  args.push(...target.args, "--regexp", input.pattern, "--", target.rgTarget);
  let stdout = "";
  let exitCode = 1;
  try {
    ({ stdout, exitCode } = await runRg(target.cwd, args));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const regex = new RegExp(input.pattern);
    const globMatcher = input.glob
      ? globToRegExp(input.glob.includes("/") || input.glob.includes("\\") ? input.glob : `**/${input.glob}`)
      : undefined;
    const candidates = statSync(target.absTarget).isFile()
      ? [target.absTarget]
      : walkFilesFallback(target.absTarget, target.spillOrShadow);
    const outLines: string[] = [];
    for (const absPath of candidates) {
      const displayPath = inside(target.realRoot, absPath) ? relative(target.realRoot, absPath) : absPath;
      if (globMatcher && !globMatcher.test(displayPath.replace(/\\/g, "/"))) continue;
      let text: string;
      try {
        const buf = readFileSync(absPath);
        if (buf.includes(0)) continue;
        text = buf.toString("utf8");
      } catch { continue; }
      const lines = text.split(/\r?\n/);
      let fileMatches = 0;
      for (let idx = 0; idx < lines.length; idx++) {
        if (!regex.test(lines[idx])) continue;
        fileMatches++;
        if (input.mode === "content" || input.mode === undefined) {
          outLines.push(`${displayPath}:${idx + 1}:${lines[idx]}`);
        }
        if (input.limit !== undefined && fileMatches >= input.limit) break;
      }
      if (fileMatches > 0) {
        exitCode = 0;
        if (input.mode === "files") outLines.push(displayPath);
        else if (input.mode === "count") outLines.push(`${displayPath}:${fileMatches}`);
      }
    }
    stdout = outLines.length > 0 ? outLines.join("\n") + "\n" : "";
  }
  const spill = outputSpill("grep", stdout, LIMITS.TOOL_INLINE_BYTES, {
    kind: "grep",
    exitCode,
    commandOrPath: `${input.pattern} @ ${target.rgTarget}`,
  });
  return { ...spill, output: spill.inlineText, exitCode };
}

function atomicReplace(path: string, content: string, mode: number): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", mode & 0o777);
  let renamed = false;
  try {
    try { writeFileSync(fd, content, "utf8"); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    renamed = true;
  } finally { if (!renamed) unlinkSync(temporary); }
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function countTotalLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function normalizeLfWithMap(input: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "\r" && input[i + 1] === "\n") {
      norm += "\n";
      map.push(i);
      i++;
    } else {
      norm += input[i];
      map.push(i);
    }
  }
  map.push(input.length);
  return { norm, map };
}

interface MatchCandidate {
  rawStart: number;
  rawEnd: number;
  normalized: boolean;
}

function findMatchesInSlice(slice: string, sliceOffset: number, oldText: string): MatchCandidate[] {
  const exact: MatchCandidate[] = [];
  let pos = 0;
  while (pos <= slice.length) {
    const idx = slice.indexOf(oldText, pos);
    if (idx === -1) break;
    exact.push({ rawStart: sliceOffset + idx, rawEnd: sliceOffset + idx + oldText.length, normalized: false });
    pos = idx + Math.max(1, oldText.length);
  }
  if (exact.length > 0) return exact;

  const normOld = oldText.replace(/\r\n/g, "\n");
  if (!normOld) return [];
  const { norm, map } = normalizeLfWithMap(slice);
  const normMatches: MatchCandidate[] = [];
  pos = 0;
  while (pos <= norm.length) {
    const idx = norm.indexOf(normOld, pos);
    if (idx === -1) break;
    normMatches.push({
      rawStart: sliceOffset + map[idx],
      rawEnd: sliceOffset + map[idx + normOld.length],
      normalized: true,
    });
    pos = idx + Math.max(1, normOld.length);
  }
  return normMatches;
}

function adaptReplacement(newText: string, rawMatched: string, oldText: string, normalized: boolean): string {
  if (!normalized) return newText;
  if (rawMatched.includes("\r\n") && !newText.includes("\r\n")) {
    return newText.replace(/\n/g, "\r\n");
  }
  if (!rawMatched.includes("\r\n") && oldText.includes("\r\n")) {
    return newText.replace(/\r\n/g, "\n");
  }
  return newText;
}

function findNearLines(text: string, oldText: string): number[] {
  const firstLine = oldText.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
  if (!firstLine) return [];
  const lines = text.split(/\r?\n/);
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(firstLine)) {
      matches.push(i + 1);
      if (matches.length >= 10) break;
    }
  }
  return matches;
}

export async function fsPatch(
  projectRoot: string, state: StateStore, sessionId: string, input: FsPatchInput,
): Promise<{ path: string; op: FsPatchInput["op"]; sha256?: string; observation?: ObservedFileRecord }> {
  const path = resolveWritePath(projectRoot, input.path);
  return withFileLock(path, () => state.transaction(() => {
    state.assertWriteLease(sessionId);

    if (input.op === "write" || input.op === "create") {
      if (input.content === undefined) {
        throw new HydrogenError("INVALID_INPUT", `${input.op} requires content`);
      }
      mkdirSync(dirname(path), { recursive: true });
      let mode = 0o644;
      try { mode = statSync(path).mode; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      atomicReplace(path, input.content, mode);
      const observation = recordReadObservation(state, sessionId, path);
      return { path, op: input.op, sha256: observation.sha256, observation };
    }

    if (input.op === "delete") {
      requireObservation(state, sessionId, path);
      unlinkSync(path);
      state.deleteObservation(sessionId, path);
      return { path, op: input.op };
    }

    if (input.op !== "patch") {
      throw new HydrogenError("INVALID_INPUT", "Unknown file operation");
    }

    if (!input.hunks?.length) throw new HydrogenError("MATCH_ERROR", "patch requires at least one hunk");

    const observed = state.getObservation(sessionId, path);
    let current: ReturnType<typeof readSnapshot>;
    try {
      current = readSnapshot(sessionId, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (observed) throw new HydrogenError("OBSERVATION_STALE", "The observed file no longer exists");
        throw new HydrogenError("INVALID_INPUT", `File does not exist: ${path}`);
      }
      throw error;
    }

    const shaMismatch = Boolean(observed && observed.sha256 !== current.record.sha256);
    let text = current.text;

    for (let idx = 0; idx < input.hunks.length; idx++) {
      const hunk = input.hunks[idx];
      if (!hunk.oldText || hunk.oldText.length === 0) {
        throw new HydrogenError("MATCH_ERROR", `MATCH_ERROR: Hunk #${idx + 1} oldText must not be empty.`);
      }

      const startLine = hunk.startLine ?? input.startLine;
      const endLine = hunk.endLine ?? input.endLine;
      if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
        throw new HydrogenError("INVALID_INPUT", "Invalid startLine");
      }
      if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < (startLine ?? 1))) {
        throw new HydrogenError("INVALID_INPUT", "Invalid endLine");
      }

      let matches: MatchCandidate[] = [];
      if (startLine !== undefined || endLine !== undefined) {
        const offsets = lineOffsets(text);
        const rangeStart = startLine !== undefined ? (offsets[startLine - 1] ?? text.length) : 0;
        const rangeEnd = endLine !== undefined ? (endLine < offsets.length ? offsets[endLine] : text.length) : text.length;
        const slice = text.slice(rangeStart, rangeEnd);
        matches = findMatchesInSlice(slice, rangeStart, hunk.oldText);
        if (matches.length === 0) {
          matches = findMatchesInSlice(text, 0, hunk.oldText);
        }
      } else {
        matches = findMatchesInSlice(text, 0, hunk.oldText);
      }

      if (matches.length === 0) {
        const totalLines = countTotalLines(text);
        const nearLines = findNearLines(text, hunk.oldText);
        const msg = `MATCH_ERROR: Hunk #${idx + 1} oldText matched 0 times in ${path} (total ${totalLines} lines).${
          nearLines.length ? ` First line appears near line(s): ${nearLines.join(", ")}.` : ""
        } Re-read target lines with fs_read to check exact whitespace.`;
        throw new HydrogenError(shaMismatch ? "OBSERVATION_STALE" : "MATCH_ERROR", msg);
      }

      if (matches.length > 1) {
        const matchLines = matches.map(m => lineNumberAt(text, m.rawStart));
        const msg = `MATCH_ERROR: Hunk #${idx + 1} oldText matched ${matches.length} times at lines [${matchLines.join(", ")}] in ${path}. Include more surrounding context lines or specify startLine/endLine.`;
        throw new HydrogenError(shaMismatch ? "OBSERVATION_STALE" : "MATCH_ERROR", msg);
      }

      const match = matches[0];
      const rawMatched = text.slice(match.rawStart, match.rawEnd);
      const replacement = adaptReplacement(hunk.newText, rawMatched, hunk.oldText, match.normalized);
      text = text.slice(0, match.rawStart) + replacement + text.slice(match.rawEnd);
    }

    atomicReplace(path, text, current.mode);
    const observation = recordReadObservation(state, sessionId, path);
    return { path, op: input.op, sha256: observation.sha256, observation };
  }));
}

export async function fsRead(
  projectRoot: string, state: StateStore, sessionId: string, outputSpill: OutputSpill, input: FsReadInput,
) {
  const absPath = resolveReadPath(projectRoot, input.path);
  const snapshot = readSnapshot(sessionId, absPath);
  state.putObservation(snapshot.record);

  const realRoot = realpathSync(resolve(projectRoot));
  const displayPath = inside(realRoot, absPath) ? relative(realRoot, absPath) : absPath;

  const startLine = input.startLine ?? 1;
  const endLine = input.endLine ?? startLine + 799;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new HydrogenError("INVALID_INPUT", "Invalid line range");
  }

  if (snapshot.text.length === 0) {
    return {
      path: displayPath,
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      content: "",
      inlineText: "",
      truncated: false,
      totalBytes: 0,
      sha256: snapshot.record.sha256,
    };
  }

  const lines = snapshot.text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const actualEnd = Math.min(endLine, lines.length);
  const slice = lines.slice(startLine - 1, actualEnd).map((line, index) => `${startLine + index}|${line}`).join("\n");
  const spill = await outputSpill("read", slice, LIMITS.TOOL_INLINE_BYTES, {
    sessionId,
    kind: "read",
    commandOrPath: displayPath,
  });

  return {
    path: displayPath,
    startLine,
    endLine: actualEnd,
    totalLines: lines.length,
    content: spill.inlineText,
    ...spill,
    sha256: snapshot.record.sha256,
  };
}
