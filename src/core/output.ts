import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { LIMITS, type SpillOptions, type SpillResult } from "./protocol.js";

const ROTATION_CHECK_INTERVAL_MS = 60_000;
const RECENT_FILE_PROTECT_MS = 5 * 60_000;
const MAX_LINE_PREVIEW_CHARS = 240;
const MAX_SUCCESS_TAIL_LINES = 15;
const MAX_MIDDLE_DIAG_LINES = 35;

const MIDDLE_FAILURE_RE =
  /(?:^!\s+.+|^l\.\d+(?:\s+.*)?|\b(?:Undefined control sequence|Emergency stop|Missing \$ inserted|Runaway argument|Fatal error occurred|Error|Exception|Traceback|FAILED|FATAL|panic|AssertionError|SyntaxError|TypeError|ReferenceError|Cannot find|undefined reference|Segmentation fault)\b|error\[E\d+\]|^\s*at\s+\S+|ERR!|exit[_ ]?code[:=]\s*[1-9])/im;

let lastRotationCheckMs = 0;

export interface ShadowMetaRecord {
  sha256: string;
  bytes: number;
  lines: number;
  label: string;
  kind: NonNullable<SpillOptions["kind"]> | "cut";
  isError: boolean;
  exitCode: number | null;
  commandOrPath?: string;
  callId?: string;
  createdAt: number;
}

function headUtf8End(bytes: Buffer, budget: number): number {
  let end = Math.min(Math.max(0, budget), bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}

function tailUtf8Start(bytes: Buffer, budget: number): number {
  let start = Math.max(0, bytes.length - Math.max(0, budget));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return start;
}

function head(bytes: Buffer, budget: number): string {
  return bytes.subarray(0, headUtf8End(bytes, budget)).toString("utf8");
}

function shortenLine(line: string, maxChars = MAX_LINE_PREVIEW_CHARS): string {
  const clean = line.replace(/\r$/, "");
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 3)}...` : clean;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function writeFileAtomic(targetPath: string, data: Buffer | string): void {
  const tempPath = `${targetPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, data, { mode: 0o600 });
    renameSync(tempPath, targetPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* Ignore cleanup error. */ }
    throw error;
  }
}

export function ensurePrivateShadowDir(projectRoot: string): string {
  const shadowDir = join(projectRoot, ".hydrogen", "shadow");
  mkdirSync(shadowDir, { recursive: true, mode: 0o700 });
  return shadowDir;
}

export function saveShadowBlob(
  projectRoot: string,
  options: {
    prefix?: "raw" | "cut";
    idHint?: string;
    label: string;
    bytes: Buffer;
    totalLines: number;
    kind: ShadowMetaRecord["kind"];
    isError?: boolean;
    exitCode?: number | null;
    commandOrPath?: string;
    callId?: string;
    protectedRefs?: Iterable<string>;
  },
): { outputRef: string; metaRef: string; sha256: string; totalBytes: number } {
  const shadowDir = ensurePrivateShadowDir(projectRoot);
  const totalBytes = options.bytes.length;
  const sha256 = createHash("sha256").update(options.bytes).digest("hex");
  const prefix = options.prefix ?? "raw";
  const stem = options.idHint
    ? `${prefix}-${options.idHint.replace(/[^a-zA-Z0-9._-]/g, "_")}-${sha256.slice(0, 12)}`
    : `${prefix}-${sha256.slice(0, 16)}`;
  const outputRef = join(shadowDir, `${stem}.log`);
  const metaRef = join(shadowDir, `${stem}.meta.json`);

  const meta: ShadowMetaRecord = {
    sha256,
    bytes: totalBytes,
    lines: options.totalLines,
    label: options.label,
    kind: options.kind,
    isError: Boolean(options.isError),
    exitCode: options.exitCode ?? null,
    commandOrPath: options.commandOrPath,
    callId: options.callId,
    createdAt: Date.now(),
  };

  let reused = false;
  try {
    const existing = statSync(outputRef);
    if (existing.isFile() && existing.size === totalBytes) {
      reused = true;
      const now = new Date();
      try { utimesSync(outputRef, now, now); } catch { /* Ignore mtime update error. */ }
      try {
        if (existsSync(metaRef)) utimesSync(metaRef, now, now);
        else writeFileAtomic(metaRef, JSON.stringify(meta));
      } catch { /* Ignore metadata refresh error. */ }
    }
  } catch {
    /* File does not exist yet. */
  }

  if (!reused) {
    writeFileAtomic(outputRef, options.bytes);
    writeFileAtomic(metaRef, JSON.stringify(meta));
  }

  const verified = statSync(outputRef);
  if (!verified.isFile() || verified.size !== totalBytes) {
    throw new Error(`Shadow backup verification failed for ${outputRef}`);
  }

  const protectedRefs = new Set<string>([outputRef]);
  if (options.protectedRefs) {
    for (const ref of options.protectedRefs) protectedRefs.add(ref);
  }
  rotateShadowIfNeeded(shadowDir, protectedRefs);

  return { outputRef, metaRef, sha256, totalBytes };
}

