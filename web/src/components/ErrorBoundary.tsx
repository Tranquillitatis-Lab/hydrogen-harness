import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props { name: string; children: ReactNode; resetKey?: number }
interface State { error: Error | null; stack: string }
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "" };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? error.stack ?? "" });
  }
  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.retry();
  }
  retry = () => this.setState({ error: null, stack: "" });
  render() {
    if (!this.state.error) return this.props.children;
    return <section className="panel-error" role="alert">
      <AlertTriangle size={20} /><div className="eyebrow">PANEL DIAGNOSTIC</div>
      <h3>{this.props.name}</h3><p>{this.state.error.message}</p>
      <pre>{(this.state.error.stack ?? this.state.stack).split("\n").slice(0, 7).join("\n")}</pre>
      <button onClick={this.retry}><RotateCcw size={14} />Retry Panel</button>
    </section>;
  }
}
