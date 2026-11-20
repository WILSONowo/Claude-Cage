import React, { useEffect, useRef, useState } from "react";
import { api, native } from "./api";
import "./guest-system-picker.css";

const names = { "debian-12": "Debian 12", "debian-13": "Debian 13", "ubuntu-22.04": "Ubuntu 22.04", "ubuntu-24.04": "Ubuntu 24.04", macos: "macOS", "windows-11": "Windows 11" };
const editions = { Professional: "专业版", ProfessionalN: "专业版 N", Enterprise: "企业版", EnterpriseN: "企业版 N", Education: "教育版", EducationN: "教育版 N", Core: "家庭版", CoreSingleLanguage: "家庭单语言版" };
const languages = { "zh-CN": "简体中文", "zh-TW": "繁体中文", "en-US": "英语（美国）" };

export function HostCloneSummary({ pending, onChange }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    api("/environment/guest-systems/clone").then((next) => {
      if (!active) return;
      setResult(next);
      onChange((current) => current?.clone ? { ...current, clone_key: next.key, clone_ready: next.enough_space } : current);
    }).catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [attempt, onChange]);
  if (error) return <div className="guest-install-fields" role="alert"><small>{error}</small>
    <button type="button" onClick={() => { setError(""); retry((value) => value + 1); }}>重新检测并匹配</button></div>;
  if (!result) return <small className="guest-install-fields" role="status">正在检测本机系统版本并匹配官方镜像…</small>;
  const plan = result.plan;
  const host = plan.host;
  const download = result.download_bytes > 0 ? `${(result.download_bytes / 1e9).toFixed(2)} GB` : "";
  const source = host.system === "macos" ? "Apple" : host.system === "windows-11" ? "微软" : "发行版官方源";
  const cached = Boolean(plan.path || result.download_bytes === 0 && plan.bytes > 0);
  return <div className="guest-install-fields host-clone-summary" aria-live="polite">
    <strong>将安装：{names[host.system]} {host.system === "windows-11" ? `${host.version} · ${editions[host.edition] || host.edition} · ${languages[host.language] || host.language}` : host.system === "macos" ? host.version : ""}</strong>
    <small>{pending ? "沿用首次选择的系统镜像，继续安装独立客机。" : "官方镜像按本机系统版本匹配，安装到独立客机。"}</small>
    {host.build && <small>{pending ? "首次检测的本机构建号" : "本机构建号"} {host.build} · 镜像构建号 {plan.build}</small>}
    {host.system === "windows-11" && host.build !== plan.build && <small>Windows 的发行版本、版本类型和语言与本机一致，补丁版本有所不同。</small>}
    <small>本机的应用、个人文件和登录状态不会复制；客机中的工具、账户和文件会持续保存。</small>
    <small>{cached ? "已找到匹配的本地镜像，校验后直接使用，无需重新下载系统镜像。" : `从 ${source} 下载官方系统镜像，${download ? `预计还需下载 ${download}` : "下载大小将在连接后显示"}。`}</small>
    <small>{result.installation_started ? "继续使用原虚拟磁盘，保留已有安装进度。" : `至少需要 ${result.minimum_free_gib} GiB 可用空间，虚拟磁盘按实际使用增长。`}浏览器、编辑器等组件按需下载。</small>
    {!result.enough_space && <small role="alert">当前可用 {result.free_gib} GiB，请在存储设置中选择空间充足的位置，再重新检查。</small>}
    {!pending && <button type="button" onClick={() => {
      setResult(null);
      onChange((current) => current?.clone ? { ...current, clone_key: "", clone_ready: false } : current);
      retry((value) => value + 1);
    }}>重新检测并匹配</button>}
  </div>;
}

export function guestSystemChoice(view) {
  if (!view.fresh && !view.pending) return null;
  const pending = view.pending;
  return { guest_system: pending?.system || "debian-13", media: pending?.media || "",
    sha256: pending?.sha256 || "", editor_terms: Boolean(pending?.editor_terms),
    clone: Boolean(pending?.source && !pending?.source_kind), clone_key: "", clone_ready: false,
    activate: view.activate, pending: Boolean(pending) };
}

export function guestStartOptions(choice) {
  if (!choice) return {};
  if (choice.guest_system === "debian-13" && !choice.clone) return { guest_system: choice.guest_system };
  return { guest_system: choice.guest_system, media: choice.media, sha256: choice.sha256,
    clone_key: choice.clone_key, editor_terms: choice.editor_terms };
}

export function GuestSystemPicker({ system, onChange, preserveOnUnmount = false, deferMatch = false }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  const activated = useRef(false);
  useEffect(() => {
    if (!system?.activate || activated.current) return;
    activated.current = true;
    api("/environment/guest-systems/activate",{}).then(() => native("reconnect")).catch(e => setError(e.message));
  }, [system?.activate]);
  useEffect(() => {
    let active = true;
    setError("");
    api("/environment/guest-systems").then((next) => {
      if (!active) return;
      setView(next);
      onChange(guestSystemChoice(next));
    }).catch((e) => {
      if (!active) return;
      if (e.status === 403 || e.status === 404) onChange(null);
      else setError(e.message);
    });
    return () => { active = false; if (!preserveOnUnmount) onChange(undefined); };
  }, [onChange, attempt, preserveOnUnmount]);
  if (!view || !system) return error ? <div className="guest-system-picker"><span role="alert">{error}</span>
    <button type="button" onClick={() => retry((n) => n + 1)}>重新检查安装选项</button></div> : null;
  const os = system.guest_system;
  return (
    <div className="guest-system-picker">
      <span>客机系统</span>
      <strong>{names[os] || os}</strong>
      {system.pending && !system.activate && <small>继续原有环境的安装。</small>}
      {system.clone && !system.activate && !deferMatch && <HostCloneSummary pending onChange={onChange} />}
      {view.reselect && <button type="button" className="guest-install-fields" onClick={async () => {
        try {
          await api("/environment/guest-systems", { id: view.pending.id }, "DELETE");
          const next = await api("/environment/guest-systems");
          setView(next);
          onChange(guestSystemChoice(next));
        } catch (e) { setError(e.message); }
      }}>取消未开始的安装，改用 Debian 13</button>}
      {system.activate && <small className="guest-install-fields">此环境已安装，可直接使用。</small>}
      {error && <p role="alert" className="guest-install-fields">{error}</p>}
    </div>
  );
}

export function validGuestChoice(value) {
  if (value?.clone && !value.activate) return Boolean(value.clone_key && value.clone_ready && (value.guest_system !== "windows-11" || value.editor_terms));
  if (!value || value.activate || value.guest_system === "debian-13" || value.guest_system === "ubuntu-22.04") return true;
  if (value.guest_system === "macos") return true;
  return value.media && /^[a-f\d]{64}$/i.test(value.sha256) && value.editor_terms;
}
