export function operationName(path = "", method = "GET") {
  const reading = method === "GET";
  if (path.startsWith("/api/mobile/cli")) return reading ? "读取会话消息" : "提交会话操作";
  if (path.startsWith("/api/mobile/browser")) return "连接电脑上的浏览器";
  if (path.startsWith("/api/mobile/desktop")) return "连接电脑上的 Claude Desktop";
  if (path.startsWith("/environment/resources")) return reading ? "读取资源配置" : "应用资源配置";
  if (path === "/environment/initialization") return reading ? "读取初始化进度" : "保存初始化状态";
  if (path.startsWith("/environment/versions")) return "读取环境组件版本";
  if (path.startsWith("/environment/")) return "更新环境";
  if (path.startsWith("/input/files") || path.startsWith("/browser/files")) return "传递文件";
  if (path.startsWith("/tailscale")) return reading ? "读取 Tailscale 状态" : "操作 Tailscale";
  if (path.startsWith("/browser")) return "操作浏览器";
  if (path.startsWith("/proxy")) return reading ? "读取代理设置" : "应用代理设置";
  if (path.startsWith("/safety")) return "检查联网条件";
  if (path.startsWith("/settings/probe")) return "验证代理出口";
  if (path.startsWith("/settings")) return reading ? "读取设置" : "保存设置";
  if (path.startsWith("/diagnostics/export")) return "导出诊断日志";
  if (path.startsWith("/diagnostics")) return "读取诊断日志";
  if (path.startsWith("/projects")) return "连接项目目录";
  if (path.startsWith("/account")) return "处理账户操作";
  if (path.startsWith("/claude-desktop")) return "操作 Claude Desktop";
  if (path.startsWith("/terminals")) return "连接终端";
  if (path === "/start") return "启动环境";
  if (path === "/stop") return "停止环境";
  return "连接 Cage 工作台";
}

export function httpErrorMessage(path, status, text = "", contentType = "", method = "GET") {
  // Proxy HTML pages, stack traces and untranslated runtime errors are not UI
  // explanations. Preserve short Chinese messages supplied by Cage itself.
  const message = text.trim();
  if (contentType.startsWith("text/plain") && message.length <= 2000 && /\p{Script=Han}/u.test(message) && !/<(?:html|body|script|!doctype)\b/i.test(message)) return message;
  if (path === "/settings" && method === "POST" && status === 503) {
    return "无法确认设置是否已保存（HTTP 503）。恢复连接后，请先核对设置或查看操作详情。";
  }
  const action = operationName(path, method);
  const reasons = {
    400: "请检查填写的内容。仍然失败时，可在设置中导出诊断包。",
    401: "登录会话已过期，请重新连接 Cage。",
    403: "访问被拒绝，请从 Cage 重新打开工作台。",
    404: "此功能不可用，请检查 Cage 和后台是否已更新。",
    409: "状态已变化或有操作正在进行。请刷新状态后重试。",
    413: "内容超过大小限制，请缩小文件或分批处理。",
    423: "请先解锁 Cage 账户，再重试。",
    429: "操作太频繁，请稍后重试。",
    500: "服务出错。请在设置中导出诊断包，并记录刚才的操作。",
    502: "无法连接环境内的服务。请确认环境已启动，再检查组件状态。",
    503: "服务尚未就绪，请在连接恢复后重试。",
    504: "响应超时。恢复连接后，请先核对操作是否已生效。",
  };
  return `${action}失败（HTTP ${status}）：${reasons[status] || "原因未知。你可以在设置中导出诊断包。"}`;
}

export function connectionErrorMessage(path, method = "GET") {
  return `${operationName(path, method)}失败：连接已中断，请重新连接。如果刚才正在保存或上传，请先核对结果再重试。`;
}

export function nativeFailureMessage(action, message = "") {
  if (/\p{Script=Han}/u.test(message) && !["文件操作失败", "原生操作超时，请重试", "操作失败"].includes(message)) return message;
  const names = { chooseFolder: "选择本机文件夹", chooseUploadFiles: "选择上传文件", uploadHostFiles: "上传本机文件", openHostPath: "打开本机文件", exportDiagnostics: "导出诊断包", appUpdate: "检查或安装应用更新", clipboardRead: "读取剪贴板", clipboardWrite: "写入剪贴板", refreshSession: "恢复工作台登录会话" };
  return `${names[action] || "执行本机操作"}失败：${/timeout|超时/i.test(message) ? "等待本机组件响应超时" : "本机组件没有返回可识别的原因"}。请重新连接 Cage；仍失败时在设置中导出诊断包。`;
}
