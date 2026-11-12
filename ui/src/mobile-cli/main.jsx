import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Archive, ArrowLeft, LoaderCircle, Monitor, Settings, Terminal } from "lucide-react";
import { CodeNavigation, ProjectTree, WorkspaceDrawer, workspaceTools } from "./workspace-drawer";
import { deviceCommand } from "./device-navigation.mjs";
import { accessDenied, request, sessionPath } from "./transport.mjs";
import { SessionActionDialog, sortSessions } from "./session-row";
import { ArchivedSessions } from "../cli-sessions";
import cageLogo from "../logo.png";
import { Notice, Empty } from "./feedback";
import "./mobile.css";

const Chat = lazy(() => import("./chat"));
const RemoteDisplay = lazy(() => import("./remote-browser").then(module => ({ default: module.RemoteDisplay })));

const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
function displayTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : dateFormat.format(date);
}

const nativePhone = navigator.userAgent.includes("CageMobile/1");
const phoneWorkspace = nativePhone || location.pathname === "/";
function route() {
  const value = history.state?.cageCLI || (new URLSearchParams(location.search).get("page") === "archived" ? {tool:"archived"} : null);
  const id = value?.displayID || value?.browser;
  const displayID = typeof id === "string" && /^[a-f0-9-]{36}$/.test(id) ? id : "";
  const tool = ["settings", "archived"].includes(value?.tool) ? value.tool : displayID && ["browser", "claude", "desktop"].includes(value.tool) ? value.tool : displayID ? "browser" : "code";
  return {tool, displayID, project: typeof value?.project === "string" ? value.project : "", session: typeof value?.session === "string" ? value.session : ""};
}
function saveRoute(next, push) {
  history[push ? "pushState" : "replaceState"]({ ...history.state, cageCLI: next }, "");
}

