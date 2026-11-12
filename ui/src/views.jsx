import React, { lazy, Suspense } from "react";

const RemotePane = lazy(() => import("./remote-pane"));
const TerminalPane = lazy(() => import("./terminal-pane"));

export function RemoteView(props) {
  return <Suspense fallback={<div className="view-overlay" role="status">正在加载画面…</div>}>
    <RemotePane {...props} />
  </Suspense>;
}

export function TerminalView(props) {
  return <Suspense fallback={<div className="view-overlay" role="status">正在加载终端…</div>}>
    <TerminalPane {...props} />
  </Suspense>;
}
