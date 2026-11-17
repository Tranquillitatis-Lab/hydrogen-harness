import { useEffect, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { dismissError, useStudio } from "./store";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Timeline } from "./components/Timeline";
import { Composer } from "./components/Composer";
import { Inspector } from "./components/Inspector";

export default function App() {
  const { snapshot, error, hmrVersion, connection } = useStudio();
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 1000);
  const [inspector, setInspector] = useState(() => window.innerWidth > 1400);
  const [theme, setTheme] = useState(() => localStorage.getItem("hydrogen-theme") ?? "dark");
  const [draft, setDraft] = useState("");
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("hydrogen-theme", theme); }, [theme]);
  const fillComposer = (text: string) => { setDraft(text); window.dispatchEvent(new Event("hydrogen:focus")); };
  if (!snapshot) return <div className="boot"><div className="brand-mark">H<span>₂</span></div><h1>Hydrogen</h1><p>{connection === "reconnecting" ? "Reconnecting to your workspace…" : "Connecting to your workspace…"}</p>{error && <p className="error-text">{error}</p>}</div>;
  return <div className={`studio ${sidebar ? "with-sidebar" : ""} ${inspector ? "with-inspector" : ""}`}>
    {sidebar && <aside className="sidebar-zone"><ErrorBoundary name="Sidebar" resetKey={hmrVersion}><Sidebar snapshot={snapshot} onCompose={fillComposer} onClose={() => setSidebar(false)} /></ErrorBoundary></aside>}
    <main className="main-zone">
      <ErrorBoundary name="TopBar" resetKey={hmrVersion}><TopBar snapshot={snapshot} theme={theme} onTheme={() => setTheme(theme === "dark" ? "light" : "dark")} onSidebar={() => setSidebar(!sidebar)} onInspector={() => setInspector(!inspector)} inspector={inspector} /></ErrorBoundary>
      {error && <div className="error-banner" role="alert"><AlertCircle size={16} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={dismissError}><X size={15} /></button></div>}
      <div className="timeline-zone"><ErrorBoundary name="Timeline" resetKey={hmrVersion}><Timeline snapshot={snapshot} onCompose={fillComposer} /></ErrorBoundary></div>
      <div className="composer-zone"><ErrorBoundary name="Composer" resetKey={hmrVersion}><Composer snapshot={snapshot} draft={draft} onDraft={setDraft} /></ErrorBoundary></div>
    </main>
    {inspector && <aside className="inspector-zone"><ErrorBoundary name="Inspector" resetKey={hmrVersion}><Inspector snapshot={snapshot} onClose={() => setInspector(false)} /></ErrorBoundary></aside>}
    {(sidebar || inspector) && <button className="mobile-scrim" aria-label="Close panels" onClick={() => { setSidebar(false); setInspector(false); }} />}
  </div>;
}
