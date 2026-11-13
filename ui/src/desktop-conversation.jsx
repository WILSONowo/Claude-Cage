import React, { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Folder, LoaderCircle } from "lucide-react";
import { api } from "./api";
import { projectName } from "./workspace-state.mjs";

const Chat = lazy(() => import("./mobile-cli/chat"));
const ignoreSnapshot = () => {};

export function HomeComposer({ workspace, hidden, disabled, drafts, onChooseProject, onCreated }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(new Map());
  const controller = useRef(null);
  useLayoutEffect(() => {
    setError("");
    setSending(false);
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [workspace]);

  const submit = async event => {
    event.preventDefault();
    if (controller.current || disabled || !workspace || !text.trim()) return;
    setSending(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    const options = { signal: abort.signal };
    // A lost response may already have created the session or accepted the message.
    const body = text.trim();
    const previous = pending.current.get(workspace);
    const id = previous?.id ?? crypto.randomUUID();
    const request_id = previous?.body === body ? previous.request_id : crypto.randomUUID();
    pending.current.set(workspace, { id, body, request_id });
    try {
      const session = await api("/mobile/cli/sessions", { id, workspace }, undefined, {}, options);
      if (abort.signal.aborted) return;
      const message = { text: body, request_id };
      if (session.can_send === false && session.terminal_available) {
        drafts.set(id, { text, pending: message });
        onCreated(id);
        return;
      }
      try {
        await api("/mobile/cli/sessions/" + id + "/messages", message, undefined, {}, options);
      } catch (cause) {
        if (abort.signal.aborted) return;
        // The shared conversation can recover a lost receipt with the same request ID.
        if (cause.status && cause.status < 500) throw cause;
        drafts.set(id, { text, pending: message });
      }
      if (!abort.signal.aborted) onCreated(id);
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause.message);
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setSending(false);
      }
    }
  };
  return <form hidden={hidden} className="home-composer" onSubmit={submit}>
    <textarea aria-label="消息" placeholder="给 Claude Code 发消息…" rows={2} value={text}
      disabled={disabled || sending} onChange={event => setText(event.target.value)}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          event.currentTarget.form.requestSubmit();
        }
      }} />
    <div className="composer-tools">
      <button type="button" className="composer-project" aria-haspopup="dialog"
        aria-label={workspace ? `选择项目文件夹，当前为 ${projectName(workspace)}` : "选择项目文件夹"}
        title={workspace || "选择项目文件夹"} disabled={disabled || sending}
        onClick={onChooseProject}>
        <Folder size={16} /><span>{workspace ? projectName(workspace) : "选择文件夹"}</span><ChevronDown size={13} />
      </button>
      <button className="composer-send" title="发送" aria-label="发送" disabled={disabled || sending || !workspace || !text.trim()}>
        {sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} />}
      </button>
    </div>
    {error && <p role="alert">{error}</p>}
  </form>;
}

export function DesktopConversation({ id, drafts, ready, visible, onBack, onOpenWeb }) {
  const [notice, setNotice] = useState("");
  const missing = useCallback(() => setNotice("这段会话已归档或移除。"), []);
  const denied = useCallback(error => setNotice(error.message), []);
  return <div className="desktop-conversation">
    {notice ? <div role="alert">{notice} <button onClick={onBack}>返回工作台</button></div> :
      <Suspense fallback={<p role="status">正在打开对话…</p>}>
        <Chat id={id} drafts={drafts} ready={ready} visible={visible} onBack={onBack}
          onOpenWeb={onOpenWeb} onDenied={denied} onMissing={missing} onSnapshot={ignoreSnapshot} />
      </Suspense>}
  </div>;
}
