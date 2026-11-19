// Only the stop requested by this window can authorize its automatic exit.
export function stopExitState(status, jobId) {
  const job = status.job;
  if (!jobId || job?.id !== jobId || job.kind !== "stop" || job.running)
    return "waiting";
  if (job.error || job.canceled) return "failed";
  return status.vm_running === false ? "exit" : "waiting";
}

// Exit owns its wait loop: boot failures and a stopped UI poll must not strand it.
export async function stopAndExit({
  stop,
  readStatus,
  readHistory,
  exit,
  isCancelled,
  onStatus,
  timeoutMs = 4 * 60 * 1000,
  delay = () => new Promise((resolve) => setTimeout(resolve, 350)),
}) {
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  let lastStatus;
  try {
    const job = await stop(signal);
    if (!job.id) throw new Error("停止请求未返回任务编号，请重试。");
    while (!isCancelled()) {
      signal.throwIfAborted();
      const status = await readStatus(signal);
      if (isCancelled()) return false;
      onStatus(status);
      lastStatus = status;
      let requested = status.job;
      if (requested?.id !== job.id && readHistory) {
        const history = await readHistory(signal);
        if (isCancelled()) return false;
        requested = history.find((entry) => entry.id === job.id);
      }
      signal.throwIfAborted();
      const state = stopExitState({ ...status, job: requested }, job.id);
      if (state === "failed") throw new Error(requested.error || "环境停止任务已取消。");
      if (state === "exit" && !status.job?.running) {
        await exit();
        return true;
      }
      await delay();
    }
    return false;
  } catch (error) {
    if (isCancelled()) return false;
    if (!signal.aborted) throw error;
    const message = lastStatus?.vm_running ? "环境仍报告为运行中。" : "尚未确认环境已停止。";
    throw new Error(message + "请查看操作详情后重试。");
  } finally {
    clearTimeout(deadline);
  }
}
