import { useState } from "react";
import { Check, ChevronDown, Layers, Moon, PanelLeft, PanelRight, Sun, X, Zap } from "lucide-react";
import { act, useStudio } from "../store";
import type { ApprovalMode, Snapshot } from "../types";

const modes: { id: ApprovalMode; label: string }[] = [
  { id: "plan", label: "Plan" }, { id: "auto-edit", label: "Auto-Edit" }, { id: "full-auto", label: "Full-Auto" },
];
export function TopBar({ snapshot, theme, onTheme, onSidebar, onInspector, inspector }: {
  snapshot: Snapshot; theme: string; onTheme: () => void; onSidebar: () => void; onInspector: () => void; inspector: boolean;
}) {
  const { connection, hmrUpdated } = useStudio();
  const [compact, setCompact] = useState(false);
  const [focus, setFocus] = useState("");
  const stats = snapshot.contextStats;
  const blocked = snapshot.busy || snapshot.rotating;
  return <header className="topbar">
    <div className="topbar-leading"><button className="icon-button" title="Toggle sidebar" aria-label="Toggle sidebar" onClick={onSidebar}><PanelLeft size={17} /></button>
      <span className={`connection-pill ${connection === "connected" ? "online" : "offline"}`}><i className={snapshot.busy ? "pulse" : ""} />{connection !== "connected" ? "Reconnecting" : snapshot.rotating ? "Compacting" : snapshot.busy ? "Streaming" : "Connected"}</span>
      <span className="epoch-badge"><Layers size={13} />Epoch <b>{snapshot.epoch}</b></span>
    </div>
    <div className="context-control"><div className="context-caption"><span className="eyebrow">CONTEXT</span><span className="mono">{(stats.inputTokens / 1000).toFixed(1)}k / {(stats.contextWindow / 1000).toLocaleString()}k · {(stats.usageRatio * 100).toFixed(1)}%</span></div>
      <div className={`meter ${stats.level}`}><div style={{ width: `${Math.min(100, stats.usageRatio * 100)}%` }} /></div>
      <button className="compact-trigger" disabled={blocked} onClick={() => setCompact(!compact)}>Compact<ChevronDown size={12} /></button>
      {compact && <form className="popover compact-popover" onSubmit={event => { event.preventDefault(); void act("compact", { instructions: focus }); setCompact(false); }}>
        <div className="row between"><strong>Compact context</strong><button type="button" className="icon-button" aria-label="Close compact" onClick={() => setCompact(false)}><X size={14} /></button></div>
        <p>Carry the important context into the next epoch.</p><input autoFocus value={focus} onChange={event => setFocus(event.target.value)} placeholder="Optional focus or instructions…" aria-label="Compaction focus" />
        <button className="primary" disabled={blocked}><Check size={14} />Compact & continue</button>
      </form>}
    </div>
    <div className="topbar-actions"><div className="mode-switch" aria-label="Approval mode">{modes.map(mode => <button key={mode.id} className={snapshot.approvalMode === mode.id ? "selected" : ""} onClick={() => void act("settings", { approvalMode: mode.id })}>{mode.label}</button>)}</div>
      {snapshot.hmrEnabled && <span className={`hmr-badge ${hmrUpdated ? "updated" : ""}`}><Zap size={11} />{hmrUpdated ? "HMR Updated" : "HMR Live"}</span>}
      <button className="icon-button" onClick={onTheme} title="Toggle theme" aria-label="Toggle theme">{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button>
      <button className={`icon-button ${inspector ? "active" : ""}`} onClick={onInspector} title="Toggle inspector" aria-label="Toggle inspector"><PanelRight size={17} /></button>
    </div>
  </header>;
}
