// Starting always requires a node applied by the Cage proxy manager.
export function needsProxySetup(_settings, _status, proxy) {
  return !(proxy?.active && proxy?.selected);
}

// Older controllers report these restart conditions as messages rather than a
// recovery code. Keep the exact known messages here; a generic network failure
// should still offer a retry rather than a disruptive environment restart.
const restartMessages = new Set([
  "已保存固定出口。请重启 macOS 客机，登录后重新检测。",
  "出口地址或环境设置变化需要重启环境",
  "网络设置已保存，请重启 macOS 客机，登录后重新检测",
]);

export function needsEnvironmentRestart(status) {
  if (status?.guest_system !== "macos" || status.safety?.gate?.mode === "open") return false;
  return Boolean(
    (status.job?.error && status.job.recovery === "environment-restart") ||
    restartMessages.has(status.safety?.error) || restartMessages.has(status.job?.error),
  );
}
