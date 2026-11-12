import { OperationLogDialog } from "./operation-log";
import React from "react";
import { MacOSLogin } from "./macos-login";

// Recovery codes come from the operation that failed. Project status also
// supports restoring the flow after the in-memory job has been replaced.
export function initializationRecovery(status) {
  if (status?.guest_system !== "macos") return null;
  const workspace = status.workspace || (status.environment_workspace ? status.environment_directory : "");
  const failure = status.project_errors?.find(item => item.path === workspace);
  if (failure) return { ...failure, workspace };
  if (status.job?.error && status.job.recovery) return { recovery: status.job.recovery, message: status.job.error, workspace: status.job.workspace || workspace };
  return { workspace };
}

export function InitializationChecks({ status, busy, onWorkspace, onCheck, onStart, onRestart, onUpdate, onDiagnostics }) {
  const recovery = initializationRecovery(status);
  const code = recovery?.recovery;
  const workspaceChecked = !code && status.safety?.report?.checks?.some(check => check.id === "filesystem_boundary" && check.state === "passed");
  return <section className="initialization-notice" aria-label="完成安装检查">
    <h2>{code === "project-approval" ? "允许虚拟 Mac 访问工作区" : code === "guest-login" ? "先登录虚拟 Mac" : code === "filesystem-permission" ? "先启用文件共享权限" : "完成联网与隔离检查"}</h2>
    <p>{recovery?.message || status.job?.error || status.safety?.error || (recovery?.workspace ? "系统已经安装。接下来确认共享工作区可访问，再检查代理出口和环境隔离。" : "系统已经安装。接下来检查代理出口和环境隔离，项目文件夹可以稍后添加。")}</p>
    {recovery?.workspace && <p className="macos-approval-path">{recovery.workspace}</p>}
    {code === "project-approval" && <p>打开授权窗口，选择 Use Project（使用项目）。验证通过后继续联网检查。</p>}
    {code === "filesystem-permission" && <p>在虚拟 Mac 中打开 macFUSE 和 macFUSE (local) 两个开关，完成后返回这里继续。</p>}
    {code === "guest-login" && <MacOSLogin disabled={busy} onSessionClosed={onCheck} />}
    {code === "filesystem-permission" && <MacOSLogin maintenance="projects" disabled={busy} onSessionClosed={onCheck} />}
    <div className="initialization-recovery">
      {["environment-update", "environment-restart"].includes(code) ? <>
        {code === "environment-update" && <button className="primary" disabled={busy} onClick={onUpdate}>同步环境组件</button>}
        <button disabled={busy} onClick={code === "environment-restart" ? onRestart : onStart}>{code === "environment-restart" ? "保存后重启并检查" : "重新连接并检查"}</button>
      </> : <button className="primary" disabled={busy || !status.ready} onClick={() => workspaceChecked || !recovery?.workspace ? onCheck() : onWorkspace(recovery.workspace)}>{code === "project-approval" ? "打开工作区授权" : workspaceChecked || !recovery?.workspace ? "重试网络与隔离检查" : "连接工作区并继续检查"}</button>}
      {code === "project-directory" && <button disabled={busy} onClick={onDiagnostics}>查看诊断记录</button>}
    </div>
    <p className="mac-setup-retention">检查通过前客机外网保持关闭。重试会保留已有安装和个人文件。</p>
  </section>;
}

export function InitializationDetails({ status, onClose }) {
  const job = status?.job || {};
  const reasons = [...new Set([job.error, status?.safety?.error, status?.network_error].filter(Boolean))];
  const checks = status?.safety?.report?.checks || [];
  const labels = { passed: "已通过", failed: "未通过", unknown: "尚未完成" };
  return <OperationLogDialog title="初始化操作详情" job={job} onClose={onClose}>
    {reasons.map(reason => <p key={reason} role="alert">{reason}</p>)}
    {checks.length > 0 && <><h3>最近一次检查结果</h3><ol className="initialization-checks">{checks.map(check => <li key={check.id}>
      <strong>{check.title} · {labels[check.state] || "尚未完成"}</strong>
      <p>{check.evidence}</p>{check.state !== "passed" && check.remedy && <p>{check.remedy}</p>}
    </li>)}</ol></>}
  </OperationLogDialog>;
}
