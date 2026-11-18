import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Check, ChevronsDown, Code2, Compass, GitPullRequest, ShieldCheck, Terminal } from "lucide-react";
import { act } from "../store";
import type { Snapshot } from "../types";
import { TurnCard } from "./TurnCard";

export function Timeline({ snapshot, onCompose }: { snapshot: Snapshot; onCompose: (text: string) => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot.timeline, snapshot.pendingPermissions]);
  useEffect(() => {
    following.current = true; setAtBottom(true);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot.activeThreadId]);
  const lastTurn = snapshot.timeline.findLast(item => item.kind === "turn");
  return <div className="timeline-shell"><div ref={scroll} className="timeline-scroll" onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; setAtBottom(following.current); }}>
    <div className={`timeline-content ${snapshot.timeline.length ? "" : "is-empty"}`}>
      {!snapshot.timeline.length && <section className="welcome"><div className="welcome-orbit"><div className="brand-mark">H<span>₂</span></div><i /><b /></div><div className="eyebrow">YOUR WORKSPACE, IN MOTION</div><h1>Make room for<br /><span>your next idea.</span></h1><p>A focused space to explore, build, and iterate.<br />Connected to <strong>{snapshot.projectRoot.split("/").filter(Boolean).at(-1)}</strong>.</p>
        <div className="starter-grid">{[{ icon: Compass, title: "Explore the codebase", text: "Map the architecture and explain how the main components work together." }, { icon: Code2, title: "Build something", text: "Help me implement a feature in this workspace. Start by exploring the project." }, { icon: GitPullRequest, title: "Review recent changes", text: "Review the current Git diff and identify bugs and improvements." }].map(starter => <button key={starter.title} onClick={() => onCompose(starter.text)}><starter.icon size={18} /><strong>{starter.title}</strong><ArrowRight size={14} /></button>)}</div><span className="welcome-hint"><kbd>⌘ K</kbd> to focus · <kbd>/</kbd> commands · <kbd>@</kbd> files</span>
      </section>}
      {snapshot.timeline.map(item => item.kind === "turn" ? <TurnCard key={item.id} turn={item} active={snapshot.busy && lastTurn?.id === item.id} /> : item.kind === "command" ? <article key={item.id} className={`command-card ${item.ok === false ? "failed" : ""}`}><div><Terminal size={14} /><strong className="mono">{item.title ?? item.userText}</strong><span>{item.ok === false ? "Failed" : "Complete"}</span></div><pre>{item.output}</pre></article> : <article key={item.id} className="rotation-card"><div className="rotation-line" /><details><summary><ChevronsDown size={14} /><span>{item.kind === "compact" ? "Live Compact" : "Context handover"}</span><b className="mono">{item.beforeTokens?.toLocaleString() ?? "—"} <ArrowRight size={12} /> {item.afterTokens !== undefined ? `${item.afterTokens.toLocaleString()} tokens · ` : ""}Epoch {item.epoch}</b></summary>{item.summary && <pre>{item.summary}</pre>}</details><div className="rotation-line" /></article>)}
      {snapshot.pendingPermissions.map(request => <section className="permission-card" key={request.requestId}><div className="row"><ShieldCheck size={19} /><div><div className="eyebrow">APPROVAL REQUIRED</div><h3>{request.title ?? request.toolName}</h3></div></div><span className="mono tool-name">{request.toolName}</span><pre>{JSON.stringify(request.rawInput, null, 2)}</pre><div className="permission-actions"><button className="primary" onClick={() => void act("permission", { requestId: request.requestId, choice: "allow_once" })}><Check size={13} />Allow Once</button><button onClick={() => void act("permission", { requestId: request.requestId, choice: "allow_session" })}>Allow for Session</button><button className="danger-ghost" onClick={() => void act("permission", { requestId: request.requestId, choice: "deny" })}>Deny</button></div></section>)}
      {snapshot.timeline.length > 0 && <div className="timeline-end"><i /><span>{snapshot.rotating ? "Distilling context into the next epoch…" : snapshot.busy ? "Working in your workspace" : "Ready for your next step"}</span></div>}
    </div>
  </div>{!atBottom && <button className="jump-latest" onClick={() => { following.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }}><ArrowDown size={14} />Latest</button>}</div>;
}
