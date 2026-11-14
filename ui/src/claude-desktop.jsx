import { InlineSelect } from "./inline-select";
import React, { useEffect, useRef, useState } from "react";
import {
  Download,
  ChevronDown,
  ChevronUp,
  Monitor,
  PanelLeftOpen,
  Power,
  RefreshCw,
} from "lucide-react";
import { BrowserUploads } from "./browser-uploads";
import { ProjectDialog } from "./project-dialog";
import { api } from "./api";
import { SafetyMessage } from "./safety-message";
import { RemoteView } from "./views";
import { useWindowVisibility } from "./window-visibility";
import "./claude-desktop.css";

const desktopZooms = [0.75, 0.9, 1, 1.1, 1.25, 1.5];

export function useDesktopZoom(automatic = false) {
  const [zoom, setZoom] = useState(() => {
    try {
      const stored = localStorage.getItem(automatic ? "cage-windows-desktop-zoom" : "cage-desktop-zoom");
      if (automatic && (stored === null || stored === "auto")) return "auto";
      const value = Number(stored);
      return desktopZooms.includes(value) ? value : automatic ? "auto" : 1;
    } catch { return automatic ? "auto" : 1; }
  });
  return [zoom, setZoom];
}

export function DesktopToolbar({ desktop, platform, title = "Claude Desktop", zoom, setZoom, onConfirm, onStop, onActivate, busy, refresh, sidebarCollapsed, onExpand, children, automatic = false }) {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem("cage-desktop-toolbar-hidden") === "true"; }
    catch { return false; }
  });
  const toggleToolbar = (value) => {
    setHidden(value);
    try { localStorage.setItem("cage-desktop-toolbar-hidden", String(value)); }
    catch { /* Keep the preference for this session. */ }
  };
  if (hidden && desktop?.running) {
    return (
      <div className="desktop-toolbar-reveal">
        {sidebarCollapsed && <button className="icon-button" aria-controls="workspace-sidebar" aria-expanded="false" aria-label="展开侧栏" title="展开侧栏" onClick={onExpand}><PanelLeftOpen size={15} /></button>}
        <button className="icon-button" aria-label="显示 Desktop 工具栏" title="显示 Desktop 工具栏" onClick={() => toggleToolbar(false)}><ChevronDown size={15} /></button>
      </div>
    );
  }
  return (
      <header className="claude-desktop-toolbar">
        {sidebarCollapsed && (
          <button
            className="icon-button"
            aria-controls="workspace-sidebar" aria-expanded="false" aria-label="展开侧栏"
            onClick={onExpand}
          >
            <PanelLeftOpen size={17} />
          </button>
        )}
        {sidebarCollapsed && <><Monitor size={18} /><strong>{title}</strong></>}
        <span className="desktop-version">
          {desktop?.version ? `v${desktop.version}` : platform}
        </span>
        <span className="desktop-toolbar-spacer" />
        {children}
        {desktop?.running && (
          <label className="desktop-display-size">
            显示大小
            <InlineSelect aria-label="Desktop 显示大小" value={zoom} onValueChange={(next) => {
              const value = next === "auto" ? "auto" : Number(next);
              setZoom(value);
              try { localStorage.setItem(automatic ? "cage-windows-desktop-zoom" : "cage-desktop-zoom", String(value)); } catch { /* Session-only preference. */ }
            }}>
              {automatic && <option value="auto">自适应（推荐）</option>}
              {desktopZooms.map((value) => <option key={value} value={value}>{Math.round(value * 100)}%{value === 1 ? "（默认）" : ""}</option>)}
            </InlineSelect>
          </label>
        )}
        {desktop?.running && desktop.native_user_session && platform === "Windows" && (
          <button
            className="quiet-button"
            disabled={busy}
            onClick={onActivate}
            title="重新激活 Claude 窗口，保留当前会话"
          >
            <Monitor size={15} />
            恢复操作
          </button>
        )}
        {desktop?.running && onStop && (
          <button
            className="quiet-button"
            disabled={busy}
            onClick={async () => {
              if (
                await onConfirm({
                  title: "关闭 Claude Desktop？",
                  body: "请先保存应用内的工作。浏览器和 Cage 终端会继续运行。",
                  confirm: "关闭应用",
                })
              )
                onStop();
            }}
          >
            <Power size={15} />
            关闭应用
          </button>
        )}
        <button
          className="icon-button"
          aria-label={"刷新 " + title + " 状态"}
          disabled={busy}
          onClick={refresh}
        >
          <RefreshCw size={15} />
        </button>
        {desktop?.running && <button className="icon-button" aria-label="隐藏 Desktop 工具栏" title="隐藏 Desktop 工具栏" onClick={() => toggleToolbar(true)}><ChevronUp size={15} /></button>}
      </header>
  );
}

