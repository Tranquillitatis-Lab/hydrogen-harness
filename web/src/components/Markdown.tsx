import { Children, isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { reportError } from "../store";

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = Children.toArray(children).find(isValidElement);
  const props = code?.props as { className?: string; children?: ReactNode } | undefined;
  const language = props?.className?.replace("language-", "") ?? "text";
  const text = String(props?.children ?? "").replace(/\n$/, "");
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch (error) { reportError(error); }
  }
  return <div className="code-block"><div className="code-caption"><span>{language}</span><button onClick={() => void copy()}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "Copied" : "Copy"}</button></div><pre>{children}</pre></div>;
}
export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{text}</ReactMarkdown></div>;
}
