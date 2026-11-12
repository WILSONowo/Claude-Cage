import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, Check, Copy } from "lucide-react";
import { api, writeClipboard } from "./api";
import { InlineSelect } from "./inline-select";
import { SafetyMessage } from "./safety-message";
import { useAppearance } from "./appearance";
import { terminalTheme } from "./appearance-state.mjs";
import { Modal } from "./modal";
import "./operation-log.css";

export function WorkbenchOperationLog({ job, onClose }) {
  const [records, setRecords] = useState([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(job?.id || "");
  useEffect(() => {
    let live = true;
    api("/jobs/history").then(items => {
      if (live && Array.isArray(items)) { setRecords(items); setError(""); }
    }).catch(() => { if (live) setError("暂时无法读取历史记录。"); });
    return () => { live = false; };
  }, [job?.id, job?.running]);
  const options = job?.id ? [job, ...records.filter(item => item.id !== job.id)] : records;
  const shown = options.find(item => item.id === selected) || options[0] || job;
  return <OperationLogDialog title="操作详情" job={shown} onClose={onClose}
    message={shown?.message && <SafetyMessage message={shown.message} />}
    history={options.length > 1 && <InlineSelect aria-label="选择操作记录" value={shown.id} onValueChange={setSelected}>
      {options.map(item => <option key={item.id} value={item.id}>{item.label || item.kind}{item.started_at ? " · " + new Date(item.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</option>)}
    </InlineSelect>}>
    {shown?.error && <p role="alert"><SafetyMessage message={shown.error} /></p>}
    {error && <p role="status">{error}</p>}
  </OperationLogDialog>;
}

export function OperationLogDialog({ title, onClose, job, message, children, history }) {
  const text = job?.log || "";
  const { theme, variant } = useAppearance();
  const palette = terminalTheme(theme, variant);
  const viewport = useRef(null), content = useRef(null);
  const following = useRef(true);
  const [atEnd, setAtEnd] = useState(true);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 3500);
    return () => clearTimeout(timer);
  }, [feedback]);
  useLayoutEffect(() => {
    following.current = true;
    setAtEnd(true);
    setFeedback("");
    viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [job?.id, job?.kind]);
  useLayoutEffect(() => {
    const follow = () => {
      if (following.current) viewport.current.scrollTop = viewport.current.scrollHeight;
    };
    const observer = new ResizeObserver(follow);
    observer.observe(viewport.current);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);

  const copy = async () => {
    try {
      await writeClipboard(text);
      setFeedback("已复制日志");
    } catch {
      setFeedback("复制失败，可选中日志复制。");
    }
  };
  const end = () => {
    following.current = true;
    viewport.current.scrollTop = viewport.current.scrollHeight;
    viewport.current.focus({ preventScroll: true });
    setAtEnd(true);
  };
  return <Modal title={title} onClose={onClose} wide className="operation-log-dialog" initialFocusRef={viewport}
    style={{ "--log-bg": palette.background, "--log-ink": palette.foreground, "--log-prompt": palette.green, "--log-error": palette.red }}
    headerActions={<>
      {history}
      <button type="button" className="icon-button" disabled={atEnd} onClick={end} title="跳到最新输出" aria-label="跳到最新输出"><ArrowDownToLine size={16} /></button>
      <button type="button" className="icon-button" disabled={!text} onClick={copy} title="复制日志" aria-label="复制日志">
        {feedback === "已复制日志" ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </>}>
    <div className="operation-log-terminal" ref={viewport} role="region" aria-label="日志内容" tabIndex={0}
      onScroll={event => {
        const node = event.currentTarget;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 3;
        setAtEnd(following.current);
      }}>
      <div ref={content}>
        <p className="operation-log-prompt"><code aria-hidden="true">cage{job?.kind && <>:{job.kind}</>} $</code><span>{message || job?.message}</span></p>
        {text ? <pre className="operation-log-output">{text}</pre>
          : <p className="operation-log-empty">{job?.running ? "等待输出…" : "暂无日志"}</p>}
        {children}
      </div>
    </div>
    <span className="operation-log-feedback" role="status">{feedback}</span>
  </Modal>;
}
