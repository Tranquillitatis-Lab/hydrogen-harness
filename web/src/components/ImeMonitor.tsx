import { useState } from "react";
import { Activity, Check, Copy, Trash2, X } from "lucide-react";

export type ImePhase = "idle" | "composing" | "guarded";

export interface ImeLogEntry {
  id: number;
  at: string;
  deltaMs: number;
  event: "compositionstart" | "compositionupdate" | "compositionend" | "beforeinput" | "input" | "keydown";
  key?: string;
  code?: string;
  keyCode?: number;
  isComposing?: boolean;
  inputType?: string;
  data?: string | null;
  decision: string;
}

export function ImeMonitor({
  open,
  phase,
  compData,
  guardCount,
  entries,
  onClear,
  onClose,
}: {
  open: boolean;
  phase: ImePhase;
  compData: string;
  guardCount: number;
  entries: ImeLogEntry[];
  onClear: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;

  async function copyTrace() {
    const lines = entries.map(entry =>
      `${entry.at} (+${entry.deltaMs}ms) ${entry.event}` +
      (entry.key !== undefined ? ` key=${JSON.stringify(entry.key)} code=${entry.code ?? "-"} keyCode=${entry.keyCode ?? "-"}` : "") +
      (entry.inputType ? ` inputType=${entry.inputType}` : "") +
      (entry.isComposing !== undefined ? ` isComposing=${entry.isComposing}` : "") +
      (entry.data !== undefined ? ` data=${JSON.stringify(entry.data)}` : "") +
      ` -> ${entry.decision}`,
    );
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Ignore clipboard errors if focus/permission denies */
    }
  }

  return (
    <section className="ime-monitor" aria-label="IME input monitor">
      <div className="ime-monitor-head">
        <div className="row">
          <Activity size={13} />
          <strong>IME 输入法监测</strong>
          <span className={`ime-state-chip ${phase}`}>
            {phase === "composing" ? `Composing${compData ? `: "${compData}"` : ""}` : phase === "guarded" ? "Guarded" : "Idle"}
          </span>
          <span className="badge mono">Intercepted: {guardCount}</span>
        </div>
        <div className="row">
          <button type="button" className="ime-mini-btn" onClick={() => void copyTrace()} disabled={!entries.length}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="ime-mini-btn" onClick={onClear} disabled={!entries.length}>
            <Trash2 size={12} />
            Clear
          </button>
          <button type="button" className="icon-button" aria-label="Close IME monitor" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="ime-monitor-body">
        {entries.length === 0 ? (
          <div className="ime-empty">在此输入框用搜狗输入法打字（如敲 GPT 后按回车或空格），这里会实时记录 composition / beforeinput / keydown 时序与拦截判定。</div>
        ) : (
          <div className="ime-log-list">
            {entries.map(entry => (
              <div key={entry.id} className={`ime-log-row ${entry.decision.startsWith("BLOCK") ? "blocked" : entry.decision === "SEND" ? "sent" : ""}`}>
                <span className="mono ime-time">+{entry.deltaMs.toFixed(0)}ms</span>
                <span className="mono ime-ev">{entry.event}</span>
                <span className="mono ime-meta">
                  {entry.key !== undefined && <>key=<b>{entry.key}</b> kc={entry.keyCode} </>}
                  {entry.inputType && <>type=<b>{entry.inputType}</b> </>}
                  {entry.isComposing !== undefined && <>comp=<b>{String(entry.isComposing)}</b> </>}
                  {entry.data !== undefined && entry.data !== null && entry.data !== "" && <>data=<b>{JSON.stringify(entry.data)}</b></>}
                </span>
                <span className={`mono ime-decision ${entry.decision.startsWith("BLOCK") ? "block" : entry.decision === "SEND" ? "send" : ""}`}>
                  {entry.decision}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
