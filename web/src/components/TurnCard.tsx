import { Brain, ChevronRight, LoaderCircle, Sparkles } from "lucide-react";
import type { TimelineItem } from "../types";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolCallCard";

export function TurnCard({ turn, active }: { turn: TimelineItem; active: boolean }) {
  return <article className="turn" id={`turn-${turn.id}`}>
    <div className="user-message"><div className="message-label"><span>YOU</span><time>{new Date(turn.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><div className="user-bubble">{turn.userText}</div></div>
    <div className="assistant-message"><div className="assistant-heading"><span className="assistant-symbol"><Sparkles size={15} /></span><strong>Hydrogen</strong><span className="mono muted">E{turn.epoch}</span>{active && <span className="working-label"><LoaderCircle size={11} className="spin" />Working</span>}</div>
      {turn.thoughtText && <details className="thinking"><summary><ChevronRight size={13} /><Brain size={14} />Thinking<span>{turn.thoughtText.length.toLocaleString()} chars</span></summary><div>{turn.thoughtText}</div></details>}
      {turn.tools && turn.tools.length > 0 && <div className="tool-list">{turn.tools.map((tool, index) => <ToolCallCard key={`${tool.callId}-${index}`} tool={tool} />)}</div>}
      {turn.assistantText && <Markdown text={turn.assistantText} />}
      {active && !turn.assistantText && !turn.tools?.length && <div className="thinking-dots"><i /><i /><i /></div>}
      {turn.error && <div className="turn-error" role="alert">{turn.error}</div>}{turn.aborted && <div className="turn-aborted">Turn interrupted</div>}
    </div>
  </article>;
}
