import { MobilePairSettings } from "./mobile-pair-settings";
import { ArchivedSessions } from "./cli-sessions";
import { Smartphone } from "lucide-react";
import { PasswordVaultSettings } from "./password-vault";
import { KeyRound } from "lucide-react";
import { InlineSelect } from "./inline-select";
import { clientKeyboard, isRemoteClient, saveClientKeyboard } from "./client-context.mjs";
import { shortcut, usesControl } from "./platform.mjs";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Globe2,
  Clock3,
  FolderOpen,
  Check,
  LoaderCircle,
  RotateCcw,
  ArrowLeft,
  Settings,
  Palette,
  UserRound,
  UsersRound,
  Archive,
} from "lucide-react";
import { api } from "./api";
import { SafetyMessage } from "./safety-message";
import { AppearanceSettings } from "./appearance-settings";
import { NotificationSettings } from "./notification-settings";
import { ProxySettings } from "./proxy-settings";
import { ExitPolicyFields } from "./exit-policy";
import { canonicalExitPolicy } from "./safety-state.mjs";
import { EnvironmentVersions } from "./environment-versions";
import { EnvironmentStorage } from "./environment-storage";
import { EnvironmentCache } from "./environment-cache";
import { ResourceSettings } from "./resources";
import { DiagnosticSettings } from "./diagnostics.jsx";
import { MacOSLogin } from "./macos-login";
import { ScreenSharingChecks } from "./macos-screen-sharing";
import { AccountSettings } from "./account";
import { ClaudeAccountsPanel } from "./claude-accounts";
const sections = [
  ["keyboard", "通用", Settings],
  ["appearance", "外观", Palette],
  ["notifications", "通知", Bell],
  ["account", "账户", UserRound],
  ["vault", "密码保险箱", KeyRound],
  ["claude-accounts", "Claude 账号", UsersRound],
  ["archived-sessions", "已归档会话", Archive],
  ["mobile", "远程连接", Smartphone],
  ["network", "网络与代理", Globe2],
  ["region", "时区与语言", Clock3],
  ["project", "环境与恢复", RotateCcw],
];
export function SettingsPanel({
  current,
  status,
  onClose,
  onSaved,
  onConfirm,
  claudeProfiles,
  terminalTabs,
  onClaudeLogin,
  initialSection = "keyboard",
}) {
  const [localKeyboard, setLocalKeyboard] = useState(() => clientKeyboard(current.keyboard));
  const [accountDirty, setAccountDirty] = useState(false);
  const [proxyDirty, setProxyDirty] = useState(false);
  const [resourceDirty, setResourceDirty] = useState(false);
  const [draft, setDraft] = useState({ ...current }),
    [section, setSection] = useState(initialSection),
    [probe, setProbe] = useState(null),
    [probing, setProbing] = useState(false),
    [probeFailed, setProbeFailed] = useState(false),
    [error, setError] = useState(""),
    [staticDraftOffer, setStaticDraftOffer] = useState(false),
    [jobId, setJobId] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const changed =
    JSON.stringify({
      ...draft,
      browser_home_url: undefined,
      exit_policy: canonicalExitPolicy(draft.exit_policy),
    }) !==
    JSON.stringify({
      ...current,
      browser_home_url: undefined,
      exit_policy: canonicalExitPolicy(current.exit_policy),
    });
  const environmentChanged = [
    "dns_url",
    "dns_fallback_urls",
    "dns_public_fallback",
    "dns_bootstrap_urls",
    "timezone",
    "locale",
    "browser_language",
    "auto_timezone",
    "auto_language",
    "exit_policy",
  ].some((k) =>
    k === "exit_policy"
      ? JSON.stringify(canonicalExitPolicy(draft[k])) !==
        JSON.stringify(canonicalExitPolicy(current[k]))
      : Array.isArray(draft[k]) || Array.isArray(current[k])
        ? JSON.stringify(draft[k] ?? []) !== JSON.stringify(current[k] ?? [])
        : draft[k] !== current[k],
  );
  const busy =
    Boolean(status.job?.running) || Boolean(status.storage_recovery?.required) || probing || submitting || Boolean(jobId);
  // Project folders of the other guest systems are always read directly.
  const linuxGuest = !/^(windows|macos)/.test(status.guest_system || "");
  const update = (key, value) => {
    setDraft((p) => ({ ...p, [key]: value }));
    if (["dns_url", "dns_fallback_urls", "dns_public_fallback"].includes(key)) setProbe(null);
    setError("");
  };
  const close = async () => {
    if (submitting) return;
    if (status.job?.running && jobId) {
      onClose();
      return;
    }
    if (
      (!changed && !accountDirty && !proxyDirty && !resourceDirty) ||
      (await onConfirm({
        title: "放弃尚未保存的修改？",
        body: "当前环境不会改变。关闭后会丢弃这次表单修改。",
        confirm: "放弃修改",
      }))
    )
      onClose();
  };
  useEffect(() => {
    if (jobId && status.job?.id === jobId && !status.job.running) {
      setJobId("");
      if (status.job.error || status.job.canceled) {
        if (status.job.settings_saved) onSaved();
        setStaticDraftOffer(status.job.recovery === "static-ip-draft-available");
        setError(status.job.error || status.job.message);
      } else {
        setStaticDraftOffer(false);
        onSaved();
        if (!proxyDirty) onClose();
      }
    }
  }, [status.job, jobId]);
  const check = async () => {
    setProbing(true);
    setProbeFailed(false);
    setError("");
    try {
      const result = await api("/settings/probe", draft);
      setProbe(result);
      if (draft.auto_timezone)
        setDraft((previous) => ({ ...previous, timezone: result.timezone }));
      if (draft.auto_language && result.suggested_locale)
        setDraft((previous) => ({
          ...previous,
          locale: result.suggested_locale,
          browser_language: result.suggested_browser_language,
        }));
    } catch (e) {
      setError(e.message);
      setProbeFailed(true);
    } finally {
      setProbing(false);
    }
  };
  const save = async ({ saveStaticDraft = false } = {}) => {
    if (busy) return;
    if (saveStaticDraft) {
      if (
        !(await onConfirm({
          title: "离线保存待验证的静态 IP 草稿？",
          body: "仅保存静态 IP 基准，不会放行外网。待代理恢复并通过实时出口、国家与隔离检查后才允许联网。",
          confirm: "保存待验证草稿",
        }))
      )
        return;
    } else if (
      environmentChanged &&
      status.vm_running &&
      !(await onConfirm({
        title: "应用设置并重启环境？",
        body: "请先保存编辑器中的文件。当前终端会话会结束，浏览器的页面和登录状态将保留。",
        confirm: "保存并重启",
      }))
    )
      return;
    setError("");
    setStaticDraftOffer(false);
    setSubmitting(true);
    try {
      const payload = { ...draft };
      delete payload.browser_home_url;
      if (saveStaticDraft) payload.save_static_draft = true;
      const result = await api("/settings", payload);
      setJobId(result.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };
  const zones = useMemo(
    () => [
      ...new Set([
        "Etc/UTC",
        current.timezone,
        ...(Intl.supportedValuesOf?.("timeZone") || []),
      ]),
    ],
    [],
  );
  const changeSection = async id => {
    if (id !== section && accountDirty && !(await onConfirm({ title: "放弃尚未保存的修改？", body: "已保存的资料和密码保持不变。", confirm: "放弃修改" }))) return;
    if (id !== section && proxyDirty && !(await onConfirm({ title: "放弃尚未应用的代理修改？", body: "当前代理仍按已应用的链路运行。离开会丢弃这次节点选择。", confirm: "放弃修改" }))) return;
    if (id !== section && resourceDirty && !(await onConfirm({ title: "放弃资源配置修改？", body: "离开后会丢弃尚未保存的内存和 CPU 配置。", confirm: "放弃修改" }))) return;
    setSection(id);
  };
  const contentRef = useRef();
  const navRef = useRef();
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({block: "nearest", inline: "nearest"});
  }, [section]);
  const currentLoc = probe || status.location;
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement;
    document.getElementById("settings-back")?.focus();
    const dismiss = (event) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (event.type === "cage-close-modal" || event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("cage-close-modal", dismiss);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("cage-close-modal", dismiss);
      previous?.focus?.();
    };
  }, []);
  return (
    <section className="settings-page" aria-label="设置">
      <aside className="settings-sidebar">
        <button
          id="settings-back"
          className="back-to-workspace"
          onClick={close}
          aria-label="关闭设置"
        >
          <ArrowLeft size={17} />
          <span>关闭<span className="back-destination">设置</span></span>
        </button>
        <h2>设置</h2>
        <div className="compact-settings-nav">
          <InlineSelect aria-label="设置分组" filterable={false} value={section} onValueChange={changeSection}>
            {sections.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </InlineSelect>
        </div>
        <nav ref={navRef} aria-label="设置分组">
          {sections.map(([id, label, Icon]) => (
            <button
              key={id}
              className={section === id ? "selected" : ""}
              aria-current={section === id ? "page" : undefined}
              onClick={() => changeSection(id)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="settings-main">
        <div className={section === "archived-sessions" ? "settings-content settings-content--archives" : section === "claude-accounts" ? "settings-content settings-content--accounts" : section === "mobile" ? "settings-content settings-content--remote" : "settings-content"} ref={contentRef}>
          <div className="settings-sheet" data-section={section} key={section}>
          {section === "appearance" && <AppearanceSettings />}
          {section === "notifications" && <NotificationSettings />}
          {section === "archived-sessions" && <ArchivedSessions ready={status.ready && !busy} />}
          {section === "vault" && <PasswordVaultSettings onConfirm={onConfirm} onDirty={setAccountDirty} />}
          {section === "account" && <AccountSettings busy={busy} onDirty={setAccountDirty} />}
          {section === "claude-accounts" && <ClaudeAccountsPanel store={claudeProfiles} tabs={terminalTabs} onConfirm={onConfirm}
            running={status.vm_running} environmentBusy={busy} login={async (id) => {
              if (changed && !(await onConfirm({ title: "放弃尚未保存的设置并登录？",
                body: "打开登录终端会离开设置页。", confirm: "打开登录终端" }))) return;
              await onClaudeLogin(id);
              onClose();
            }} />}
          <fieldset className="settings-fields" disabled={busy && !(section === "project" && status.storage_recovery?.required)}>
            {section === "mobile" && (isRemoteClient()
              ? <section className="section-title"><h3>连接这台电脑</h3><p>切换到本机环境后即可管理手机配对码。</p></section>
              : <MobilePairSettings relay={draft.mobile_relay ?? ""} savedRelay={current.mobile_relay ?? ""} onChange={value => update("mobile_relay",value)} onConfirm={onConfirm} />)}
            {section === "network" && (
              <>
                <ProxySettings
                  onDirty={setProxyDirty}
                  status={status}
                  onConfirm={onConfirm}
                  onApplied={async () => {
                    setProbe(null);
                    const applied = await api("/settings");
                    if (JSON.stringify(canonicalExitPolicy(applied.exit_policy)) !==
                        JSON.stringify(canonicalExitPolicy(current.exit_policy))) {
                      setDraft(previous => ({ ...previous, exit_policy: applied.exit_policy }));
                    }
                    await onSaved();
                  }}
                />
                <label>
                  加密 DNS
                  <input
                    value={draft.dns_url}
                    onChange={(e) => update("dns_url", e.target.value)}
                    spellCheck="false"
                  />
                </label>
                <label>
                  备用加密 DNS（每行一个，最多 4 个）
                  <textarea
                    rows={2}
                    value={(draft.dns_fallback_urls ?? []).join("\n")}
                    onChange={(e) => update("dns_fallback_urls", e.target.value.split(/\r?\n/))}
                    spellCheck="false"
                    placeholder="https://…/dns-query"
                  />
                </label>
                <label className="toggle-row">
                  <span>
                    <strong>以上端点都不可用时改用 Google 公共 DNS（8.8.8.8）</strong>
                    <small>
                      业务 DNS、联网检查与内置核心使用同一组端点，均经所选节点发出，按顺序尝试。默认只使用上面的加密 DNS；开启公共 DNS 备用后，查询可能发给第二家服务商。
                    </small>
                  </span>
                  <input
                    role="switch"
                    type="checkbox"
                    checked={Boolean(draft.dns_public_fallback)}
                    onChange={(e) => update("dns_public_fallback", e.target.checked)}
                  />
                </label>
                <label>
                  节点域名解析（每行一个数字 IP 的 DoH，留空使用默认）
                  <textarea
                    rows={2}
                    value={(draft.dns_bootstrap_urls ?? []).join("\n")}
                    onChange={(e) => update("dns_bootstrap_urls", e.target.value.split(/\r?\n/))}
                    spellCheck="false"
                    placeholder="https://223.5.5.5/dns-query"
                  />
                </label>
                <p className="field-help">
                  经主机网络解析节点服务器域名。保存以上任一 DNS 设置后，环境重启时内置核心随之改用新设置，与业务 DNS 和联网检查保持一致。加密 DNS 或备用端点使用域名而非数字 IP 时，该域名会由这里的节点域名解析服务经主机网络解析。
                </p>
                <label className="toggle-row">
                  <span>
                    <strong>安装与工具下载兼容模式（限制 curl 最高使用 TLS 1.2）</strong>
                    <small>
                      默认关闭。仅当所选代理出口会中断 curl 的 TLS 1.3 握手、导致安装或工具下载失败时开启；不影响正常浏览与对话连接。
                    </small>
                  </span>
                  <input
                    role="switch"
                    type="checkbox"
                    checked={Boolean(draft.install_tls12_compat)}
                    onChange={(e) => update("install_tls12_compat", e.target.checked)}
                  />
                </label>
                <label className="toggle-row">
                  <span>
                    <strong>出口位置查询备用服务 ipinfo.io</strong>
                    <small>
                      默认关闭。开启后，仅当默认的五家位置服务都失败时，经所选节点把已测得的出口 IP 发给 ipinfo.io 查询国家或地区；其结果只用于国家级判断，不用于绑定或核对州、省和城市。
                    </small>
                  </span>
                  <input
                    role="switch"
                    type="checkbox"
                    checked={Boolean(draft.location_ipinfo_fallback)}
                    onChange={(e) => update("location_ipinfo_fallback", e.target.checked)}
                  />
                </label>
                <div className="probe-line">
                  <button disabled={busy} onClick={check}>
                    {probing ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <Globe2 size={15} />
                    )}
                    验证出口
                  </button>
                  <span>通过当前节点查询 IP 和位置</span>
                </div>
                {currentLoc && (
                  <div className={`location-result ${probe ? "fresh" : ""}`}>
                    <span className="result-icon">
                      <Globe2 size={19} />
                    </span>
                    <div>
                      <strong>
                        {currentLoc.country} · {currentLoc.city}
                      </strong>
                      <code>{currentLoc.ip}</code>
                      <small>
                        {currentLoc.timezone} ·{" "}
                        {new Date(currentLoc.checked_at).toLocaleTimeString(
                          "zh-CN",
                          { hour: "2-digit", minute: "2-digit" },
                        )}{" "}
                        {probe ? "验证通过" : "当前环境 · 最近检测"}
                      </small>
                    </div>
                    {probe && <Check size={18} />}
                  </div>
                )}
                <p className="footnote">
                  代理失效会关闭外网。修改后需重新验证。
                </p>
                <section className="network-exit-policy" aria-label="IP 变化规则">
                  <ExitPolicyFields
                    value={draft.exit_policy}
                    onChange={(value) => update("exit_policy", value)}
                    observation={probe}
                    onProbe={check}
                    busy={busy}
                    probing={probing}
                  />
                </section>
              </>
            )}
            {section === "region" && (
              <>
                <div className="section-title">
                  <h3>时区与语言</h3>
                  <p>系统、CLI 和浏览器共用。</p>
                </div>
                {!draft.auto_timezone && !draft.auto_language && (
                  <p className="field-help">
                    手动设置时区和语言。所有出口（含静态 IP 和不限地区）仍须验证位于中国大陆以外。
                  </p>
                )}
                <label className="toggle-row">
                  <span>
                    <strong>跟随出口 IP 的时区</strong>
                    <small>
                      启动或应用设置时重新查询，运行中的任务会保留。
                    </small>
                  </span>
                  <input
                    role="switch"
                    type="checkbox"
                    checked={draft.auto_timezone}
                    onChange={(e) => update("auto_timezone", e.target.checked)}
                  />
                </label>
                <label>
                  {draft.auto_timezone ? "将应用的时区" : "系统时区"}
                  <InlineSelect editable
                    aria-label={draft.auto_timezone ? "将应用的时区" : "系统时区"}
                    value={draft.timezone}
                    disabled={draft.auto_timezone}
                    onValueChange={(next) => update("timezone", next)}
                  >
                    {zones.map((zone) => (
                      <option key={zone} value={zone} />
                    ))}
                  </InlineSelect>
                </label>
                {draft.auto_timezone && (
                  <div className="inline-info">
                    <Clock3 size={16} />
                    <span>
                      {probe
                        ? `出口建议时区：${probe.timezone}，保存时应用。`
                        : "保存时经代理查询所在地；查询失败会保留原配置。"}
                    </span>
                    <button
                      className="text-button"
                      onClick={check}
                      disabled={busy}
                    >
                      现在检测
                    </button>
                  </div>
                )}
                <label className="toggle-row">
                  <span>
                    <strong>跟随出口地区的语言建议</strong>
                    <small>
                      启动或应用设置时更新。多语言地区使用默认语言，无法匹配时保留当前选择。
                    </small>
                  </span>
                  <input
                    role="switch"
                    type="checkbox"
                    checked={Boolean(draft.auto_language)}
                    onChange={(e) => update("auto_language", e.target.checked)}
                  />
                </label>
                {draft.auto_language && (
                  <div className="inline-info">
                    <Globe2 size={16} />
                    <span>
                      {currentLoc?.suggested_locale
                        ? `地区建议：${currentLoc.suggested_locale} / ${currentLoc.suggested_browser_language}`
                        : "检测出口后获取地区建议，也可以关闭自动并手动选择。"}
                    </span>
                    <button
                      className="text-button"
                      onClick={check}
                      disabled={busy}
                    >
                      现在检测
                    </button>
                  </div>
                )}
                <label>
                  系统语言
                  <InlineSelect
                    aria-label="系统语言"
                    value={draft.locale}
                    disabled={draft.auto_language}
                    onValueChange={(next) => update("locale", next)}
                  >
                    {[
                      ["en_US.UTF-8", "English (United States)"],
                      ["zh_CN.UTF-8", "简体中文"],
                      ["zh_TW.UTF-8", "繁體中文"],
                      ["ja_JP.UTF-8", "日本語"],
                      ["de_DE.UTF-8", "Deutsch"],
                      ["fr_FR.UTF-8", "Français"],
                    ].map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                    {![
                      "en_US.UTF-8",
                      "zh_CN.UTF-8",
                      "zh_TW.UTF-8",
                      "ja_JP.UTF-8",
                      "de_DE.UTF-8",
                      "fr_FR.UTF-8",
                    ].includes(draft.locale) && (
                      <option value={draft.locale}>{draft.locale}</option>
                    )}
                  </InlineSelect>
                </label>
                <label>
                  网页首选语言
                  <InlineSelect
                    aria-label="网页首选语言"
                    value={draft.browser_language || "en-US"}
                    disabled={draft.auto_language}
                    onValueChange={(next) => update("browser_language", next)}
                  >
                    {[
                      ["en-US", "English (United States)"],
                      ["zh-CN", "简体中文"],
                      ["zh-TW", "繁體中文"],
                      ["ja-JP", "日本語"],
                      ["de-DE", "Deutsch"],
                      ["fr-FR", "Français"],
                    ].map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                    {![
                      "en-US",
                      "zh-CN",
                      "zh-TW",
                      "ja-JP",
                      "de-DE",
                      "fr-FR",
                    ].includes(draft.browser_language || "en-US") && (
                      <option value={draft.browser_language || "en-US"}>
                        {draft.browser_language}
                      </option>
                    )}
                  </InlineSelect>
                </label>
                <p className="footnote">
                  此设置影响网页的首选语言。Cage 界面使用中文。
                </p>
              </>
            )}
            {section === "keyboard" && (
              <>
                <div className="section-title">
                  <h3>通用</h3>
                </div>
                <label>
                  时间显示格式
                  <InlineSelect inline
                    aria-label="时间显示格式"
                    value={draft.clock_12_hour ? "12" : "24"}
                    onValueChange={(next) => update("clock_12_hour", next === "12")}
                  >
                    <option value="24">24 小时制</option>
                    <option value="12">12 小时制（AM/PM）</option>
                  </InlineSelect>
                </label>
                <p className="field-help">
                  保存后立即更新底部时钟。
                </p>
                <label>
                  Claude 终端启动命令
                  <input
                    value={draft.claude_terminal_command ?? "claude"}
                    onChange={(e) => update("claude_terminal_command", e.target.value)}
                    placeholder="claude"
                    maxLength={4096}
                    spellCheck="false"
                    autoComplete="off"
                  />
                </label>
                <p className="field-help">
                  选择“Claude 终端”后，在所选项目中运行此命令，例如 claude --continue。
                  留空使用 claude；保存后仅影响新建的 Claude 终端，退出 Claude 后可继续使用 shell。
                </p>
                {typeof current.balanced_display === "boolean" && <label className="toggle-row">
                  <span>
                    <strong>优先流畅</strong>
                    <small>降低浏览器和 Claude Desktop 的清晰度，Linux 环境同时减少 Claude Desktop 的动效。下次启动环境时生效。</small>
                  </span>
                  <input type="checkbox" role="switch" checked={draft.balanced_display}
                    onChange={(event) => update("balanced_display", event.target.checked)} />
                </label>}
                {typeof current.project_file_cache === "boolean" && linuxGuest && <label className="toggle-row">
                  <span>
                    <strong>项目文件缓存</strong>
                    <small>减少读取项目文件时与本机的往返。在本机上所做的改动最多 20 秒后在环境中可见，也可以在项目栏点“刷新项目文件”立即同步。下次启动环境时生效。</small>
                  </span>
                  <input type="checkbox" role="switch" checked={draft.project_file_cache}
                    onChange={(event) => update("project_file_cache", event.target.checked)} />
                </label>}
                <h4>键盘习惯</h4>
                <div className="choice-list">
                  {[
                    [
                      "mac",
                      "Mac 快捷键",
                      "使用 ⌘ 操作网页和编辑器。Linux、Windows 客机使用对应的 Ctrl 快捷键，macOS 客机保留 Command。",
                    ],
                    [
                      "native",
                      "客机原生快捷键",
                      "按客机系统的习惯使用 Control、Command 和其他组合键。",
                    ],
                  ].map(([value, title, help]) => (
                    <label
                      className={`choice ${(isRemoteClient() ? localKeyboard : draft.keyboard) === value ? "checked" : ""}`}
                      key={value}
                    >
                      <input
                        type="radio"
                        name="keyboard"
                        value={value}
                        checked={(isRemoteClient() ? localKeyboard : draft.keyboard) === value}
                        onChange={() => {
                          if (!isRemoteClient()) { update("keyboard", value); return; }
                          try { saveClientKeyboard(value); setLocalKeyboard(value); setError(""); }
                          catch { setError("未能保存本机键盘习惯，请检查本地存储空间。"); }
                        }}
                      />
                      <span>
                        <strong>{title}</strong>
                        <small>{help}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="field-help">
                  终端使用 {usesControl ? "Ctrl+Shift+C / Ctrl+Shift+V" : "⌘C / ⌘V"} 复制粘贴；Ctrl+C 始终用于中断命令。
                  {isRemoteClient() && "键盘习惯立即生效，仅保存在当前客户端，不修改云端设置。"}
                </p>
                <h4>键盘快捷键</h4>
                <div className="shortcut-list">
                  {[
                    ["打开项目", "⌘O"],
                    ["新建网页", "⌘T"],
                    ["新建终端", "⌘⇧↵"],
                    ["地址栏", "⌘L"],
                    ["关闭当前标签", "⌘W"],
                    ["切换标签", "⌘1–9"],
                    ["设置", "⌘,"],
                  ].map(([label, key]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <kbd>{shortcut(key)}</kbd>
                    </div>
                  ))}
                </div>
              </>
            )}
            {section === "project" && (
              <>
                <div className="section-title">
                  <h3>环境与恢复</h3>
                  <p>{isRemoteClient() ? "项目位于云端，Cage 中的改动会直接保存到云端文件。" : "本机与 Cage 中的改动会双向同步。"}</p>
                </div>
                {status.local_vm_storage && !isRemoteClient() && <EnvironmentStorage status={status} onConfirm={onConfirm} />}
                <div className="setting-summary-row">
                  <span>当前项目</span>
                  <strong title={current.workspace}>
                    {current.workspace || "尚未选择项目"}
                  </strong>
                </div>
                <p className="field-help">
                  {isRemoteClient() ? "用侧栏“项目”旁的 + 添加云端文件夹。" : "用侧栏“项目”旁的 + 添加本地文件夹。"}
                </p>
                <div className="project-explanation">
                  <FolderOpen size={22} />
                  <div>
                    <strong>所有项目共用一个 Cage 环境</strong>
                    <p>
                      仅共享已打开的文件夹。主机的 Claude
                      登录、SSH 密钥和个人配置不会自动导入。下载文件可在
                      下载面板查看或另存为。
                    </p>
                  </div>
                </div>
                <p className="footnote">
                  切换项目会改变新终端和编辑器的起始目录。已有终端、网页和登录状态会保留。
                </p>
                {linuxGuest && current.browser_graphics && !status.storage_recovery?.required && (
                  <section aria-label="浏览器图形">
                    <h4>浏览器图形</h4>
                    <label>渲染后端
                      <InlineSelect aria-label="渲染后端" value={draft.browser_graphics.backend || "auto"}
                        onValueChange={value => update("browser_graphics", { ...draft.browser_graphics, backend: value === "auto" ? "" : value })}>
                        <option value="auto">自动</option>
                        <option value="gl">OpenGL</option>
                        <option value="vulkan">Vulkan</option>
                        <option value="swiftshader">软件渲染</option>
                      </InlineSelect>
                    </label>
                    {[
                      ["disable_webgl", "关闭 WebGL"],
                      ["block_canvas_read", "阻止网页读取 Canvas 图像"],
                    ].map(([key, label]) => (
                      <label key={key} className="toggle-row">
                        <span>{label}</span>
                        <input type="checkbox" role="switch" checked={Boolean(draft.browser_graphics[key])}
                          onChange={event => update("browser_graphics", { ...draft.browser_graphics, [key]: event.target.checked })} />
                      </label>
                    ))}
                    <p className="field-help">下次启动环境时应用于内置浏览器。部分网页的 3D 显示或图片导出可能受限。</p>
                  </section>
                )}
                {!status.storage_recovery?.required && <EnvironmentVersions status={status} onConfirm={onConfirm} />}
                {!status.storage_recovery?.required && <EnvironmentCache status={status} onConfirm={onConfirm} />}
                {status.guest_system === "macos" && <section aria-label="客机系统权限">
                  <h4>客机系统权限</h4>
                  <p className="field-help">在受限的客机系统设置窗口中完成授权，Cage 会自动检查并重新连接项目。</p>
                  <div className="project-recovery-actions">
                    <MacOSLogin maintenance="projects" label="文件共享权限" disabled={!status.ready || busy} />
                    <MacOSLogin maintenance="screen" label="屏幕录制权限" disabled={!status.ready || busy} />
                    <MacOSLogin maintenance="input" label="辅助功能权限" disabled={!status.ready || busy} />
                  </div>
                </section>}
                {status.guest_system === "macos" && !isRemoteClient() && <MacOSScreenSharingSettings disabled={!status.ready || busy} onError={setError} />}
                {!status.storage_recovery?.required && <ResourceSettings status={status} onConfirm={onConfirm} onDirtyChange={setResourceDirty} />}
 <DiagnosticSettings />
                {status.can_restore && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await onConfirm({
                          title: "恢复上一份配置？",
                          body: "会停止当前环境并恢复上次应用前的设置。已经结束的终端进程无法恢复。",
                          confirm: "恢复并重启",
                        })
                      ) {
                        try {
                          const result = await api("/restore", {});
                          setJobId(result.id);
                        } catch (e) {
                          setError(e.message);
                        }
                      }
                    }}
                  >
                    <RotateCcw size={14} />
                    恢复上一份配置
                  </button>
                )}
              </>
            )}
          </fieldset>
          {error && (
            <div role="alert" className="error-message">
              <SafetyMessage message={error} />
              {probeFailed && (draft.auto_timezone || draft.auto_language) && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setDraft((previous) => ({
                      ...previous,
                      auto_timezone: false,
                      auto_language: false,
                    }));
                    setProbeFailed(false);
                    setError("");
                    setSection("region");
                  }}
                >
                  手动设置时区和语言
                </button>
              )}
              {(staticDraftOffer || probeFailed) &&
                draft.exit_policy?.mode === "static" &&
                Boolean(draft.exit_policy?.ip?.trim()) && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => save({ saveStaticDraft: true })}
                  >
                    离线保存待验证的静态 IP 草稿
                  </button>
                )}
            </div>
          )}
          </div>
        </div>
        {(!["appearance", "notifications", "browser", "account", "claude-accounts", "vault", "mobile", "archived-sessions", "project"].includes(section) || changed) && (
          <footer className="settings-footer">
            {" "}
            <>
              <span className="save-note">
                {status.job?.running
                  ? status.job.message
                  : proxyDirty
                    ? "代理修改待应用，请点击「应用代理」"
                    : changed
                    ? environmentChanged && status.vm_running
                      ? "网络和系统设置需要重启"
                      : "有尚未保存的修改"
                    : "没有未保存的修改"}
              </span>
              <button onClick={close}>关闭设置</button>
              <button
                className="primary"
                disabled={!changed || busy}
                onClick={() => save()}
              >
                {busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}{" "}
                {environmentChanged && status.vm_running
                  ? "保存并重启"
                  : "保存设置"}
              </button>
            </>
          </footer>
        )}
      </div>
    </section>
  );
}

