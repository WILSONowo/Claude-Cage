import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, LoaderCircle, Square, Terminal } from "lucide-react";
import { accessDenied, request, sessionPath } from "./transport.mjs";
import { recoverPendingMessage, retryableSessionError, sessionFailureMessage, sessionRetryDelay, sessionRetryLimit } from "./session-recovery.mjs";
import { SessionAccount } from "../session-account";
import { MessageBody, ToolActivity, TranscriptContext } from "./transcript";
import { Notice, Empty } from "./feedback";

const labels = {
	queued: "消息已送达",
  running: "正在运行", stopping: "正在停止", completed: "已完成",
  failed: "运行失败", stopped: "已停止", interrupted: "运行中断",
};
const active = (status) => status === "running" || status === "stopping" || status === "queued";
function Status({ value, awaitingApproval }) {
  const tone = active(value) ? "live" : value === "failed" || value === "interrupted" ? "bad" : "";
  return <span className={"status-label " + tone} role="status"><i className="status-dot" />{awaitingApproval ? "等待审批" : labels[value] || "就绪"}</span>;
}
export default function Chat({ id, drafts, ready, visible, refresh, onOpenWeb, onDenied, onMissing, onSnapshot, onBack }) {
  const [session, setSession] = useState(null);
  const [readError, setReadError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [actionError, setActionError] = useState("");
  const [readProgress, setReadProgress] = useState("");
  const [connectionProgress, setConnectionProgress] = useState("");
  const [sendProgress, setSendProgress] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(() => drafts.get(id)?.text || "");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(() => !!drafts.get(id)?.pending);
  const [reload, setReload] = useState(0);
  const [approvalFeedback, setApprovalFeedback] = useState(null);
  const checkApproval = useRef(null);
  const readFailures = useRef(0);
  const live = useRef(true);
  const latest = useRef(null);
  const submission = useRef(drafts.get(id)?.pending || null);
  const actionBusy = useRef(false);
  const transcript = useRef(null);
  const transcriptContext = useMemo(() => ({sessionID:id, openWeb:onOpenWeb}), [id, onOpenWeb]);
  const composerInput = useRef(null);
  const follow = useRef(true);
  const last = session?.turns?.at(-1);
  const running = active(last?.status);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const accept = useCallback((snapshot, expectedGeneration) => {
    if (!live.current || snapshot?.id !== id) return;
    const current = latest.current;
    if (current && snapshot.generation !== current.generation && expectedGeneration !== current.generation) return;
    if (submission.current && (snapshot.acknowledged_request_id === submission.current.request_id || snapshot.turns?.some((turn) => turn.id === submission.current.request_id))) {
      drafts.delete(id); submission.current = null; setUncertain(false); setDraft(""); setActionError(""); setSendProgress("");
    }
    if (current && snapshot.generation === current.generation && snapshot.revision < current.revision) return;
    latest.current = snapshot; setSession(snapshot); onSnapshot(snapshot);
    const pending = snapshot.turns?.at(-1)?.approval?.id;
    if (checkApproval.current && pending !== checkApproval.current.id) checkApproval.current = null;
    setApprovalFeedback((old) => old?.id === pending ? old : null);
  }, [id, drafts, onSnapshot]);
  const fetchSession = useCallback(async (signal, incremental) => {
    const checking = checkApproval.current;
    const generation = latest.current?.generation;
    const after = incremental && !checking && latest.current ? "?after=" + encodeURIComponent(latest.current.revision)
      + (generation ? "&epoch=" + encodeURIComponent(generation) : "") : "";
    try {
      const snapshot = await request(sessionPath(id) + after, { signal });
      if (signal.aborted || !live.current) return;
      if (snapshot) accept(snapshot, generation);
      if (snapshot && checking && checkApproval.current === checking && latest.current?.turns?.at(-1)?.approval?.id === checking.id) {
        checkApproval.current = null;
        setApprovalFeedback({ id: checking.id, message: "主机仍在等待审批，请核对参数后再选择。" });
      }
      setReadError("");
      readFailures.current = 0; setReadProgress("");
      return active(latest.current?.turns?.at(-1)?.status) ? 1000 : 4000;
    } catch (error) {
      if (signal.aborted || !live.current) return;
      if (accessDenied(error)) onDenied(error); else if (error.status === 404 || error.status === 410) onMissing();
      else if (retryableSessionError(error) && ++readFailures.current <= sessionRetryLimit) {
        setReadError(""); setReadProgress(`${sessionFailureMessage(error)} 正在自动重连（${readFailures.current}/${sessionRetryLimit}）…`);
        return sessionRetryDelay(readFailures.current);
      } else {
        setReadProgress("");
        setReadError(sessionFailureMessage(error) + (retryableSessionError(error) ? " 已重连 5 次，请稍后再试。" : ""));
      }
      return null;
    }
  }, [id, accept, onDenied, onMissing]);
  useEffect(() => {
    if (!visible || uncertain) return;
    const controller = new AbortController();
    let timer, incremental = false;
    const poll = async () => {
      const delay = await fetchSession(controller.signal, incremental);
      incremental = true;
      if (!controller.signal.aborted && delay != null) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [fetchSession, visible, refresh, reload, uncertain]);
  useEffect(() => {
    if (!uncertain || !visible || !ready) return;
    const controller = new AbortController();
    setConfirming(true); setActionError(""); setReadError(""); setReadProgress("");
    const recovering = recoverPendingMessage({
      signal:controller.signal, pending:() => submission.current,
      progress:attempt => setSendProgress(`正在重连并确认消息是否送达（${attempt}/${sessionRetryLimit}）…`),
      read:async () => {
        const generation = latest.current?.generation;
        const snapshot = await request(sessionPath(id), {signal:controller.signal});
        if (!controller.signal.aborted) { accept(snapshot, generation); setReadError(""); setReadProgress(""); readFailures.current = 0; }
        return latest.current;
      },
      send:async message => {
        const generation = latest.current?.generation;
        const snapshot = await request(sessionPath(id) + "/messages", {body:message, signal:controller.signal});
        if (!controller.signal.aborted) accept(snapshot, generation);
      },
    });
    void recovering.then(confirmed => {
      if (!controller.signal.aborted && !confirmed) setActionError("已重连 5 次，仍未确认消息送达。原消息已保留，重连后会继续确认。请勿重复发送。");
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (accessDenied(error)) onDenied(error); else if ([404,410].includes(error.status)) onMissing(); else setActionError(sessionFailureMessage(error));
    }).finally(() => { if (!controller.signal.aborted) { setConfirming(false); setSendProgress(""); } });
    return () => { controller.abort(); setConfirming(false); setSendProgress(""); };
  }, [id, uncertain, visible, ready, accept, onDenied, onMissing, reload]);
  const needsConnection = ready && visible && session?.terminal_available && session.can_send === false;
  useEffect(() => {
    if (!needsConnection) { setConnectionError(""); setConnectionProgress(""); return; }
    setConnectionError("");
    const controller = new AbortController();
    let timer;
    let started = Date.now();
    let failures = 0;
    const connect = async () => {
      let delay = 1000;
      try {
        const generation = latest.current?.generation;
        const snapshot = await request(sessionPath(id) + "/open", { body: {automatic:true}, signal:controller.signal });
        if (controller.signal.aborted) return;
        if (snapshot) accept(snapshot, generation);
        failures = 0; setConnectionProgress("");
        if (snapshot?.can_send) return;
        if (snapshot?.connection_waiting) started = Date.now();
        if (!snapshot?.connection_waiting && Date.now() - started > 60000) {
          setConnectionError("会话连接暂未就绪，请重试。");
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (accessDenied(error)) { onDenied(error); return; }
        if (retryableSessionError(error) && ++failures <= sessionRetryLimit) {
          setConnectionProgress(`正在恢复会话连接（${failures}/${sessionRetryLimit}）…`);
          delay = sessionRetryDelay(failures);
        } else if (error.status !== 409 || Date.now() - started > 60000) {
          setConnectionProgress("");
          setConnectionError(sessionFailureMessage(error) + (retryableSessionError(error) ? " 已重连 5 次，请稍后再试。" : "")); return;
        }
      }
      timer = setTimeout(connect, delay);
    };
    void connect();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, needsConnection, accept, onDenied, reload]);
  useEffect(() => {
    if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [session?.revision]);
  useEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    input.style.height = "24px";
    input.style.height = Math.min(input.scrollHeight, 144) + "px";
  }, [draft]);
  const send = async (event) => {
    event?.preventDefault();
    if (actionBusy.current || confirming || readProgress || readError || running || !ready || !session || session.single_turn || session.can_send === false || !draft.trim()) return;
    actionBusy.current = true; setBusy(true); setActionError("");
    setSendProgress("正在发送消息…");
    try {
      follow.current = true;
      const generation = latest.current?.generation;
      submission.current ||= { request_id: crypto.randomUUID(), text: draft.trim() };
      drafts.set(id, {text:draft, pending:submission.current});
      const snapshot = await request(sessionPath(id) + "/messages", { body: submission.current });
      if (live.current) { accept(snapshot, generation); setReload(n => n + 1); }
    } catch (error) {
      if (!live.current) return;
      if (accessDenied(error)) onDenied(error);
      else if (submission.current) {
        const unknown = !error.status || error.status >= 500;
        if (!unknown) {submission.current = null; drafts.set(id, {text:draft});}
        setUncertain(unknown); setActionError(unknown ? "" : error.message);
        if (!unknown) setSendProgress("");
        if (unknown) setReload((n) => n + 1);
      }
    } finally { actionBusy.current = false; if (live.current) setBusy(false); }
  };
  const stop = async () => {
    if (actionBusy.current || last?.status !== "running") return;
    actionBusy.current = true; setBusy(true); setActionError("");
    const generation = latest.current?.generation;
    try { accept(await request(sessionPath(id) + "/stop", { body: { request_id: last.id } }), generation); }
    catch (error) {
      if (!live.current) return;
      if (accessDenied(error)) onDenied(error);
      else { setActionError(error.message); setReload((n) => n + 1); }
    } finally { actionBusy.current = false; if (live.current) setBusy(false); }
  };
  const retry = () => { readFailures.current = 0; setReadError(""); setConnectionError(""); setReload((n) => n + 1); };
  const decide = async (turnId, approvalId, allow) => {
    const turn = latest.current?.turns?.at(-1);
    if (actionBusy.current || checkApproval.current?.id === approvalId || turn?.id !== turnId || turn?.status !== "running" || turn.approval?.id !== approvalId) return;
    actionBusy.current = true; setBusy(true); setApprovalFeedback(null);
    try {
      const generation = latest.current?.generation;
      accept(await request(sessionPath(id) + "/approval", { body: { request_id: turnId, approval_id: approvalId, allow } }), generation);
    } catch (error) {
      if (!live.current) return;
      if (accessDenied(error)) onDenied(error);
      else if (latest.current?.turns?.at(-1)?.approval?.id === approvalId) {
        const checking = { id: approvalId, checking: true, message: error.status === 409 ? "请求状态已变更，正在刷新…" : "审批结果待确认，正在刷新主机状态…" };
        checkApproval.current = checking; setApprovalFeedback(checking); retry();
      }
    } finally { actionBusy.current = false; if (live.current) setBusy(false); }
  };
  return <>
    <section className="chat-header">
      <div className="title-line">{onBack && <button type="button" className="icon-button" aria-label="返回会话列表" onClick={onBack}><ArrowLeft size={18} /></button>}<h1>{session?.title || "Claude Code 会话"}</h1>{session && <Status value={last?.status} awaitingApproval={last?.status === "running" && last.approval} />}</div>
      {session && <p className="note">{session.workspace}</p>}
    </section>
    {!uncertain && (readError || connectionError) && <Notice onRetry={retry} label="再次连接">{readError || connectionError}</Notice>}
    {session && <SessionAccount id={id} request={request} onChanged={()=>setReload(n=>n+1)} compact />}
    {(sendProgress || connectionProgress || readProgress) && <p className="note" role="status">{sendProgress || connectionProgress || readProgress}</p>}
    {session?.connection_notice && <Notice>{session.connection_notice}</Notice>}
    {session?.history_truncated && <p className="note">当前仅显示部分历史。完整记录可在电脑的 Claude Code 中查看。</p>}
    <section className="transcript" ref={transcript} aria-label="会话消息" onScroll={(e) => {
      const box = e.currentTarget; follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 64;
    }}>
      {!session && !readError && <Empty icon={LoaderCircle} title="正在读取会话…" />}
      {session && !session.turns?.length && <Empty icon={Terminal} title="发送第一条消息">Claude Code 会在所选项目中处理你的请求。</Empty>}
      <TranscriptContext.Provider value={transcriptContext}>{session?.turns?.map((turn) => <React.Fragment key={turn.id}>
        <article className="message user" aria-label="你的消息"><MessageBody text={turn.prompt} /></article>
        <article className="message" aria-label="回复">
          <ToolActivity tools={turn.tools} />
          {turn.text && <MessageBody text={turn.text} />}
          {turn.truncated && <p className="note">本轮输出超过记录上限，仅显示已保存的内容。</p>}
          {!turn.text && !turn.approval && active(turn.status) && <p className="note">等待输出…</p>}
          {turn.id === last.id && turn.status === "running" && turn.approval?.id && <Approval
            key={turn.approval.id} approval={turn.approval} busy={busy} feedback={approvalFeedback?.id === turn.approval.id ? approvalFeedback : null}
            onDecide={(allow) => decide(turn.id, turn.approval.id, allow)} />}
          {turn.error && <div className="turn-error">{turn.error}</div>}
          {turn.denied_tools?.length > 0 && <div className="turn-tools">以下工具需要授权，本次调用已拒绝。<span>{turn.denied_tools.join("、")}</span></div>}
          {["failed", "interrupted", "stopped"].includes(turn.status) && <p className="note">{labels[turn.status]}</p>}
        </article>
      </React.Fragment>)}</TranscriptContext.Provider>
    </section>
    <form className="compose" onSubmit={send}>
      {actionError && <Notice onRetry={uncertain ? retry : undefined} label="再次连接">{actionError}</Notice>}
      {session?.single_turn && <p className="note">当前凭据或路由仅能验证本轮。请返回列表，新建会话后继续。</p>}
      {!ready && <p className="note">请在电脑上启动 Cage 环境。</p>}
      <div className="composer-field">
        <textarea ref={composerInput} aria-label="消息" rows="1" placeholder="给 Claude Code 发消息" value={draft} disabled={!session || session.single_turn || !ready || uncertain || busy}
          onChange={(e) => {
            const value = e.target.value;
            if (value) drafts.set(id, {text:value}); else drafts.delete(id);
            setDraft(value);
          }} onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
          }} />
        {running ? <button type="button" className="composer-action" aria-label={last.status === "stopping" ? "正在停止" : "停止运行"} title={last.status === "stopping" ? "正在停止" : "停止运行"} disabled={busy || last.status !== "running"} onClick={stop}><Square size={17} /></button>
          : <button type="submit" className="composer-action" aria-label={uncertain ? "再次尝试发送" : "发送"} title={uncertain ? "再次尝试发送" : "发送"} disabled={busy || confirming || !!readProgress || !!readError || !ready || !session || session.single_turn || session.can_send === false || !draft.trim()}><ArrowUp size={21} /></button>}
      </div>
    </form>
  </>;
}

function Approval({ approval, busy, feedback, onDecide }) {
  let input = null;
  if (approval.input && typeof approval.input === "object" && !Array.isArray(approval.input)) {
    try {
      // Keep direction-control characters visible when reviewing command text.
      input = JSON.stringify(approval.input, null, 2).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    } catch { /* An unreadable argument object cannot be approved. */ }
  }
  return <section className="approval" aria-label="工具审批">
    <h2>允许使用 {approval.tool}？</h2>
    {input === null ? <p className="note">无法显示完整参数，请拒绝或重新读取。</p>
      : <pre tabIndex={0} aria-label={approval.preview ? "工具参数预览" : "完整工具参数"}>{input}</pre>}
    {approval.preview && <p className="note">若参数预览有省略，请先在电脑查看完整参数再审批。</p>}
    {feedback && <p className="note" role="status">{feedback.message}</p>}
    <div className="approval-actions">
      <button type="button" className="action secondary" disabled={busy || feedback?.checking} onClick={() => onDecide(false)}>拒绝</button>
      <button type="button" className="action primary" disabled={busy || feedback?.checking || input === null} onClick={() => onDecide(true)}>允许一次</button>
    </div>
  </section>;
}
