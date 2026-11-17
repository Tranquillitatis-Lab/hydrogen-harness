import { useState } from "react";
import { CheckCircle2, ChevronRight, Circle, ExternalLink, LoaderCircle, Wrench, XCircle } from "lucide-react";
import { api, reportError } from "../store";
import type { FileContent, TimelineToolEntry } from "../types";
import { ArtifactModal } from "./ArtifactModal";

function outputRefs(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(/\.hydrogen\/spill\/[a-zA-Z0-9_.-]+/g)].map(match => match[0]);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => key === "outputRef" && typeof child === "string" ? [child] : outputRefs(child));
}
export function ToolCallCard({ tool }: { tool: TimelineToolEntry }) {
  const [open, setOpen] = useState(false);
  const [artifact, setArtifact] = useState<FileContent | null>(null);
  const failed = /fail|error|denied/.test(tool.status);
  const done = /complete|success|done/.test(tool.status);
  const running = /running|progress|pending/.test(tool.status);
  const Icon = failed ? XCircle : done ? CheckCircle2 : running ? LoaderCircle : Circle;
  const args = tool.rawInput === undefined ? "" : JSON.stringify(tool.rawInput);
  async function inspect(path: string) {
    try { setArtifact(await api<FileContent>(`artifact?path=${encodeURIComponent(path)}`)); }
    catch (error) { reportError(error); }
  }
  return <div className={`tool-card ${failed ? "failed" : ""}`}>
    <button className="tool-heading" onClick={() => setOpen(!open)} aria-expanded={open}><ChevronRight size={13} className={open ? "expanded" : ""} /><Icon size={14} className={`${running ? "spin" : ""} ${failed ? "error-text" : done ? "success-text" : "muted"}`} /><Wrench size={12} className="muted" /><strong>{tool.name.replace(/^mcp__hydrogen__/, "")}</strong><span className="args-preview mono">{args}</span><span className="tool-status">{tool.status}</span></button>
    {open && <div className="tool-details"><div className="eyebrow">INPUT</div><pre>{JSON.stringify(tool.rawInput, null, 2) ?? "No input"}</pre>{tool.rawOutput !== undefined && <><div className="eyebrow">OUTPUT</div><pre>{typeof tool.rawOutput === "string" ? tool.rawOutput : JSON.stringify(tool.rawOutput, null, 2)}</pre></>}</div>}
    {[...new Set(outputRefs(tool.rawOutput))].map(path => <button key={path} className="artifact-link" onClick={() => void inspect(path)}><ExternalLink size={12} />View full output<span className="mono">{path.split("/").at(-1)}</span></button>)}
    {artifact && <ArtifactModal artifact={artifact} onClose={() => setArtifact(null)} />}
  </div>;
}
