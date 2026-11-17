import { useState } from "react";
import { ArrowUpRight, ChevronDown, GitBranch, MessageSquare, Pencil, Plus, Terminal, Trash2, X } from "lucide-react";
import { act, useStudio } from "../store";
import type { Snapshot } from "../types";

export function Sidebar({ snapshot, onCompose, onClose }: { snapshot: Snapshot; onCompose: (text: string) => void; onClose: () => void }) {
  const { models } = useStudio();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const blocked = snapshot.busy || snapshot.rotating;
  return <div className="sidebar">
    <div className="sidebar-brand"><div className="brand-mark small">H<span>₂</span></div><div><strong>Hydrogen</strong><span>ENGINEERING STUDIO</span></div><button className="icon-button close-mobile" aria-label="Close sidebar" onClick={onClose}><X size={16} /></button></div>
    <div className="workspace-label"><span className="workspace-icon">{snapshot.projectRoot.split("/").filter(Boolean).at(-1)?.slice(0, 1).toUpperCase()}</span><span>{snapshot.projectRoot.split("/").filter(Boolean).at(-1)}</span><ChevronDown size={13} /></div>
    <button className="new-thread" disabled={blocked} onClick={() => void act("new")}><Plus size={16} />New thread<span className="keycap">+</span></button>
    <div className="sidebar-scroll"><div className="section-label">THREADS <span>{snapshot.threads.length}</span></div>
      <nav className="thread-list" aria-label="Threads">{snapshot.threads.map(thread => <div key={thread.threadId} className={`thread ${thread.threadId === snapshot.activeThreadId ? "active" : ""}`}>
        {renaming === thread.threadId ? <form onSubmit={event => { event.preventDefault(); if (title.trim()) void act("thread", { action: "rename", threadId: thread.threadId, title }); setRenaming(null); }}><input autoFocus value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setRenaming(null); }} aria-label="Thread title" /><button aria-label="Save thread title">↵</button></form> : <><button className="thread-main" disabled={blocked} onClick={() => void act("thread", { action: "switch", threadId: thread.threadId })}><MessageSquare size={14} /><span>{thread.title}</span></button>
          <button className="thread-action" disabled={blocked} title="Rename thread" aria-label={`Rename ${thread.title}`} onClick={() => { setTitle(thread.title); setRenaming(thread.threadId); }}><Pencil size={12} /></button><button className="thread-action delete" disabled={blocked} title="Delete thread" aria-label={`Delete ${thread.title}`} onClick={() => void act("thread", { action: "delete", threadId: thread.threadId })}><Trash2 size={12} /></button></>}
      </div>)}</nav>
      <div className="section-label epoch-label">WRITER EPOCHS <span>{snapshot.sessions.filter(session => session.role === "writer").length}</span></div>
      <div className="epoch-list">{snapshot.sessions.filter(session => session.role === "writer").slice().reverse().map(session => <div key={session.sessionId} className="epoch-row"><span className={`epoch-dot ${session.sessionId === snapshot.writerSessionId ? "current" : ""}`} /><div><span>Epoch {session.epoch}</span><small className="mono">{session.sessionId.slice(0, 8)}</small></div><span className="muted">{session.sessionId === snapshot.writerSessionId ? "active" : session.status}</span></div>)}</div>
      <div className="section-label">QUICK COMMANDS</div><div className="quick-commands">{["status", "diff", "todos", "agents", "help"].map(command => <button key={command} onClick={() => onCompose(`/${command}`)}>/{command}<ArrowUpRight size={11} /></button>)}</div>
    </div>
    <div className="sidebar-settings"><label className="section-label" htmlFor="model">MODEL</label><select id="model" value={snapshot.model} disabled={blocked} onChange={event => void act("settings", { model: event.target.value })}>
      {!models.some(model => model.id === snapshot.model) && <option value={snapshot.model}>{snapshot.model}</option>}{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
    </select><div className="row between auto-compact"><span>Auto-compact</span><button className={`switch ${snapshot.autoCompact ? "on" : ""}`} role="switch" aria-checked={snapshot.autoCompact} aria-label="Auto-compact" onClick={() => void act("settings", { autoCompact: !snapshot.autoCompact })}><span /></button></div></div>
    <footer className="workspace-footer"><div><GitBranch size={13} /><span>{snapshot.git.isGitRepo ? snapshot.git.branch : "No Git repository"}</span></div><div title={snapshot.projectRoot}><Terminal size={13} /><span>{snapshot.projectRoot}</span></div><div className="local-label"><i />LOCAL WORKSPACE<span>v1.0</span></div></footer>
  </div>;
}
