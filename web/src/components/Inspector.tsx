import { useEffect, useState } from "react";
import { Activity, Bot, Check, CheckCircle2, Circle, FileCode2, GitBranch, ListTodo, LoaderCircle, RefreshCw, Save, Send, Square, Terminal, X } from "lucide-react";
import { api, reportError } from "../store";
import type { Checkpoint, FileContent, GitSnapshot, Snapshot } from "../types";
import type { PtyJobRecord } from "../../../src/core/state.js";
import { ArtifactModal } from "./ArtifactModal";

type Tab = "context" | "agents" | "terminal" | "git";
const tabs = [{ id: "context", icon: Activity, label: "Context & Plan" }, { id: "agents", icon: Bot, label: "Agents & PTC" }, { id: "terminal", icon: Terminal, label: "Terminal" }, { id: "git", icon: GitBranch, label: "Git & Files" }] as const;
export function Inspector({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("context");
  return <div className="inspector"><header className="inspector-header"><div><span className="eyebrow">WORKSPACE</span><h2>Inspector</h2></div><button className="icon-button" aria-label="Close inspector" onClick={onClose}><X size={17} /></button></header>
    <div className="inspector-tabs" role="tablist">{tabs.map(item => <button key={item.id} id={`tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} title={item.label} onClick={() => setTab(item.id)} className={tab === item.id ? "selected" : ""}><item.icon size={15} /><span>{item.label.split(" & ")[0]}</span></button>)}</div>
    <div className="inspector-content" key={snapshot.activeThreadId} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      {tab === "context" && <ContextPlan snapshot={snapshot} />}{tab === "agents" && <Agents snapshot={snapshot} />}{tab === "terminal" && <TerminalJobs snapshot={snapshot} />}{tab === "git" && <GitFiles />}
    </div>
  </div>;
}
function ContextPlan({ snapshot }: { snapshot: Snapshot }) {
  const stats = snapshot.contextStats;
  return <><section className="inspector-section"><div className="section-heading"><h3>Context window</h3><span className={`badge ${stats.source === "reported" ? "green" : ""}`}>{stats.source}</span></div><div className="context-total mono">{stats.inputTokens.toLocaleString()}<small> / {stats.contextWindow.toLocaleString()}</small></div><div className={`meter large ${stats.level}`}><div style={{ width: `${Math.min(100, stats.usageRatio * 100)}%` }} /><i style={{ left: `${stats.softTokens / stats.contextWindow * 100}%` }} /><i style={{ left: `${stats.hardTokens / stats.contextWindow * 100}%` }} /></div>
      <div className="context-legend"><span><i className="soft-dot" />Soft {(stats.softTokens / 1000).toFixed(0)}k</span><span><i className="hard-dot" />Hard {(stats.hardTokens / 1000).toFixed(0)}k</span></div>
      <dl className="stats-list"><div><dt>Input tokens</dt><dd>{stats.inputTokens.toLocaleString()}</dd></div><div><dt>Output tokens</dt><dd>{snapshot.usage?.outputTokens.toLocaleString() ?? "—"}</dd></div><div><dt>Thinking tokens</dt><dd>{snapshot.usage?.thinkingTokens?.toLocaleString() ?? "—"}</dd></div><div><dt>Cache read</dt><dd>{snapshot.usage?.cacheReadTokens?.toLocaleString() ?? "—"}</dd></div><div><dt>Emergency threshold</dt><dd>{stats.emergencyTokens.toLocaleString()}</dd></div><div><dt>Usage accounting</dt><dd>{snapshot.usage ? snapshot.usage.cumulative ? "Cumulative" : "Per turn" : "No usage yet"}</dd></div></dl>
    </section><section className="inspector-section"><div className="section-heading"><h3><ListTodo size={14} />Active plan</h3><span className="mono muted">{snapshot.todos.filter(todo => todo.status === "completed").length}/{snapshot.todos.length}</span></div>{snapshot.todos.length ? <div className="todo-list">{snapshot.todos.map(todo => <div key={todo.id} className={`todo ${todo.status}`}>{todo.status === "completed" ? <CheckCircle2 size={15} /> : todo.status === "in_progress" ? <LoaderCircle className="spin" size={15} /> : <Circle size={15} />}<span>{todo.content}</span></div>)}</div> : <p className="empty-note">The agent’s plan appears here as it works.</p>}</section><CheckpointEditor checkpoint={snapshot.checkpoint} /></>;
}
function CheckpointEditor({ checkpoint }: { checkpoint: Checkpoint }) {
  const [draft, setDraft] = useState(checkpoint);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (!dirty) setDraft(checkpoint); }, [checkpoint, dirty]);
  function edit(patch: Partial<Checkpoint>) { setDraft({ ...draft, ...patch }); setDirty(true); setSaved(false); }
  async function save() {
    setSaving(true);
    try { const result = await api<{ checkpoint: Checkpoint }>("checkpoint", { activeGoal: draft.activeGoal ?? "", nextImmediateStep: draft.nextImmediateStep ?? "", verifiedFacts: draft.verifiedFacts, deadEndsTried: draft.deadEndsTried }); setDraft(result.checkpoint); setDirty(false); setSaved(true); }
    catch (error) { reportError(error); }
    finally { setSaving(false); }
  }
  return <section className="inspector-section checkpoint"><div className="section-heading"><h3>Semantic checkpoint</h3><span className="badge">{dirty ? "Unsaved" : "Persistent"}</span></div><p className="section-description">The intent and evidence carried across epochs.</p><form onSubmit={event => { event.preventDefault(); void save(); }}>
    <label>Active goal<textarea rows={3} value={draft.activeGoal ?? ""} onChange={event => edit({ activeGoal: event.target.value })} placeholder="What are we working toward?" /></label>
    <label>Next immediate step<textarea rows={2} value={draft.nextImmediateStep ?? ""} onChange={event => edit({ nextImmediateStep: event.target.value })} placeholder="The next concrete action" /></label>
    <label>Verified facts<span className="field-hint">One per line</span><textarea rows={3} value={draft.verifiedFacts.join("\n")} onChange={event => edit({ verifiedFacts: event.target.value.split("\n") })} /></label>
    <label>Dead ends tried<span className="field-hint">One per line</span><textarea rows={2} value={draft.deadEndsTried.join("\n")} onChange={event => edit({ deadEndsTried: event.target.value.split("\n") })} /></label>
    <button className="save-checkpoint" disabled={saving || !dirty}>{saved ? <Check size={14} /> : <Save size={14} />}{saving ? "Saving…" : saved ? "Saved" : "Save checkpoint"}</button>
  </form></section>;
}
function Agents({ snapshot }: { snapshot: Snapshot }) {
  const [artifact, setArtifact] = useState<FileContent | null>(null);
  async function inspect(path: string | null, title: string, text: string) {
    try { setArtifact(path ? await api<FileContent>(`artifact?path=${encodeURIComponent(path)}`) : { path: title, text, truncated: false }); }
    catch (error) { reportError(error); }
  }
  return <><section className="inspector-section"><div className="section-heading"><h3>Subagents</h3><span className="badge">{snapshot.subagents.length}</span></div>{!snapshot.subagents.length && <div className="inspector-empty"><Bot size={28} /><strong>Router-Worker Subagents</strong><p>Explorer, worker, and verifier subagents appear here.</p></div>}{snapshot.subagents.map(agent => <article className="resource-card" key={agent.agentId}><div className="row between"><strong>{agent.taskPath || agent.reuseKey || agent.agentId.slice(0, 8)}</strong><span className={`badge ${agent.status === "running" ? "green" : ""}`}>{agent.status}</span></div><div className="mono muted resource-id">{agent.role} · {agent.model}</div><p>{agent.summary || "Awaiting output…"}</p><button className="text-button" onClick={() => void inspect(agent.outputRef, `Subagent ${agent.taskPath || agent.agentId}`, agent.summary)}>View Full Output →</button></article>)}</section>
    <section className="inspector-section"><div className="section-heading"><h3>PTC workflows</h3><span className="badge">{snapshot.workflows.length}</span></div>{!snapshot.workflows.length && <p className="empty-note">Workflow steps and results appear here.</p>}{snapshot.workflows.map(workflow => <article className="resource-card" key={workflow.runId}><div className="row between"><strong className="mono">{workflow.runId.slice(0, 8)}</strong><span className={`badge ${workflow.status === "running" ? "green" : ""}`}>{workflow.status}</span></div><p>{workflow.summary}</p><details className="workflow-steps"><summary>{workflow.steps.length} steps</summary><pre>{JSON.stringify(workflow.steps, null, 2)}</pre></details><button className="text-button" onClick={() => void inspect(workflow.outputRef, `Workflow ${workflow.runId}`, JSON.stringify({ summary: workflow.summary, steps: workflow.steps }, null, 2))}>View Full Output →</button></article>)}</section>
    {artifact && <ArtifactModal artifact={artifact} onClose={() => setArtifact(null)} />}</>;
}
function TerminalJobs({ snapshot }: { snapshot: Snapshot }) {
  return <section className="inspector-section"><div className="section-heading"><h3>Managed terminals</h3><span className="badge">{snapshot.ptyJobs.filter(job => job.alive).length} alive</span></div>{!snapshot.ptyJobs.length && <div className="inspector-empty"><Terminal size={28} /><strong>Workspace processes</strong><p>Shell jobs, live output, and stdin controls appear here.</p></div>}{snapshot.ptyJobs.map(job => <Job key={job.jobId} job={job} writerId={snapshot.writerSessionId} />)}</section>;
}
function Job({ job, writerId }: { job: PtyJobRecord; writerId?: string }) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [pending, setPending] = useState(false);
  const [ref, setRef] = useState<string>();
  const [artifact, setArtifact] = useState<FileContent | null>(null);
  const owned = job.sessionId === writerId;
  async function execute(action: "poll" | "stdin" | "kill") {
    setPending(true);
    try { const result = await api<{ inlineText: string; outputRef?: string }>("job", { action, jobId: job.jobId, input: action === "stdin" ? input + "\n" : undefined }); setOutput(previous => previous + result.inlineText); if (result.outputRef) setRef(result.outputRef); if (action === "stdin") setInput(""); }
    catch (error) { reportError(error); }
    finally { setPending(false); }
  }
  async function inspect() {
    try { setArtifact(await api<FileContent>(`artifact?path=${encodeURIComponent(ref!)}`)); }
    catch (error) { reportError(error); }
  }
  return <article className="resource-card job-card"><div className="row between"><span className="mono muted">{job.jobId.slice(0, 8)}</span><span className={`badge ${job.alive ? "green" : ""}`}>{job.alive ? "Running" : "Exited"}</span></div><h4 className="mono">$ {job.command}</h4><div className="mono muted job-cwd">{job.cwd}</div><div className="row job-actions"><button disabled={!owned || pending} onClick={() => void execute("poll")}><RefreshCw size={12} className={pending ? "spin" : ""} />Poll</button><button className="danger-ghost" disabled={!owned || !job.alive || pending} onClick={() => void execute("kill")}><Square size={11} />Kill</button></div>{!owned && <p className="empty-note">This job belongs to a previous writer session.</p>}{output && <pre className="terminal-output">{output}</pre>}{ref && <button className="text-button" onClick={() => void inspect()}>View Full Output →</button>}
    <form className="stdin-form" onSubmit={event => { event.preventDefault(); void execute("stdin"); }}><input value={input} onChange={event => setInput(event.target.value)} placeholder="Send input to stdin…" aria-label={`Stdin for ${job.jobId}`} disabled={!owned || !job.alive || pending} /><button aria-label="Send stdin" disabled={!owned || !job.alive || pending}><Send size={13} /></button></form>{artifact && <ArtifactModal artifact={artifact} onClose={() => setArtifact(null)} />}</article>;
}
function GitFiles() {
  const [git, setGit] = useState<GitSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [path, setPath] = useState("");
  const [file, setFile] = useState<FileContent | null>(null);
  const [artifact, setArtifact] = useState<FileContent | null>(null);
  async function refresh() {
    setLoading(true);
    try { setGit(await api<GitSnapshot>("git")); }
    catch (error) { reportError(error); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function preview() {
    try { setFile(await api<FileContent>(`file?path=${encodeURIComponent(path)}`)); }
    catch (error) { reportError(error); }
  }
  return <><section className="inspector-section"><div className="section-heading"><h3><GitBranch size={14} />Git workspace</h3><button className="icon-button" disabled={loading} aria-label="Refresh Git" onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "spin" : ""} /></button></div>{git && (git.isGitRepo ? <><span className="branch-tag"><GitBranch size={12} />{git.branch}</span><pre className="git-status">{git.status || "Working tree clean"}</pre>{git.diffStat && <pre className="diff-stat">{git.diffStat}</pre>}<details className="diff-view" open><summary>Working diff</summary>{git.diff ? <pre>{git.diff.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : ""}>{line}{"\n"}</span>)}</pre> : <p className="empty-note">No unstaged changes.</p>}</details></> : <p className="empty-note">This workspace is not a Git repository.</p>)}</section>
    <section className="inspector-section"><div className="section-heading"><h3><FileCode2 size={14} />File preview</h3></div><form className="file-preview-form" onSubmit={event => { event.preventDefault(); void preview(); }}><input value={path} onChange={event => setPath(event.target.value)} placeholder="src/core/runtime.ts" aria-label="Workspace file path" /><button disabled={!path.trim()}>Open</button></form>{file && <div className="file-preview"><div className="row between"><strong className="mono">{file.path}</strong><button className="text-button" onClick={() => setArtifact(file)}>Expand</button></div>{file.truncated && <p className="empty-note">Preview limited to 256 KB.</p>}<pre>{file.text}</pre></div>}</section>{artifact && <ArtifactModal artifact={artifact} onClose={() => setArtifact(null)} />}</>;
}
