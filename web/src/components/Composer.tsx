import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Activity, ArrowUp, AtSign, ChevronRight, Command, File, LoaderCircle, Square, Terminal } from "lucide-react";
import { act, api, reportError, useStudio } from "../store";
import type { Snapshot } from "../types";
import { ImeMonitor, type ImeLogEntry, type ImePhase } from "./ImeMonitor";

const POST_COMP_GUARD_MS = 100;
const MAX_IME_LOGS = 60;

function resizeTextarea(element: HTMLTextAreaElement, composing: boolean): void {
  if (composing) {
    if (element.scrollHeight > element.clientHeight) {
      element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
    }
    return;
  }
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
}

export function Composer({ snapshot, draft, onDraft }: { snapshot: Snapshot; draft: string; onDraft: (value: string) => void }) {
  const { commands, connection } = useStudio();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const [cursor, setCursor] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [sending, setSending] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const composingRef = useRef(false);
  const lastCompEndAtRef = useRef(0);
  const postCompPendingRef = useRef(false);
  const postCompTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const guardFlashTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastLogAtRef = useRef(performance.now());
  const logSeqRef = useRef(0);
  const logBufferRef = useRef<ImeLogEntry[]>([]);

  const [imeMonitorOpen, setImeMonitorOpen] = useState(false);
  const [imePhase, setImePhase] = useState<ImePhase>("idle");
  const [compData, setCompData] = useState("");
  const [guardCount, setGuardCount] = useState(0);
  const [imeEntries, setImeEntries] = useState<ImeLogEntry[]>([]);

  const recordIme = useCallback((entry: Omit<ImeLogEntry, "id" | "at" | "deltaMs">) => {
    const now = performance.now();
    const deltaMs = now - lastLogAtRef.current;
    lastLogAtRef.current = now;
    const item: ImeLogEntry = {
      ...entry,
      id: ++logSeqRef.current,
      at: new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      deltaMs,
    };
    const next = [item, ...logBufferRef.current].slice(0, MAX_IME_LOGS);
    logBufferRef.current = next;
    setImeEntries(next);
  }, []);

  const flashGuarded = useCallback(() => {
    setGuardCount(count => count + 1);
    setImePhase("guarded");
    clearTimeout(guardFlashTimerRef.current);
    guardFlashTimerRef.current = setTimeout(() => {
      setImePhase(composingRef.current ? "composing" : "idle");
    }, 900);
  }, []);

  const checkImeKeyGuard = useCallback((event: {
    key: string;
    isComposing?: boolean;
    keyCode?: number;
  }): string | null => {
    if (composingRef.current) return "BLOCK:composing_state";
    if (event.isComposing) return "BLOCK:native_isComposing";
    if (event.keyCode === 229 || event.key === "Process") return "BLOCK:keyCode229";
    if (postCompPendingRef.current && performance.now() - lastCompEndAtRef.current <= POST_COMP_GUARD_MS) {
      if (["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown"].includes(event.key)) {
        postCompPendingRef.current = false;
        clearTimeout(postCompTimerRef.current);
        return "BLOCK:post_comp_guard";
      }
    }
    return null;
  }, []);

  const shell = draft.trimStart().startsWith("!");
  const slash = /^\/([^\s]*)$/.exec(draft);
  const mention = /(?:^|\s)@([^\s]*)$/.exec(draft.slice(0, cursor));
  const query = mention?.[1];
  const slashOptions = slash ? commands.filter(command => command.name.startsWith(slash[1].toLowerCase()) || command.aliases?.some(alias => alias.startsWith(slash[1].toLowerCase()))) : [];
  const options = !dismissed && slash ? slashOptions.map(command => ({ value: `/${command.name}`, label: command.usage, description: command.description }))
    : !dismissed && mention ? files.map(file => ({ value: file, label: file, description: "Workspace file" })) : [];
  const blocked = snapshot.busy || snapshot.rotating || connection !== "connected";

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element || composingRef.current) return;
    if (element.value !== draft) element.value = draft;
    resizeTextarea(element, false);
  }, [draft]);
  useEffect(() => () => {
    clearTimeout(postCompTimerRef.current);
    clearTimeout(guardFlashTimerRef.current);
  }, []);
  useEffect(() => {
    const focus = () => textarea.current?.focus();
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); onDraft("/"); setCursor(1); setDismissed(false); textarea.current?.focus();
      }
      if (event.key === "Escape" && (snapshot.busy || snapshot.rotating)) {
        const reason = checkImeKeyGuard({ key: event.key, isComposing: event.isComposing, keyCode: event.keyCode });
        if (reason) {
          recordIme({ event: "keydown", key: event.key, code: event.code, keyCode: event.keyCode, isComposing: event.isComposing, decision: `${reason}(global_esc)` });
          flashGuarded();
          return;
        }
        void act("abort");
      }
    };
    window.addEventListener("hydrogen:focus", focus);
    window.addEventListener("keydown", keys);
    return () => { window.removeEventListener("hydrogen:focus", focus); window.removeEventListener("keydown", keys); };
  }, [checkImeKeyGuard, flashGuarded, onDraft, recordIme, snapshot.busy, snapshot.rotating]);
  useEffect(() => { setSelected(0); }, [draft, query]);
  useEffect(() => {
    setFiles([]);
    if (query === undefined) return;
    let current = true;
    const timer = setTimeout(() => {
      void api<{ files: string[] }>(`files?q=${encodeURIComponent(query)}`).then(data => { if (current) setFiles(data.files); }).catch(error => { if (current) reportError(error); });
    }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [query]);
  function choose(value: string) {
    let next: string;
    let position: number;
    if (mention && !slash) {
      const start = cursor - mention[1].length;
      next = draft.slice(0, start) + value + " " + draft.slice(cursor);
      position = start + value.length + 1;
    } else { next = value + " "; position = next.length; }
    if (textarea.current) textarea.current.value = next;
    onDraft(next); setCursor(position); setDismissed(true);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(position, position); });
  }
  async function send() {
    const currentText = textarea.current?.value ?? draft;
    if (!currentText.trim() || blocked || sending) return;
    if (currentText !== latestDraft.current) onDraft(currentText);
    setSending(true);
    try {
      await api("prompt", { text: currentText });
      if ((textarea.current?.value ?? latestDraft.current) === currentText) {
        if (textarea.current) textarea.current.value = "";
        onDraft("");
      }
    }
    catch (error) { reportError(error); }
    finally { setSending(false); }
  }
  return <div className="composer-wrap">
    <ImeMonitor
      open={imeMonitorOpen}
      phase={imePhase}
      compData={compData}
      guardCount={guardCount}
      entries={imeEntries}
      onClear={() => { logBufferRef.current = []; setImeEntries([]); setGuardCount(0); }}
      onClose={() => setImeMonitorOpen(false)}
    />
    <div className={`composer ${shell ? "shell-mode" : ""}`}>
      {options.length > 0 && <div className="autocomplete" role="listbox" id="composer-suggestions" aria-label={slash ? "Slash commands" : "Workspace files"}><div className="autocomplete-label">{slash ? <Command size={12} /> : <AtSign size={12} />}{slash ? "COMMANDS" : "WORKSPACE FILES"}<span>↑ ↓ to navigate · ↵ select</span></div><div className="autocomplete-scroll">{options.map((option, index) => <button type="button" role="option" aria-selected={index === selected} id={`suggestion-${index}`} key={option.value} className={index === selected ? "selected" : ""} onMouseDown={event => event.preventDefault()} onClick={() => choose(option.value)}>{slash ? <ChevronRight size={14} /> : <File size={14} />}<div><strong>{option.label}</strong><span>{option.description}</span></div><kbd>↵</kbd></button>)}</div></div>}
      {shell && <div className="shell-badge"><Terminal size={12} />SHELL MODE<span>Runs in your workspace</span></div>}
      <textarea
        ref={textarea}
        defaultValue={draft}
        rows={2}
        placeholder="What would you like to build?"
        aria-label="Message Hydrogen"
        aria-controls={options.length ? "composer-suggestions" : undefined}
        aria-activedescendant={options.length ? `suggestion-${selected}` : undefined}
        onCompositionStart={event => {
          composingRef.current = true;
          postCompPendingRef.current = false;
          clearTimeout(postCompTimerRef.current);
          setImePhase("composing");
          setCompData(event.data ?? "");
          recordIme({ event: "compositionstart", data: event.data, isComposing: true, decision: "ENTER_IME" });
        }}
        onCompositionUpdate={event => {
          setCompData(event.data ?? "");
          recordIme({ event: "compositionupdate", data: event.data, isComposing: true, decision: "COMPOSING" });
        }}
        onCompositionEnd={event => {
          composingRef.current = false;
          lastCompEndAtRef.current = performance.now();
          postCompPendingRef.current = true;
          clearTimeout(postCompTimerRef.current);
          postCompTimerRef.current = setTimeout(() => { postCompPendingRef.current = false; }, POST_COMP_GUARD_MS);
          setImePhase("idle");
          setCompData("");
          const element = event.currentTarget;
          onDraft(element.value);
          setCursor(element.selectionStart);
          setDismissed(false);
          resizeTextarea(element, false);
          recordIme({ event: "compositionend", data: event.data, isComposing: false, decision: "SYNC_END" });
        }}
        onBeforeInput={event => {
          const native = event.nativeEvent as InputEvent;
          recordIme({
            event: "beforeinput",
            inputType: native.inputType,
            data: native.data,
            isComposing: native.isComposing || composingRef.current,
            decision: composingRef.current ? "IME_BUFFER" : "PASS",
          });
        }}
        onChange={event => {
          const element = event.currentTarget;
          const native = event.nativeEvent as InputEvent;
          const isComp = composingRef.current || Boolean(native?.isComposing);
          if (isComp) {
            resizeTextarea(element, true);
            recordIme({
              event: "input",
              inputType: native?.inputType,
              data: native?.data,
              isComposing: true,
              decision: "DEFER_CONTROLLED_SYNC",
            });
            return;
          }
          onDraft(element.value);
          setCursor(element.selectionStart);
          setDismissed(false);
          resizeTextarea(element, false);
          recordIme({
            event: "input",
            inputType: native?.inputType,
            data: native?.data,
            isComposing: false,
            decision: "SYNC_DRAFT",
          });
        }}
        onSelect={event => {
          if (!composingRef.current) setCursor(event.currentTarget.selectionStart);
        }}
        onKeyDown={event => {
          const native = event.nativeEvent;
          const guardReason = checkImeKeyGuard({
            key: event.key,
            isComposing: native.isComposing,
            keyCode: native.keyCode,
          });
          if (guardReason) {
            if (guardReason === "BLOCK:post_comp_guard" && event.key === "Enter") {
              event.preventDefault();
            }
            if (["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", " "].includes(event.key) || native.keyCode === 229) {
              recordIme({
                event: "keydown",
                key: event.key,
                code: event.code,
                keyCode: native.keyCode,
                isComposing: native.isComposing,
                decision: guardReason,
              });
              if (event.key === "Enter" || event.key === "Escape") flashGuarded();
            }
            return;
          }
          if (options.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const next = (selected + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
            setSelected(next);
            document.getElementById(`suggestion-${next}`)?.scrollIntoView({ block: "nearest" });
            recordIme({ event: "keydown", key: event.key, code: event.code, keyCode: native.keyCode, isComposing: native.isComposing, decision: "AUTOCOMPLETE_NAV" });
          } else if (options.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !(slash && commands.some(command => command.name === slash[1]))))) {
            event.preventDefault();
            choose(options[selected]?.value ?? options[0].value);
            recordIme({ event: "keydown", key: event.key, code: event.code, keyCode: native.keyCode, isComposing: native.isComposing, decision: "AUTOCOMPLETE_CHOOSE" });
          } else if (event.key === "Escape") {
            setDismissed(true);
            recordIme({ event: "keydown", key: event.key, code: event.code, keyCode: native.keyCode, isComposing: native.isComposing, decision: "DISMISS_POPUP" });
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            recordIme({ event: "keydown", key: event.key, code: event.code, keyCode: native.keyCode, isComposing: native.isComposing, decision: "SEND" });
            void send();
          } else if (event.key === "Enter" || event.key === " ") {
            recordIme({ event: "keydown", key: event.key, code: event.code, keyCode: native.keyCode, isComposing: native.isComposing, decision: "PASS" });
          }
        }}
      />
      <div className="composer-toolbar"><div className="composer-tools"><button title="Mention a file" aria-label="Mention a file" onClick={() => { const element = textarea.current!; const position = element.selectionStart; const current = element.value; const prefix = position && !/\s/.test(current[position - 1]) ? " @" : "@"; const next = current.slice(0, position) + prefix + current.slice(position); element.value = next; onDraft(next); setCursor(position + prefix.length); setDismissed(false); requestAnimationFrame(() => { element.focus(); element.setSelectionRange(position + prefix.length, position + prefix.length); }); }}><AtSign size={15} /></button><button title="Slash commands" aria-label="Slash commands" onClick={() => { if (textarea.current) textarea.current.value = "/"; onDraft("/"); setCursor(1); setDismissed(false); textarea.current?.focus(); }}><Command size={15} /></button><button type="button" className={`ime-pill ${imePhase} ${imeMonitorOpen ? "open" : ""}`} title="Toggle IME input monitor" aria-expanded={imeMonitorOpen} onClick={() => setImeMonitorOpen(open => !open)}><Activity size={13} /><span>{imePhase === "composing" ? "IME 组词中" : imePhase === "guarded" ? "IME 已拦截" : "IME 监测"}</span>{guardCount > 0 && <b className="mono">{guardCount}</b>}</button><span className="composer-model">{snapshot.model}</span></div>
        {snapshot.busy || snapshot.rotating ? <button className="stop-button" onClick={() => void act("abort")}><Square size={12} fill="currentColor" />Stop</button> : <button className="send-button" disabled={!draft.trim() || blocked || sending} aria-label="Send message" onClick={() => void send()}>{sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} />}</button>}
      </div>
    </div>
    <div className="composer-footer"><span><i />{snapshot.approvalMode === "plan" ? "Plan before acting" : snapshot.approvalMode === "full-auto" ? "Full autonomy" : "Edits enabled, shell approval"}</span><span><kbd>↵</kbd> send <span className="footer-divider">·</span> <kbd>⇧ ↵</kbd> new line <span className="footer-divider">·</span> <kbd>esc</kbd> stop</span></div>
  </div>;
}
