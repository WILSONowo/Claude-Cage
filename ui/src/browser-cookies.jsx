import { SearchField } from "./search-field";
import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "./api";
import { InlineSelect } from "./inline-select";

import { cookieEditable, cookieForm, cookieFromForm, newCookieForm, siteHostname } from "./browser-cookie-form.mjs";

// The value field is masked until shown and is never logged; the form is
// discarded on close so the value does not outlive the editor.
function CookieEditor({ editor, busy, onChange, onSave, onCancel }) {
  const [revealed, setRevealed] = useState(false);
  const { form } = editor;
  const field = (name, label, extra = {}) => <label>{label}<input value={form[name]} disabled={busy} spellCheck={false}
    autoComplete="off" autoCapitalize="off" onChange={event => onChange({ ...form, [name]: event.target.value })} {...extra} /></label>;
  const check = (name, label) => <label className="cookie-check"><input type="checkbox" checked={form[name]} disabled={busy}
    onChange={event => onChange({ ...form, [name]: event.target.checked })} />{label}</label>;
  return <form className="cookie-editor" aria-label={editor.key ? "编辑 Cookie" : "新增 Cookie"}
    onSubmit={event => { event.preventDefault(); onSave(); }}>
    <strong>{editor.key ? "编辑 Cookie" : "新增 Cookie"}</strong>
    {field("name", "名称", { required: true, maxLength: 4096, autoFocus: true })}
    <label>{"值"}<textarea className={revealed ? "" : "cookie-secret"} value={form.value} disabled={busy} rows={2}
      spellCheck={false} autoComplete="off" autoCapitalize="off" maxLength={4096} data-sensitive="true"
      onChange={event => onChange({ ...form, value: event.target.value })} /></label>
    <label className="cookie-check"><input type="checkbox" checked={revealed} onChange={event => setRevealed(event.target.checked)} />{"显示值"}</label>
    {field("domain", "域名", { required: true, maxLength: 254 })}
    <p className="cookie-editor-note">{"以“.”开头时包含子域名，否则仅限该主机名。"}</p>
    {field("path", "路径", { required: true, maxLength: 1024 })}
    <div className="cookie-editor-row">{check("secure", "Secure")}{check("httpOnly", "HttpOnly")}
      <span>SameSite<InlineSelect inline aria-label="SameSite" value={form.sameSite} disabled={busy} onValueChange={sameSite => onChange({ ...form, sameSite })}>
        <option value="">{"未指定"}</option><option value="Lax">Lax</option><option value="Strict">Strict</option><option value="None">None</option>
      </InlineSelect></span></div>
    <div className="cookie-editor-row">{check("session", "会话结束时过期")}
      {!form.session && field("expires", "过期时间", { type: "datetime-local", required: true })}</div>
    <div className="cookie-editor-row"><button type="submit" disabled={busy}>{"保存"}</button>
      <button type="button" disabled={busy} onClick={onCancel}>{"取消"}</button></div>
  </form>;
}