function MacOSScreenSharingSettings({ disabled, onError }) {
  const [sharingBusy, setSharingBusy] = useState("");
  const [sharingStatus, setSharingStatus] = useState(null);
  async function run(action) {
    setSharingBusy(action);
    onError("");
    try {
      const result = await api("/environment/macos-screen-sharing", { action });
      if (action !== "open") setSharingStatus(result);
    } catch (error) {
      onError(error.message);
    } finally {
      setSharingBusy("");
    }
  }
  return (
    <section aria-label="客机屏幕共享">
      <h4>客机屏幕共享</h4>
      <p className="field-help">日常「打开客机屏幕共享」只在本机建立 SSH 环回转发，不给客机增加外网出口，因此不要求先断网。首次安装会在置备阶段启用服务，并在系统授权引导中检查是否真正可用；macOS 26 还需在「系统设置 → 通用 → 共享」中手动打开一次。之后若要重新启用服务或再次打开该设置页，必须先暂停 Cage 的外网连接。</p>
      <ScreenSharingChecks status={sharingStatus} />
      <div className="project-recovery-actions">
        <button
          type="button"
          className="text-button"
          disabled={disabled || Boolean(sharingBusy)}
          onClick={() => run("check")}
        >
          {sharingBusy === "check" ? <LoaderCircle size={14} /> : null}
          检查屏幕共享状态
        </button>
        <button
          type="button"
          className="text-button"
          disabled={disabled || Boolean(sharingBusy)}
          onClick={() => run("open")}
        >
          {sharingBusy === "open" ? <LoaderCircle size={14} /> : null}
          打开客机屏幕共享
        </button>
        <button
          type="button"
          className="text-button"
          disabled={disabled || Boolean(sharingBusy)}
          onClick={() => run("enable")}
        >
          {sharingBusy === "enable" ? <LoaderCircle size={14} /> : null}
          重新启用屏幕共享服务
        </button>
        <MacOSLogin maintenance="sharing" label="打开屏幕共享设置" disabled={disabled || Boolean(sharingBusy)} />
      </div>
    </section>
  );
}
