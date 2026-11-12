import { SearchField } from "./search-field";
import { isWindows, shortcut } from "./platform.mjs";
import { nativeAvailable } from "./api";
import React, { useEffect, useRef, useState } from "react";
import {
  CircleAlert,
  ExternalLink,
  Folder,
  FolderOpen,
  Globe2,
  SquarePen,
  Code2,
  Monitor,
  Network,
  MessageCircle,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Settings,
  Server,
  SquareTerminal,
} from "lucide-react";
import logo from "./logo.png";
import { projectName } from "./workspace-state.mjs";
import { WorkspaceTabs } from "./workspace-tabs";
import { projectSessionRows, sessionKey } from "./session-order.mjs";
import { AccountMenu } from "./account";
import { useSSHNavigation } from "./remote-hosts";
import { GuestSystemIcon } from "./guest-system-icon";

export function WorkspaceSidebar({
  workspace,
  guestSystem,
  projects,
  tabs,
  sessions = [],
  sessionError,
  sessionRefreshing,
  onSessionRefresh,
  onSessionOpen,
  openingSession,
  sessionOpenError,
  onSessionArchive,
  onSessionPin,
  onSessionRename,
  saved,
  active,
  home,
  sidebarCollapsed,
  busy,
  ready,
  running,
  onHome,
  onOpenProject,
  onProjectSelect,
  onSelect,
  onClose,
  onRename,
  onPin,
  onSessionReorder,
  splitDrag,
  onNewTerminal,
  terminalMenuAt,
  onBrowser,
  onTailscale,
  downloadAction,
  onClaudeWeb,
  onClaudeDesktop,
  desktopOpen,
  onEditor,
  onSettings,
  onAccountConfirm,
  onAccountStatus,
  onCollapse,
  updateAction,
}) {
  const ssh = useSSHNavigation();
  const [collapsed, setCollapsed] = useState({});
  const [query, setQuery] = useState("");
  const compactHeader = isWindows && nativeAvailable();
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("cage-sidebar-width"));
    return saved > 0 ? Math.min(420, Math.max(192, saved)) : 244;
  });
  const dragOffset = useRef(null);
  const previousCollapsed = useRef(sidebarCollapsed);
  useEffect(() => {
    if (sidebarCollapsed === previousCollapsed.current) return;
    previousCollapsed.current = sidebarCollapsed;
    const controls = document.querySelectorAll('button[aria-controls="workspace-sidebar"]');
    const visible = [...controls].find(button => !button.closest("[inert]") && button.getClientRects().length);
    visible?.focus({ preventScroll: true });
  }, [sidebarCollapsed]);
  const needle = query?.trim().toLocaleLowerCase() || "";
  const matches = text => String(text || "").toLocaleLowerCase().includes(needle);
  const resize = value => {
    const next = Math.round(Math.max(192, Math.min(420, window.innerWidth - 200, value)));
    setWidth(next);
    return next;
  };
  const saveWidth = value => localStorage.setItem("cage-sidebar-width", String(value));
  const sessionBaseline = useRef(new Map());
  const activeWorkspace = tabs.find((tab) => tab.id === active)?.workspace;
  useEffect(() => {
    if (activeWorkspace)
      setCollapsed((previous) => ({ ...previous, [activeWorkspace]: false }));
  }, [active, activeWorkspace]);
  if (ssh?.expanded) return null;
  const modes = (
    <div className="workspace-modes" aria-label="工作模式">
      <button aria-pressed={desktopOpen} disabled={!running || busy} onClick={onClaudeDesktop} aria-label="Claude Desktop" title="安装或打开 Claude Desktop">{compactHeader && guestSystem ? <GuestSystemIcon system={guestSystem} /> : <Monitor size={15} />}<span><span className="mode-prefix">Claude </span>Desktop</span></button>
      <button aria-pressed={!desktopOpen} onClick={onHome} aria-label="Code" title="Code"><Code2 size={15} /><span className="mode-label">Code</span></button>
    </div>
  );
  return (
    <aside id="workspace-sidebar" className={`workspace-sidebar${compactHeader ? " native-sidebar" : ""}`} aria-label="项目与终端" inert={sidebarCollapsed || undefined}
      style={{ "--expanded-sidebar": width + "px" }}>
      <div className="sidebar-top">
        {compactHeader ? modes : <span className="sidebar-brand">
          <img className="brand-logo" src={logo} alt="" />
          Cage
          <GuestSystemIcon system={guestSystem} />
        </span>}
        <button
          className="icon-button"
          onClick={onCollapse}
          aria-controls="workspace-sidebar" aria-expanded="true"
          aria-label="收起侧栏"
          title="收起侧栏"
        >
          <PanelLeftClose size={17} />
        </button>
      </div>
      {!compactHeader && modes}
      <div className="sidebar-content">
      <nav className="sidebar-navigation" aria-label="主导航">
        <button
          className={`sidebar-link ${home ? "selected" : ""}`}
          onClick={onHome}
        >
          <SquarePen size={17} />
          {ready ? "新建对话" : "工作台"}
        </button>
        <SearchField label="搜索项目与会话" placeholder="搜索项目或会话" value={query} onValueChange={setQuery} />
        <button
          className={`sidebar-link ${!desktopOpen && !home && tabs.some((tab) => tab.id === active && tab.kind !== "terminal") ? "selected" : ""}`}
          onClick={onBrowser}
          disabled={!ready || busy}
          aria-label="打开浏览器"
          title="打开浏览器"
        >
          <Globe2 size={17} />
          浏览器
        </button>
        <button className="sidebar-link" onClick={onTailscale} aria-label="打开 Tailscale"><Network size={17} />Tailscale</button>
        {ssh && <button id="open-ssh-sidebar" aria-controls="ssh-hosts" className="sidebar-link ssh-navigation" onClick={ssh.open} aria-label="SSH 主机"><Server size={17} />SSH</button>}
        <div className="claude-shortcuts">
          <button className="sidebar-link" onClick={onClaudeWeb} disabled={!ready || busy} title="在 Cage 浏览器打开 claude.ai"><MessageCircle size={17} />claude.ai</button>

        </div>
        {downloadAction}
      </nav>
      <div className="sidebar-scroll">
        <div className="sidebar-section-heading">
          <span>项目</span>
          <button
            className="icon-button"
            onClick={() => onOpenProject()}
            aria-label="添加项目"
            title="添加项目"
            disabled={busy}
          >
            <Plus size={15} />
          </button>
        </div>
        {sessionError && (
          <div className="sidebar-session-error">
            <div role="alert">
              <div className="sidebar-session-error-heading">
                <CircleAlert size={16} aria-hidden="true" />
                <strong>会话列表暂未更新</strong>
              </div>
              <p>{sessionError}</p>
            </div>
            <button
              onClick={onSessionRefresh}
              disabled={sessionRefreshing || busy || !running}
              aria-busy={sessionRefreshing || undefined}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {sessionRefreshing ? "正在读取…" : "重新读取会话"}
            </button>
          </div>
        )}
        {projects.map((path) => {
          const project = projectName(path);
          const ordered = projectSessionRows(tabs.filter(tab => tab.kind === "terminal" && tab.workspace === path),
            sessions.filter(session => session.workspace === path), saved, saved.sessionOrder?.[path], sessionBaseline.current);
          const rows = needle && !matches(path) && !matches(project)
            ? ordered.filter(row => matches(saved[row.id]?.title) || matches(row.title) || matches(row.historySession?.title))
            : ordered;
          if (needle && !matches(path) && !matches(project) && !rows.length) return null;
          const rowMetadata = { ...saved };
          for (const row of rows) rowMetadata[row.id] = { ...saved[row.id], pinned: row.sessionPinned };
          const expanded = Boolean(needle) || !collapsed[path];
          return (
            <section
              className="sidebar-project"
              key={path}
              aria-label={`项目 ${project}`}
            >
              <div
                className={`project-heading ${workspace === path ? "current-project" : ""}`}
              >
                <button
                  className="project-disclosure"
                  title={path}
                  aria-expanded={expanded}
                  onClick={() => {
                    setCollapsed((previous) => ({
                      ...previous,
                      [path]: expanded,
                    }));
                    onProjectSelect(path);
                  }}
                >
                  {expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
                  <span>{project}</span>
                </button>
                <button
                  className="icon-button"
                  aria-label={`打开 ${project} 的编辑器`}
                  title="在 code-server 中打开项目目录"
                  disabled={!ready || busy}
                  onClick={() => onEditor(path)}
                >
                  <ExternalLink size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`在 ${project} 新建终端`}
                  title="新建终端"
                  aria-haspopup="menu"
                  data-terminal-location={path}
                  disabled={!running || busy}
                  onClick={(event) => {
                    setCollapsed((previous) => ({
                      ...previous,
                      [path]: false,
                    }));
                    onNewTerminal(path, event.currentTarget);
                  }}
                >
                  <SquareTerminal size={15} />
                </button>
              </div>
              {terminalMenuAt(path)}
              <div
                className={`project-children ${expanded ? "expanded" : ""}`}
                inert={!expanded}
              >
                <div>
                  {!!rows.length && (
                    <WorkspaceTabs
                      tabs={rows}
                      saved={rowMetadata}
                      openingSession={openingSession}
                      sessionOpenError={sessionOpenError}
                      active={home || desktopOpen ? "" : active}
                      label={`${project} 的终端`}
                      busy={busy}
                      ready={ready}
                      onSelect={(id, ...args) => {
                        const row = rows.find(row => row.id === id);
                        if (row?.historySession) onSessionOpen(row.historySession);
                        else onSelect(id, ...args);
                      }}
                      onClose={(row, anchor) => row.historySession ? onSessionArchive(row.historySession, anchor) : onClose(row, anchor)}
                      onRename={row => row.historySession ? onSessionRename(row.historySession) : onRename(row)}
                      onPin={id => {
                        const row = rows.find(row => row.id === id);
                        if (row?.historySession) onSessionPin(row.historySession);
                        else onPin(id);
                      }}
                      onReorder={(from, to) => {
                        const targetIndex = ordered.findIndex(row => row.id === to);
                        const order = ordered.map(row => row.id).filter(id => id !== from);
                        order.splice(targetIndex, 0, from);
                        onSessionReorder(path, order.map(id => sessionKey(ordered.find(row => row.id === id))));
                      }}
                      splitDrag={splitDrag}
                    />
                  )}
                  {!rows.length && !running && (
                    <p className="sidebar-empty">启动后可新建终端</p>
                  )}
                </div>
              </div>
            </section>
          );
        })}
        {needle && <p className="sidebar-search-empty">没有匹配的项目或会话</p>}
        {!projects.length && !needle && (
          <p className="sidebar-empty">打开本地文件夹开始工作</p>
        )}
      </div>
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-footer-actions">
          <AccountMenu onSettings={onSettings} onConfirm={onAccountConfirm} onStatus={onAccountStatus} busy={busy} />
          <button className="icon-button" aria-label="设置" title={shortcut("设置 ⌘,")} onClick={() => onSettings("keyboard")}><Settings size={17} /></button>
          {!sidebarCollapsed && updateAction}
        </div>
      </div>
      <div className="sidebar-resizer" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical"
        aria-valuemin={192} aria-valuemax={420} aria-valuenow={width} tabIndex={0}
        onPointerDown={event => {
          if (event.button !== 0) return;
          dragOffset.current = event.clientX - event.currentTarget.parentElement.getBoundingClientRect().width;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => { if (dragOffset.current !== null) resize(event.clientX - dragOffset.current); }}
        onLostPointerCapture={() => { dragOffset.current = null; saveWidth(width); }}
        onDoubleClick={() => saveWidth(resize(244))}
        onKeyDown={event => {
          const targets = { ArrowLeft: width - 8, ArrowRight: width + 8, Home: 192, End: 420 };
          if (event.key in targets) { event.preventDefault(); saveWidth(resize(targets[event.key])); }
        }} />
    </aside>
  );
}