export function BrowserCookies({ tab, onClose, autoFocus = true }) {
  const [scope, setScope] = useState(/^https?:/.test(tab.url) ? "site" : "all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState(null);
  const [value, setValue] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [editor, setEditor] = useState(null);
  const hostname = siteHostname(tab.url);
  const generation = useRef(0), search = useRef(null), operation = useRef(false);
  useEffect(() => { if (autoFocus) search.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    const version = ++generation.current;
    setEditor(null); setLoading(true); setData(null); setValue(null); setError(""); setConfirmClear(false);
    api("/browser/cookies", { id: tab.id, url: tab.url, mode: "list", scope, query, page })
      .then(result => { if (version === generation.current) setData(result); })
      .catch(error => { if (version === generation.current) setError(error.message); })
      .finally(() => { if (version === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [tab.id, tab.url, scope, query, page, revision]);
  const run = async (mode, cookieKey, extra = {}, edit = null) => {
    if (operation.current || loading) return;
    operation.current = true; setBusy(true); setError("");
    const version = generation.current;
    try {
      const result = await api("/browser/cookies", { id: tab.id, url: tab.url, mode, scope, query, page, cookieKey, ...extra });
      if (version !== generation.current) return;
      if (mode === "details" && edit) { setValue(null); setEditor({ key: cookieKey, form: cookieForm(edit, result.value) }); }
      else if (mode === "details") setValue({ key: cookieKey, value: result.value });
      else { setEditor(null); setData(result); setValue(null); setConfirmClear(false); }
    } catch (error) {
      if (version === generation.current) setError(error.message);
    } finally { operation.current = false; setBusy(false); }
  };
  return <section className="browser-cookies" aria-label="Cookie 管理" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); if (editor) setEditor(null); else onClose(); }
  }}>
    <div className="cookie-heading">
      <button className="icon-button" aria-label="关闭 Cookie 管理" onClick={onClose}><ArrowLeft size={15} /></button>
      <strong>Cookie 管理</strong><span>{tab.incognito ? "无痕会话" : "普通会话"}</span>
      <button className="icon-button" aria-label="刷新 Cookie" disabled={busy || loading}
        onClick={() => setRevision(revision + 1)}><RefreshCw size={15} /></button>
    </div>
    <div className="cookie-toolbar">
      <InlineSelect aria-label="Cookie 网站范围" value={scope} disabled={busy} onValueChange={next => { setScope(next); setPage(0); }}>
        <option value="site" disabled={!/^https?:/.test(tab.url)}>当前网站</option><option value="all">所有网站</option>
      </InlineSelect>
      <SearchField inputRef={search} label="搜索 Cookie" placeholder="网站或 Cookie 名称" maxLength={200}
        value={query} disabled={busy} onValueChange={next => { setQuery(next); setPage(0); }} />
      <button disabled={busy || loading || !data || !hostname} onClick={() => { setValue(null); setEditor({ form: newCookieForm(tab.url) }); }}><Plus size={14} />新增 Cookie</button>
      <button disabled={busy || loading || !data} onClick={() => setConfirmClear(!confirmClear)}>
        <Trash2 size={14} />清空{scope === "site" ? "当前网站" : "所有网站"}
      </button>
    </div>
    {confirmClear && <div className="cookie-confirm" role="alert">
      <span>清空{scope === "site" ? data?.hostname : "此" + (tab.incognito ? "无痕" : "普通") + "会话所有网站"}的 Cookie？清空包括未匹配搜索的 Cookie，网站可能要求重新登录。</span>
      <button disabled={busy} onClick={() => run("clear")}>确认清空</button>
      <button disabled={busy} onClick={() => setConfirmClear(false)}>取消</button>
    </div>}
    {editor && <CookieEditor key={editor.key || "new"} editor={editor} busy={busy} onChange={form => setEditor({ ...editor, form })}
      onCancel={() => setEditor(null)} onSave={() => run("set", editor.key || undefined, { cookie: cookieFromForm(editor.form) })} />}
    {error && <p className="cookie-error" role="alert">{error}</p>}
    <div className="cookie-list" aria-busy={busy || loading}>
      {loading ? <p>正在读取 Cookie…</p> : data?.cookies.length === 0 ? <p>没有匹配的 Cookie。</p> : data?.cookies.map(cookie =>
        <article className="cookie-record" key={cookie.key}>
          <div className="cookie-record-heading"><strong>{cookie.name || "（空名称）"}</strong>
            <button disabled={busy} onClick={() => value?.key === cookie.key ? setValue(null) : run("details", cookie.key)}>
              {value?.key === cookie.key ? "隐藏值" : "查看值"}</button>
            <button disabled={busy || !cookieEditable(cookie, hostname)} aria-label={`编辑 Cookie ${cookie.name}`} onClick={() => run("details", cookie.key, {}, cookie)}><Pencil size={14} /></button>
            <button disabled={busy || cookie.partitionKeyOpaque} aria-label={`删除 Cookie ${cookie.name}`}
              title={cookie.partitionKeyOpaque ? "此分区 Cookie 需要清空所有网站" : "删除此 Cookie"}
              onClick={() => run("delete", cookie.key)}><Trash2 size={14} /></button></div>
          <div className="cookie-metadata">{cookie.domain} · 路径 {cookie.path} · {cookie.size} B</div>
          <div className="cookie-metadata">{cookie.session ? "会话结束时过期" : `过期：${new Date(cookie.expires * 1000).toLocaleString()}`}
            {cookie.secure && " · Secure"}{cookie.httpOnly && " · HttpOnly"}{cookie.sameSite && ` · SameSite=${cookie.sameSite}`}
            {(cookie.partitionKey || cookie.partitionKeyOpaque) && ` · 分区：${cookie.partitionKey?.topLevelSite || "不透明"}`}</div>
          {value?.key === cookie.key && <pre className="cookie-value">{value.value || "（空值）"}</pre>}
        </article>)}
    </div>
    {data && <div className="cookie-pagination"><span>共 {data.total} 条 · 第 {data.page + 1} 页</span>
      <button disabled={busy || loading || data.page === 0} onClick={() => setPage(data.page - 1)}>上一页</button>
      <button disabled={busy || loading || (data.page + 1) * 50 >= data.total} onClick={() => setPage(data.page + 1)}>下一页</button>
    </div>}
  </section>;
}
