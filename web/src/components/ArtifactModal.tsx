import { useEffect, useRef } from "react";
import { FileText, X } from "lucide-react";
import type { FileContent } from "../types";

export function ArtifactModal({ artifact, onClose }: { artifact: FileContent; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="artifact-modal" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><FileText size={16} /><strong>{artifact.path}</strong><button className="icon-button" aria-label="Close artifact" onClick={onClose}><X size={18} /></button></header>
    {artifact.truncated && <p className="artifact-limit">Preview limited to 256 KB.</p>}<pre>{artifact.text}</pre>
  </dialog>;
}
