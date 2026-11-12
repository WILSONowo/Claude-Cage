import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { installDiagnostics } from "./diagnostics.mjs";
import { DiagnosticBoundary } from "./diagnostics.jsx";
import { ClientRoot } from "./remote-hosts";
import { native } from "./api";
import "./style.css";
import "./workbench-layout.css";
import "./text-fields.css";

function WorkbenchEntry() {
  const [Workbench, setWorkbench] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let current = true;
    import("./main.jsx").then(
      module => { if (current) setWorkbench(() => module.default); },
      cause => { if (current) setError(cause); },
    );
    return () => { current = false; };
  }, []);
  if (error) throw error;
  return Workbench ? <Workbench /> : <div className="client-loading" role="status">正在打开工作台…</div>;
}

installDiagnostics();
// Keep the native menu usable while the workbench is loading or disconnected.
window.cageNativeAction = (command) => {
  if (window.cageWorkbenchAction) return window.cageWorkbenchAction(command);
  if (command === "quit") return native("quitNow");
};
createRoot(document.getElementById("root")).render(
  <DiagnosticBoundary>
    <ClientRoot>
      <WorkbenchEntry />
    </ClientRoot>
  </DiagnosticBoundary>,
);

window.addEventListener("hashchange", () => {
  if (location.hash) location.reload();
});
