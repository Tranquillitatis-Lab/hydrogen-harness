import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { connect, hotUpdated, reportError, useStudio } from "./store";
import "./styles.css";

function Root() {
  const { hmrVersion } = useStudio();
  return <ErrorBoundary name="Studio" resetKey={hmrVersion}><App /></ErrorBoundary>;
}
const disconnect = connect();
createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
if (new URL(location.href).searchParams.has("token")) {
  const url = new URL(location.href);
  url.searchParams.delete("token");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}
if (import.meta.hot) {
  const hotError = ({ err }: { err: { message: string; id?: string } }) => reportError(`${err.id ? `${err.id}: ` : ""}${err.message}`);
  import.meta.hot.on("vite:afterUpdate", hotUpdated);
  import.meta.hot.on("vite:error", hotError);
  import.meta.hot.dispose(() => {
    disconnect();
    import.meta.hot?.off("vite:afterUpdate", hotUpdated);
    import.meta.hot?.off("vite:error", hotError);
  });
}