export function rotateShadowIfNeeded(
  shadowDir: string,
  protectedRefs?: Iterable<string>,
): void {
  const now = Date.now();
  if (now - lastRotationCheckMs < ROTATION_CHECK_INTERVAL_MS) return;
  lastRotationCheckMs = now;

  let entries: string[];
  try {
    entries = readdirSync(shadowDir);
  } catch {
    return;
  }

  const protectedSet = new Set<string>();
  if (protectedRefs) {
    for (const ref of protectedRefs) {
      if (ref) protectedSet.add(resolve(ref));
    }
  }

  let totalBytes = 0;
  const candidates: Array<{
    logPath: string;
    metaPath: string;
    logSize: number;
    metaSize: number;
    mtimeMs: number;
  }> = [];

  const fileStats = new Map<string, { size: number; mtimeMs: number }>();
  for (const name of entries) {
    if ((!name.startsWith("raw-") && !name.startsWith("cut-")) || (!name.endsWith(".log") && !name.endsWith(".meta.json"))) continue;
    const fullPath = join(shadowDir, name);
    try {
      const info = statSync(fullPath);
      if (!info.isFile()) continue;
      totalBytes += info.size;
      fileStats.set(name, { size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      /* Ignore transient ENOENT. */
    }
  }

  if (totalBytes <= LIMITS.MAX_SHADOW_BYTES) return;

  for (const [name, logInfo] of fileStats.entries()) {
    if (!name.endsWith(".log")) continue;
    const logPath = join(shadowDir, name);
    const metaName = name.replace(/\.log$/, ".meta.json");
    const metaPath = join(shadowDir, metaName);
    const metaInfo = fileStats.get(metaName);

    if (protectedSet.has(resolve(logPath)) || protectedSet.has(resolve(metaPath))) continue;
    if (now - logInfo.mtimeMs < RECENT_FILE_PROTECT_MS) continue;

    candidates.push({
      logPath,
      metaPath,
      logSize: logInfo.size,
      metaSize: metaInfo?.size ?? 0,
      mtimeMs: logInfo.mtimeMs,
    });
  }

  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const targetBytes = Math.floor(LIMITS.MAX_SHADOW_BYTES * 0.85);

  for (const candidate of candidates) {
    if (totalBytes <= targetBytes) break;
    try {
      unlinkSync(candidate.logPath);
      totalBytes -= candidate.logSize;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    if (candidate.metaSize > 0) {
      try {
        unlinkSync(candidate.metaPath);
        totalBytes -= candidate.metaSize;
      } catch {
        /* Ignore missing meta file. */
      }
    }
  }
}

function extractMiddleFailureDiagnostics(
  middleBytes: Buffer,
  charBudget: number,
  byteBudget: number,
): string[] {
  if (middleBytes.length === 0 || charBudget <= 0 || byteBudget <= 0) return [];
  const lines = middleBytes.toString("utf8").split(/\r?\n/);
  const pickedIndices = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (!MIDDLE_FAILURE_RE.test(lines[i])) continue;
    if (i > 0) pickedIndices.add(i - 1);
    pickedIndices.add(i);
    if (i + 1 < lines.length) pickedIndices.add(i + 1);
    if (i + 2 < lines.length) pickedIndices.add(i + 2);
  }

  if (pickedIndices.size === 0) return [];

  const sortedIndices = [...pickedIndices].sort((a, b) => a - b);
  const result: string[] = [];
  let usedChars = 0;
  let usedBytes = 0;

  for (const idx of sortedIndices) {
    if (result.length >= MAX_MIDDLE_DIAG_LINES) break;
    const rawLine = lines[idx];
    if (rawLine.trim().length === 0) continue;
    const line = shortenLine(rawLine);
    const sepChars = result.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, "utf8") + sepChars;
    if (usedChars + line.length + sepChars > charBudget) break;
    if (usedBytes + lineBytes > byteBudget) break;
    result.push(line);
    usedChars += line.length + sepChars;
    usedBytes += lineBytes;
  }

  return result;
}

function buildSuccessBashCard(
  text: string,
  totalBytes: number,
  totalLines: number,
  outputRef: string,
): string {
  const nonEmptyLines = text
    .split(/\r?\n/)
    .map(line => line.replace(/\r$/, ""))
    .filter(line => line.trim().length > 0);
  const kept = nonEmptyLines.slice(-MAX_SUCCESS_TAIL_LINES).map(line => shortenLine(line));

  return [
    `[spine-folded: exit 0 | ${totalBytes} bytes (${totalLines} lines) -> ${outputRef}]`,
    `--- Tail excerpt (last ${kept.length} non-empty lines) ---`,
    ...kept,
    `[Full output saved to ${outputRef}; use fs_grep or fs_read with startLine/endLine to inspect specific sections]`,
  ].join("\n");
}

export function spillOutput(
  projectRoot: string,
  label: string,
  text: string,
  maxBytes: number,
  options?: SpillOptions,
): SpillResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a nonnegative integer");
  }

  const bytes = Buffer.from(text, "utf8");
  const totalBytes = bytes.length;
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const isSuccessBash =
    options?.kind === "bash" &&
    !options?.isError &&
    (options?.exitCode === 0 || options?.exitCode === null || options?.exitCode === undefined);

  const effectiveMax = isSuccessBash
    ? Math.min(maxBytes, LIMITS.SPINE_SUCCESS_FOLD_BYTES)
    : maxBytes;

  if (totalBytes <= effectiveMax) {
    return { inlineText: text, truncated: false, totalBytes, sha256 };
  }

  const totalLines = countLines(text);
  const { outputRef } = saveShadowBlob(projectRoot, {
    prefix: "raw",
    label,
    bytes,
    totalLines,
    kind: options?.kind ?? "other",
    isError: options?.isError,
    exitCode: options?.exitCode,
    commandOrPath: options?.commandOrPath,
    protectedRefs: options?.protectedRefs,
  });

  if (isSuccessBash) {
    const card = buildSuccessBashCard(text, totalBytes, totalLines, outputRef);
    const inlineText = Buffer.byteLength(card, "utf8") > maxBytes
      ? head(Buffer.from(card, "utf8"), maxBytes)
      : card;
    return { inlineText, truncated: true, totalBytes, outputRef, sha256 };
  }

  const notice = `\n[output truncated: ${totalBytes} bytes, ${totalLines} lines; outputRef: ${outputRef}]\n`;
  const noticeBytes = Buffer.byteLength(notice, "utf8");
  if (noticeBytes > maxBytes) {
    return {
      inlineText: head(Buffer.from(notice, "utf8"), maxBytes),
      truncated: true,
      totalBytes,
      outputRef,
      sha256,
    };
  }

  const remainingForSides = Math.max(0, maxBytes - noticeBytes);
  let headBudget = Math.floor(maxBytes * 0.3);
  let tailBudget = Math.floor(maxBytes * 0.45);
  if (headBudget + tailBudget > remainingForSides) {
    headBudget = Math.floor(remainingForSides * 0.4);
    tailBudget = remainingForSides - headBudget;
  }

  const headEnd = headUtf8End(bytes, headBudget);
  const tailStart = Math.max(headEnd, tailUtf8Start(bytes, tailBudget));
  const headText = bytes.subarray(0, headEnd).toString("utf8");
  const tailText = bytes.subarray(tailStart).toString("utf8");

  const headUsedBytes = headEnd;
  const tailUsedBytes = bytes.length - tailStart;
  const diagHeaderReserve = 96;
  const diagByteBudget = Math.max(0, maxBytes - headUsedBytes - tailUsedBytes - noticeBytes - diagHeaderReserve);

  const extractDiagnostics = options?.kind === "bash" || options?.kind === "workflow";
  const middleBytes = bytes.subarray(headEnd, tailStart);
  const diagLines = extractDiagnostics
    ? extractMiddleFailureDiagnostics(
        middleBytes,
        LIMITS.SPINE_TOOL_BUDGET_CHARS,
        diagByteBudget,
      )
    : [];

  const diagSection = diagLines.length > 0
    ? `\n--- [Middle Failure Diagnostics Extracted (${diagLines.length} lines)] ---\n${diagLines.join("\n")}\n`
    : "";

  const inlineText = headText + diagSection + notice + tailText;
  return { inlineText, truncated: true, totalBytes, outputRef, sha256 };
}

export type OutputSpill = (
  label: string,
  text: string,
  maxBytes: number,
  options?: SpillOptions,
) => SpillResult;