export function DesktopLaunchProgress({ job, openingApp, onDetails }) {
  const stage = openingApp ? 2 : job?.running && !job.checking && ["start", "guest-install"].includes(job.kind) ? 1 : 0;
  const stages = ["检查环境", "启动环境", "打开应用"];
  const message = job?.running ? job.message : "";
  return <section className="desktop-launch-progress" aria-label="Claude Desktop 启动进度">
    <div role="status">
      <RefreshCw className="spin" size={22} aria-hidden="true" />
      <h2>{["正在检查 Cage 环境", "正在启动 Cage 环境", "正在打开 Claude Desktop"][stage]}</h2>
    </div>
    <ol aria-label="启动阶段">{stages.map((label, index) =>
      <li key={label} aria-current={stage === index ? "step" : undefined}>{label}</li>
    )}</ol>
    {message && <p><SafetyMessage message={message} /></p>}
    <button className="quiet-button" onClick={onDetails}>查看操作详情</button>
  </section>;
}

export function ClaudeDesktop({
  uploads = [],
  status,
  onProjectOpened,
  visible,
  remoteRef,
  onStatus,
  onFallback,
  onConfirm,
  onDetails,
  onCheckEnvironment,
  onOpeningChange,
  onExpand,
  sidebarCollapsed,
}) {
  const [closedChooser, setClosedChooser] = useState("");
  const directoryRequest = uploads.find((item) => item.directory && item.id !== closedChooser);
  const automatic = status.guest_system?.startsWith("windows");
  const [zoom, setZoom] = useDesktopZoom(automatic);
  const windowVisible = useWindowVisibility();
  const screenVisible = visible && windowVisible;
  const [desktop, setDesktop] = useState(null);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [jobID, setJobID] = useState("");
  const [launchStage, setLaunchStage] = useState("");
  useEffect(() => {
    onOpeningChange?.(Boolean(launchStage));
    return () => onOpeningChange?.(false);
  }, [Boolean(launchStage), onOpeningChange]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pendingAction = useRef(false);
  const statusRequest = useRef(null);
  const statusRevision = useRef(0);
  const ownJob = status.job?.kind?.startsWith("claude-desktop-");
  const busy = submitting || Boolean(status.job?.running) || Boolean(jobID);
  const refresh = async (valid = () => true) => {
    const revision = statusRevision.current;
    const request = statusRequest.current ??= api("/claude-desktop");
    try {
      const value = await request;
      if (!valid() || revision !== statusRevision.current) return null;
      setDesktop(value);
      setStatusError("");
      return value;
    } catch (e) {
      if (valid() && revision === statusRevision.current) setStatusError(e.message);
      return null;
    } finally {
      if (statusRequest.current === request) statusRequest.current = null;
    }
  };
  const run = async (action, checkEnvironment = false, activate = false) => {
    if (pendingAction.current || (!checkEnvironment && status.job?.running)) return;
    pendingAction.current = true;
    statusRevision.current++;
    statusRequest.current = null;
    setSubmitting(true);
    if (action === "start") setLaunchStage(checkEnvironment ? "check" : "app");
    setError("");
    try {
      if (checkEnvironment && onCheckEnvironment && !await onCheckEnvironment()) {
        pendingAction.current = false;
        setLaunchStage("");
        return;
      }
      if (!mounted.current) return;
      if (checkEnvironment && action === "start") {
        setLaunchStage("app");
        const snapshot = await refresh();
        if (!mounted.current) return;
        if (snapshot?.installed === false || snapshot?.running && !activate) {
          pendingAction.current = false;
          setLaunchStage("");
          return;
        }
      }
      const job = await api(`/claude-desktop/${action}`, {});
      setJobID(job.id);
    } catch (e) {
      pendingAction.current = false;
      setLaunchStage("");
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };
  useEffect(() => {
    if (!status.vm_running) { setDesktop(null); setStatusError(""); return; }
    if (!screenVisible || status.job?.running) return;
    let disposed = false;
    let timer;
    const poll = async () => {
      await refresh(() => !disposed);
      if (!disposed) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [screenVisible, status.vm_running, status.job?.running]);
  useEffect(() => {
    if (!jobID) return;
    let disposed = false, timer;
    const finish = (job) => {
      pendingAction.current = false;
      setJobID("");
      setLaunchStage("");
      if (!job || job.error || job.canceled) {
        setError(job?.error || (job?.canceled ? "操作已取消。" : "无法确认本次操作的结果，请刷新应用状态。"));
      } else if (["claude-desktop-install", "claude-desktop-update"].includes(job.kind) && !status.job?.running) {
        run("start");
        return;
      }
      refresh();
    };
    if (status.job?.id === jobID) {
      if (!status.job.running) finish(status.job);
      return;
    }
    // A short job can complete and be replaced between workbench status polls.
    // Allow the regular poll to catch up before consulting the saved result.
    const recover = async () => {
      try {
        const latest = await api("/status");
        if (disposed) return;
        const job = latest.job?.id === jobID ? latest.job :
          (await api("/jobs/history")).find(item => item.id === jobID);
        if (disposed) return;
        if (!job?.running) { finish(job); return; }
      } catch (e) {
        if (disposed) return;
        pendingAction.current = false;
        setJobID("");
        setLaunchStage("");
        setError(e.message);
        return;
      }
      timer = setTimeout(recover, 3000);
    };
    timer = setTimeout(recover, 3000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [jobID, status.job?.id, status.job?.running, status.job?.error, status.job?.canceled]);
  const canInstall = desktop?.installed === false && !automatic;
  const canOpen = !status.vm_running || !desktop || desktop.installed;
  return (
    <section className="claude-desktop-view" aria-label="Claude Desktop">
      <BrowserUploads requests={uploads} onStatus={onStatus} />
      {directoryRequest && <ProjectDialog
        key={directoryRequest.id}
        status={status}
        activate={false}
        onClose={() => {
          setClosedChooser(directoryRequest.id);
          void api("/input/files/cancel", { target: "desktop", id: directoryRequest.id }).catch((e) => onStatus(e.message));
        }}
        onOpened={async (workspace) => {
          await api("/input/files/directory", { target: "desktop", id: directoryRequest.id, workspace });
          setClosedChooser(directoryRequest.id);
          await onProjectOpened(workspace);
        }}
      />}
      <DesktopToolbar desktop={desktop} platform={status.guest_system === "windows-11" ? "Windows" : "Linux"} zoom={zoom} setZoom={setZoom} automatic={automatic}
        onConfirm={onConfirm} onStop={() => run("stop")} onActivate={() => run("start", true, true)} busy={busy} refresh={() => refresh()} sidebarCollapsed={sidebarCollapsed} onExpand={onExpand}>
        {desktop?.installed && !status.guest_system?.startsWith("windows") && <button className="quiet-button" disabled={busy} onClick={async () => {
          if (!desktop.running || await onConfirm({ title: "更新 Claude Desktop？", body: "请先保存工作。Claude Desktop 会关闭，从官方软件源更新后重新打开。登录资料会保留。", confirm: "更新应用" })) run("update");
        }}>更新应用</button>}
      </DesktopToolbar>
      {(error || statusError || desktop?.failed) && (
        <div className="connection-banner" role="alert">
          <SafetyMessage message={error || statusError || (desktop?.failure_reason === "oom-kill"
            ? "内存不足，系统已关闭 Claude Desktop。请在设置中检查计算资源，再打开应用。"
            : "Claude Desktop 未能启动，可重试打开或修复安装。")} />
          <button onClick={onDetails}>操作详情</button>
        </div>
      )}
      {desktop?.running && desktop.managed === false && !desktop.native_user_session && <div className="connection-banner" role="status">当前应用尚未接入 Cage 账户解锁。请先保存并关闭应用，再重新打开。</div>}
      {busy && !launchStage && (ownJob || submitting) && (
        <div className="desktop-progress" role="status">
          <RefreshCw size={16} className="spin" />
          {ownJob || status.job?.running ? status.job.message : "正在检查并打开 Claude Desktop…"}
          <button className="text-button" onClick={onDetails}>
            查看进度
          </button>
        </div>
      )}
      <div className="desktop-screen">
        {launchStage ? <DesktopLaunchProgress job={status.job} openingApp={launchStage === "app"} onDetails={onDetails} /> : desktop?.running && status.vm_running ? (
          <RemoteView
            ref={remoteRef}
            desktop
            onDetails={onDetails}
            zoom={zoom}
            visible={visible}
            keyboard={status.keyboard}
            guestPlatform={status.guest_system?.startsWith("windows") ? "windows" : status.guest_system}
            onStatus={onStatus}
            onFallback={onFallback}
          />
        ) : (
          <div className="desktop-empty">
            <div className="desktop-empty-heading">
              <Monitor size={26} aria-hidden="true" />
              <h2>Claude Desktop</h2>
            </div>
            <div className="desktop-intro">
              <p>{status.vm_running ? "在当前项目中使用 Chat 和 Code。" : "打开应用时会先启动 Cage 环境。"}</p>
              {desktop?.installed === false && <p>{automatic ? "请先在 Windows 客机中安装 Claude Desktop，再刷新状态。" : "应用将从 Anthropic 官方下载。"}</p>}
            </div>
            <div className="desktop-actions">
              {(canOpen || canInstall) && (
                <button
                  className="primary"
                  disabled={submitting || Boolean(jobID)}
                  onClick={() => run(desktop?.installed === false ? "install" : "start", true)}
                >
                  {desktop?.installed !== false ? (
                    <Monitor size={16} />
                  ) : (
                    <Download size={16} />
                  )}
                  {!status.vm_running ? "启动环境并打开 Claude Desktop" : desktop?.installed !== false ? "打开 Claude Desktop" : "下载并安装"}
                </button>
              )}
              {desktop?.installed && !status.guest_system?.startsWith("windows") && (
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={() => run("install")}
                >
                  更新 / 修复安装
                </button>
              )}
              {status.vm_running && (statusError || automatic && desktop?.installed === false) && (
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={() => refresh()}
                >
                  刷新状态
                </button>
              )}
            </div>
            {desktop?.installed && <p>{status.guest_system?.startsWith("windows")
              ? "在 Claude Desktop 应用内检查并安装更新。"
              : "更新应用会保留登录状态。"}</p>}
            <div className="desktop-note">
              <p>当前环境暂不支持 Cowork。</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