function App() {
  const [current, setCurrent] = useState(route);
  const [addressSlot, setAddressSlot] = useState(null);
  const [drawer, setDrawer] = useState(() => phoneWorkspace && !history.state?.cageCLI && route().tool === "code");
  const drafts = useRef(new Map());
  const [expanded, setExpanded] = useState(() => new Map());
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState("");
  const [gate, setGate] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [visible, setVisible] = useState(!document.hidden);
  const [creating, setCreating] = useState(false);
  const [sessionAction, setSessionAction] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState("");
  const mutationBusy = useRef(false);
  const catalogGeneration = useRef(0);
  const archivedSessions = useRef(new Set());
  const [devices, setDevices] = useState(() => window.__cageDevices || { current: "", devices: [] });
  const createRequest = useRef(null);
  const openBrowserRequest = useRef(null);
  const browserControls = useRef(null);
  const createBusy = useRef(false);
  const pageGeneration = useRef(0);
  const accessGeneration = useRef(0);
  const refreshAll = useCallback(() => setRefresh((n) => n + 1), []);
  useEffect(() => {
    const update = event => setDevices(event.detail);
    window.addEventListener("cage-devices", update);
    // Native bridges may become available after the document starts loading.
    if (window.__cageDevices) setDevices(window.__cageDevices);
    return () => window.removeEventListener("cage-devices", update);
  }, []);
  useEffect(() => {
    if (catalog?.host && devices.current) deviceCommand("name", { id: devices.current, name: catalog.host });
  }, [catalog?.host, devices.current]);
  const restricted = useCallback((error) => {
    pageGeneration.current++;
    accessGeneration.current++;
    drafts.current.clear();
    setSessionAction(null);
    if (route().displayID) {
      const next = {...route(), tool: "code", displayID: ""};
      saveRoute(next, false);
      setCurrent(next);
    }
    setGate(error.message); setCatalog(null); setError("");
  }, []);
  useEffect(() => {
    const goBack = () => { openBrowserRequest.current = null; pageGeneration.current++; setCurrent(route()); setDrawer(phoneWorkspace && !history.state?.cageCLI); setError(""); };
    const visibility = () => setVisible(!document.hidden);
    const viewport = window.visualViewport;
    const resize = () => {
      if (viewport?.scale === 1) document.documentElement.style.setProperty("--mobile-height", viewport.height + "px");
    };
    resize();
    window.addEventListener("popstate", goBack);
    window.addEventListener("online", refreshAll);
    document.addEventListener("visibilitychange", visibility);
    viewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("popstate", goBack);
      window.removeEventListener("online", refreshAll);
      document.removeEventListener("visibilitychange", visibility);
      viewport?.removeEventListener("resize", resize);
    };
  }, [refreshAll]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const expectedAccess = accessGeneration.current;
    let timer;
    const load = async () => {
      const expectedCatalog = catalogGeneration.current;
      try {
        const [info, list] = await Promise.all([request("/projects", options), request("/sessions", options)]);
        if (controller.signal.aborted || expectedAccess !== accessGeneration.current || expectedCatalog !== catalogGeneration.current) return;
        for (const session of list.sessions || []) archivedSessions.current.delete(session.id);
        setCatalog({ ...info, sessions: (list.sessions || []).map(session => list.notice ? {...session, active:false} : session) }); setGate(""); setError(list.notice || "");
      } catch (error) {
        if (controller.signal.aborted) return;
        if (accessDenied(error)) { restricted(error); return; }
        setError(error.message);
        setCatalog(previous => previous && ({...previous, sessions:previous.sessions.map(session => ({...session, active:false}))}));
      }
      if (!controller.signal.aborted && (drawer || current.tool !== "code" || !current.session)) timer = setTimeout(load, 5000);
    };
    void load();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [refresh, visible, restricted, current.session, current.tool, drawer]);
  const open = (project, session = "", push = false) => {
    const next = {tool: "code", displayID: "", project, session};
    pageGeneration.current++;
    saveRoute(next, push); setCurrent(next); setError("");
  };
  const updateSession = useCallback((snapshot) => {
    setCatalog((old) => {
      if (!old) return old;
      const { id, workspace, title, revision, updated_at, generation, pinned, custom_title, metadata_set, active } = snapshot;
      if (archivedSessions.current.has(id)) return old;
      const previous = old.sessions.find((s) => s.id === id);
      if (previous && previous.generation === generation && previous.revision >= revision) return old;
      return { ...old, sessions: [{ id, workspace, title, revision, updated_at, generation, pinned, custom_title, metadata_set, active }, ...old.sessions.filter((s) => s.id !== id)] };
    });
  }, []);
  const projects = catalog?.projects || [];
  const project = projects.find((p) => p.path === current.project) || projects[0];
  const sessions = catalog?.sessions.filter((s) => s.workspace === project?.path)
    .sort(sortSessions) || [];
  const missingSession = useCallback(() => {
    const selected = route();
    drafts.current.delete(selected.session);
    const next = {...selected, session:""};
    saveRoute(next, false); setCurrent(next); setDrawer(phoneWorkspace); refreshAll();
  }, [refreshAll]);
  const mutateSession = async (kind, target, body) => {
    if (mutationBusy.current) return;
    mutationBusy.current = true; setActionBusy(true); setSessionActionError("");
    catalogGeneration.current++;
    try {
      const result = await request(sessionPath(target.id) + (kind === "archive" ? "/archive" : "/metadata"), {body});
      if (kind === "archive") {
        archivedSessions.current.add(target.id);
        drafts.current.delete(target.id);
        setCatalog(old => old && ({...old, sessions:old.sessions.filter(s => s.id !== target.id)}));
        if (route().session === target.id) missingSession();
      } else updateSession(result);
      setSessionAction(null);
    } catch (error) {
      if (accessDenied(error)) restricted(error);
      else if (kind === "pin") setError(error.message);
      else setSessionActionError(error.message);
    } finally {
      catalogGeneration.current++;
      mutationBusy.current = false; setActionBusy(false); refreshAll();
    }
  };
  const chooseSessionAction = (kind, target) => {
    if (mutationBusy.current) return;
    if (kind === "pin") void mutateSession(kind, target, {pinned:!target.pinned});
    else { setSessionActionError(""); setSessionAction({kind, session:target}); }
  };
  const start = async target => {
    if (!target || createBusy.current || !catalog.ready) return;
    createBusy.current = true; setCreating(true); setError("");
    const generation = pageGeneration.current;
    try {
      if (createRequest.current?.workspace !== target.path) createRequest.current = {
        id: crypto.randomUUID(), workspace: target.path, ...(catalog.shared_sessions ? {shared:true} : {}),
      };
      const session = await request("/sessions", { body: createRequest.current });
      createRequest.current = null;
      if (generation !== pageGeneration.current) return;
      updateSession(session);
      setExpanded(previous => new Map(previous).set(target.path, true));
      open(target.path, session.id, true); setDrawer(false);
    } catch (error) {
      if (generation !== pageGeneration.current) return;
      if (error.status && error.status < 500) createRequest.current = null;
      if (accessDenied(error)) restricted(error); else setError(error.message);
    } finally { createBusy.current = false; setCreating(false); }
  };
  const session = current.session;
  const selectTool = (tool, push = true, url = "") => {
    if (tool !== current.tool || !push) {
      const id = crypto.randomUUID();
      openBrowserRequest.current = {id, url};
      const next = {...current, tool, displayID:id};
      pageGeneration.current++;
      saveRoute(next, push); setCurrent(next);
    }
    setDrawer(false);
  };
  const leaveDisplay = () => {
    browserControls.current?.close();
    open(current.project, session);
    setDrawer(!openBrowserRequest.current?.url);
  };
  const exitWorkspace = () => {
    if (current.displayID) leaveDisplay();
    return deviceCommand("home");
  };
  const codeNavigation = <CodeNavigation catalog={catalog} project={project} sessions={sessions} current={session}
    creating={creating || actionBusy} onAction={chooseSessionAction} onProject={path => open(path)} onNew={() => start(project)} formatTime={displayTime}
    onSession={id => {open(project.path, id, true); setDrawer(false);}} />;
  const activeTool = workspaceTools.find(entry => entry.id === current.tool);
  const ActiveToolIcon = ["settings", "archived"].includes(current.tool) ? Settings : activeTool?.icon || Terminal;
  const settingsPage = tool => {
    browserControls.current?.close();
    const next = {tool, displayID:"", project:current.project, session:""};
    pageGeneration.current++;
    saveRoute(next, true); setCurrent(next); setDrawer(false);
  };
  const leaveSettings = () => {
    if (current.tool === "archived") settingsPage("settings");
    else { open(current.project); setDrawer(true); }
  };
  useEffect(() => {
    const openArchives = () => settingsPage("archived");
    window.addEventListener("cage-open-archives", openArchives);
    return () => window.removeEventListener("cage-open-archives", openArchives);
  }, [current.project]);
  return <main className={["mobile-app", phoneWorkspace && "phone-workspace", nativePhone && "native-phone"].filter(Boolean).join(" ")}>
    <header className="topbar workspace-topbar">
      {phoneWorkspace
        ? <button type="button" className="icon-button" aria-haspopup="dialog" aria-expanded={drawer} aria-label="展开侧栏"
          onClick={() => setDrawer(true)}><img className="brand-mark" src={cageLogo} alt="Cage" /></button>
        : <a className="icon-button" href="/" aria-label="返回工作台"><img className="brand-mark" src={cageLogo} alt="Cage" /></a>}
      {phoneWorkspace && (current.tool === "browser" || current.tool === "claude") && <div className="workspace-address-slot" ref={setAddressSlot} />}
      <div className="top-actions">{phoneWorkspace
        ? <span className="workspace-tool-icon" role="img" aria-label={activeTool?.name || "Claude Code"}><ActiveToolIcon size={19} aria-hidden="true" /></span>
        : <div className="connection-host"><Monitor size={16} /><span>{catalog?.host || "连接电脑"}</span></div>}</div>
    </header>
    <Suspense fallback={<div className="center-message" role="status">正在加载…</div>}>
    {gate ? <Notice onRetry={refreshAll}>{gate}</Notice> : !catalog
      ? <section className="page-scroll">{error ? <Notice onRetry={refreshAll}>{error}</Notice> : <Empty icon={LoaderCircle} title="正在读取项目…" />}</section>
      : current.tool === "settings" || current.tool === "archived"
        ? <section className="page-scroll mobile-session-settings" aria-label="会话设置">
          <button className="action" onClick={leaveSettings}><ArrowLeft size={17} />{current.tool === "archived" ? "返回设置" : "返回会话"}</button>
          {current.tool === "archived" ? <ArchivedSessions request={request} ready={catalog.ready}
            onRestored={id => {archivedSessions.current.delete(id); refreshAll();}} />
            : <><h1>设置</h1><button className="action secondary" onClick={() => settingsPage("archived")}><Archive size={18} />已归档会话</button></>}
        </section>
      : current.displayID
        ? <RemoteDisplay controls={browserControls} key={current.displayID} id={current.displayID} tool={current.tool} addressSlot={addressSlot}
          start={openBrowserRequest.current?.id === current.displayID} initialURL={openBrowserRequest.current?.url || ""} visible={visible}
          onBack={leaveDisplay} onReopen={() => selectTool(current.tool, false, openBrowserRequest.current?.url)} />
      : session
        ? <Chat key={session} id={session} drafts={drafts.current} ready={catalog.ready} visible={visible} refresh={refresh}
          onOpenWeb={url => selectTool("browser", true, url)} onDenied={restricted} onMissing={missingSession} onSnapshot={updateSession} onBack={phoneWorkspace ? undefined : () => open(current.project)} />
      : phoneWorkspace
        ? <div className="workspace-placeholder"><Terminal size={28} /><p>{project ? "在侧栏选择或新建会话" : "请选择远程工具"}</p></div>
        : <section className="page-scroll">{error && <Notice onRetry={refreshAll}>{error}</Notice>}{codeNavigation}</section>}
    </Suspense>
    {phoneWorkspace && <WorkspaceDrawer open={drawer} active={current.tool} name={catalog?.host || devices.devices.find(d => d.id === devices.current)?.name}
      onClose={() => setDrawer(false)} onTool={selectTool} onSettings={() => settingsPage("settings")} nativePhone={nativePhone} onExit={exitWorkspace}>
      {error && <Notice onRetry={refreshAll}>{error}</Notice>}
      {gate ? <Notice onRetry={refreshAll}>{gate}</Notice> : <ProjectTree catalog={catalog} projectPath={current.project}
        sessionID={current.tool === "code" ? session : ""} creating={creating || actionBusy} onNew={start} onAction={chooseSessionAction}
        onSession={(path,id) => {open(path,id,true); setDrawer(false);}} expanded={expanded}
        toggle={(path,next) => setExpanded(previous => new Map(previous).set(path,next))} />}
    </WorkspaceDrawer>}
    {sessionAction && <SessionActionDialog key={sessionAction.kind + sessionAction.session.id} action={sessionAction} busy={actionBusy}
      error={sessionActionError} onCancel={() => setSessionAction(null)} onSubmit={body => mutateSession(sessionAction.kind, sessionAction.session, body)}/>}
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
