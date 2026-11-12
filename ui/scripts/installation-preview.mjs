// Local copy preview of the production workbench. API requests stay in this
// process; none are forwarded to Cage or used to install a guest.
import http from "node:http";
import { defaultAppearance } from "../src/appearance-state.mjs";

const port = Number(process.env.CAGE_INSTALL_PREVIEW_PORT || 5208);
const upstream = new URL(process.env.CAGE_UI_URL || "http://127.0.0.1:5198");
const hosts = {
  macos: { system: "macos", version: "26.5", build: "25F71", arch: "arm64", platform: "darwin", bytes: 19769944180, imageBuild: "25F71" },
  windows: { system: "windows-11", version: "25H2", build: "26200.9711", edition: "Professional", language: "zh-CN", arch: "amd64", platform: "windows", bytes: 5314951294, imageBuild: "26200.6584" },
  linux: { system: "ubuntu-22.04", version: "22.04", arch: "amd64", platform: "linux", bytes: 650000000 },
};
const sessions = new Map();
const exampleChat = {
  id: "preview-chat", workspace: "/preview/workspace", title: "环境检查",
  generation: "preview-chat", revision: 1, can_send: false,
  turns: [{ id: "preview-turn", status: "completed", prompt: "这个工作区使用哪个环境？",
    text: "当前使用 **本机工作区**。可在工作台查看代理出口、客机状态和项目目录。" }],
};

async function jsonBody(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString() || "{}");
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const saved = Object.fromEntries((req.headers.cookie || "").split(";").map(value => value.trim().split("=")));
  const requestedHost = url.searchParams.get("host") || saved.preview_host;
  const selected = Object.hasOwn(hosts, requestedHost) ? requestedHost : "macos";
  const requestedState = url.searchParams.get("state") || saved.preview_state;
  const scenario = ["home", "workbench", "account", "create", "ssh", "download", "cached", "progress", "failure", "ready", "resume", "space"].includes(requestedState) ? requestedState : "download";
  const host = hosts[selected] || hosts.macos;
  const system = host.system;
  const plan = {
    host, version: host.version, build: host.imageBuild, bytes: host.bytes,
    format: system === "macos" ? "ipsw" : system === "windows-11" ? "esd" : "qcow2",
    ...(scenario === "cached" ? { path: "/preview/cached-system-image" } : {}),
  };
  // Give each preview browser its own disposable hosts, account and installation state.
  const browserID = /^[a-f0-9-]{36}$/.test(saved.preview_id || "") ? saved.preview_id : crypto.randomUUID();
  const sessionKey = `${browserID}:${selected}:${scenario}`;
  if (url.pathname === "/") {
    res.setHeader("Set-Cookie", [`preview_id=${browserID}; HttpOnly; SameSite=Strict; Path=/`,
      `preview_host=${selected}; SameSite=Strict; Path=/`, `preview_state=${scenario}; SameSite=Strict; Path=/`]);
    if (url.searchParams.get("reset") === "1") {
      sessions.delete(sessionKey);
      res.writeHead(303, { Location: `/?host=${selected}&state=${scenario}` });
      res.end();
      return;
    }
  }
  if (!sessions.has(sessionKey)) sessions.set(sessionKey, { required: !["home", "workbench", "account", "create", "ssh"].includes(scenario), tracked: true, started: ["resume", "progress", "failure", "ready"].includes(scenario), created: Date.now() });
  const session = sessions.get(sessionKey);
  const previewSSH = scenario === "ssh";
  if (previewSSH && !session.hosts) {
    session.hosts = [{ id: "preview-host", name: "Linux 测试主机", host: "dev.example.test", port: 22,
      user: "cage", auth: { kind: "agent" }, executable: "cage", config_path: "" }];
  }
  const showProgress = scenario === "progress" || session.installing;
  const showFailure = scenario === "failure";
  const showReady = (previewSSH && session.connection?.state === "connected") || scenario === "home" || scenario === "ready" || (scenario === "workbench" && session.running);
  const job = showProgress || showFailure ? { id: "preview-install", kind: "guest-install", running: !showFailure, error: showFailure ? "系统镜像下载中断。请检查代理连接，已下载文件和虚拟磁盘会保留。" : "", message: "正在下载系统镜像", setup_progress: { system, phase: "image", operation: "download", label: `正在下载 ${system === "macos" ? "macOS" : system === "windows-11" ? "Windows 11" : "Ubuntu"} 系统镜像`, received: Math.floor(host.bytes * .43), total: host.bytes, bytes_per_second: 26 * 1048576 }, log: ["检查镜像缓存", "  /preview/cache  可用", "开始下载系统镜像", showFailure ? "错误：连接中断，下次安装可继续下载。" : "已接收 43%"].join("\n") } : { running: false };
  const status = { local_vm_storage: true, ready: showReady, vm_running: showReady, safety: showReady ? { gate: { mode: "open", until: new Date(Date.now()+3600000).toISOString() } } : {}, keyboard: host.platform === "darwin" ? "mac" : "native", job, projects: ["/preview/workspace"], environment_workspace: true, environment_directory: "/preview/workspace", workspace: "/preview/workspace" };
  const pending = scenario === "resume" ? { version: 1, id: "preview-install", system, source: plan, editor_terms: true } : undefined;
  if (url.pathname.startsWith("/api/")) {
    let value = {};
    if (url.pathname === "/api/client/context") {
      const connected = previewSSH && session.connection?.state === "connected";
      value = { mode: previewSSH ? connected ? "remote" : "none" : "local",
        connection_id: previewSSH ? connected ? "preview-remote" : "preview-disconnected" : "local",
        client_platform: host.platform, server_platform: connected ? "linux" : host.platform,
        client_only: previewSSH, host_id: session.connection?.host_id, connection: session.connection || { state: "disconnected" } };
    }
    else if (previewSSH && url.pathname === "/api/client/hosts" && req.method === "GET") value = { hosts: session.hosts };
    else if (previewSSH && /^\/api\/client\/hosts(?:\/[^/]+)?$/.test(url.pathname)) {
      const id = url.pathname.split("/")[4] || crypto.randomUUID();
      if (req.method === "DELETE") session.hosts = session.hosts.filter(item => item.id !== id);
      else {
        const body = await jsonBody(req);
        value = { id, name: body.name, host: body.host, port: body.port, user: body.user,
          auth: { kind: body.auth?.kind, identity_file: body.auth?.identity_file },
          executable: body.executable, config_path: body.config_path, host_key: body.host_key };
        session.hosts = [...session.hosts.filter(item => item.id !== id), value];
      }
    }
    else if (previewSSH && url.pathname === "/api/client/connect") {
      const { host_id } = await jsonBody(req);
      const item = session.hosts.find(entry => entry.id === host_id);
      session.connection = item?.host_key ? { host_id, name: item.name, state: "connected" }
        : { host_id, state: "failed", error_code: "host_key_unknown", message: "首次连接，请核对主机指纹。",
            host_key: { algorithm: "ssh-ed25519", fingerprint: "SHA256:preview-only" } };
    }
    else if (previewSSH && url.pathname === "/api/client/disconnect") session.connection = { state: "disconnected" };
    else if (url.pathname === "/api/account" || ["/api/account/create", "/api/account/unlock"].includes(url.pathname)) {
      if (req.method === "POST") session.signedIn = true;
      value = { exists: scenario !== "create" || Boolean(session.signedIn), unlocked: !["account","create"].includes(scenario) || Boolean(session.signedIn), username: "预览账户" };
    }
    else if (url.pathname === "/api/status") value = status;
    else if (url.pathname === "/api/environment/initialization") {
      if (req.method === "POST") {
        let body=""; for await (const part of req) body+=part;
        const action=JSON.parse(body || "{}").action;
        if(action === "install") session.started=true;
        if(action === "complete" && showReady) session.required=false;
      }
      value=session;
    }
    else if (url.pathname === "/api/environment/storage") value={directory: host.platform === "windows" ? "D:\\Cage\\CageData" : "/preview/cage-state",has_environment:false};
    else if (url.pathname === "/api/settings") value = { workspace: "/preview/workspace", browser_home_url: "https://www.bing.com/", timezone: "Asia/Shanghai", locale: "zh_CN.UTF-8", keyboard: status.keyboard };
    else if (url.pathname === "/api/appearance") {
      if (req.method === "POST") {
        const parts = [];
        for await (const part of req) parts.push(part);
        session.appearance = JSON.parse(Buffer.concat(parts).toString());
      }
      value = session.appearance || defaultAppearance;
    }
    else if (url.pathname === "/api/mobile/cli/projects") value = { host: "Cage", ready: true, projects: [{ path: "/preview/workspace", name: "工作区" }], shared_sessions: true };
    else if (url.pathname === "/api/mobile/cli/sessions" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      session.chats ||= new Map();
      if (!session.chats.has(body.id)) session.chats.set(body.id, {
        id: body.id, title: "新建对话", workspace: body.workspace, generation: body.id, revision: 1, can_send: true, turns: [],
      });
      value = session.chats.get(body.id);
    }
    else if (url.pathname === "/api/mobile/cli/sessions") value = { sessions: [exampleChat, ...(session.chats?.values() || [])] };
    else if (session.chats?.has(url.pathname.split("/")[5])) {
      const [, , , , , id, action] = url.pathname.split("/");
      const chat = session.chats.get(id);
      if (action === "messages") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (!chat.turns.some(turn => turn.id === body.request_id)) {
          chat.turns.push({ id: body.request_id, prompt: body.text, status: "completed", text: "这是验收示例回复。你可以继续输入，或返回工作台。" });
          chat.title = body.text.slice(0, 32); chat.revision++;
        }
      }
      value = action === "account" ? { session: chat, supported: false, candidates: [] } : chat;
    }
    else if (url.pathname === "/api/mobile/cli/sessions/preview-chat") value = exampleChat;
    else if (url.pathname === "/api/mobile/cli/sessions/preview-chat/account") value = { session: exampleChat, supported: false, candidates: [] };
    else if (url.pathname === "/api/vault") value = { entries: [], blocked: [] };
    else if (url.pathname === "/api/mobile-pair") value = { paired: false, status: "尚未配对" };
    else if (url.pathname.startsWith("/api/cli/sessions")) value = { sessions: [], notice: "" };
    else if (url.pathname === "/api/mobile/account" || url.pathname === "/api/claude-accounts") value = { accounts: [] };
    else if (url.pathname === "/api/proxy") value = { active: true, selected: "preview-node", port: 17896, core_available: true, state: "prepared", sources: [{ id: "preview", name: "预览代理", nodes: [{ id: "preview-node", name: "预览节点", type: "http" }] }] };
    else if (url.pathname === "/api/environment/guest-systems") value = { fresh: !pending, available: true, system, pending, linux_systems: ["ubuntu-22.04"] };
    else if (url.pathname === "/api/environment/guest-systems/clone") value = { plan, key: "preview-only", enough_space: scenario !== "space", download_bytes: scenario === "cached" ? 0 : scenario === "resume" ? Math.floor(host.bytes / 3) : host.bytes, minimum_free_gib: 32 + Math.ceil(host.bytes / 1073741824), free_gib: scenario === "space" ? 10 : 120, installation_started: Boolean(pending) };
    else if (url.pathname === "/api/host/git") value = { state: "ok", ready: true, message: "本机 Git 安全保护已启用。" };
    else if (url.pathname === "/api/terminals") value = [];
    else if (url.pathname === "/api/browser/tabs") value = { tabs: [], active: "" };
    else if (url.pathname === "/api/start") { if (scenario === "workbench") session.running=true; else session.installing=true; value={ id: "preview-install", kind: "guest-install", running: true }; }
    else if (url.pathname === "/api/stop") { session.running=false; session.installing=false; value={ id: "preview-stop", kind: "stop", running:false }; }
    else if (url.pathname === "/api/diagnostics") value={bytes:0,files:0};
    else if (url.pathname.endsWith("/events")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(": preview\n\n"); return; }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); return;
  }
  const requestHeaders = { ...req.headers, host: upstream.host };
  if (url.pathname === "/") {
    requestHeaders["accept-encoding"] = "identity";
    delete requestHeaders["if-none-match"];
    delete requestHeaders["if-modified-since"];
  }
  const request = http.request(new URL(url.pathname + url.search, upstream), { headers: requestHeaders }, response => {
    const parts = [];
    response.on("data", part => parts.push(part));
    response.on("end", () => {
      let body = Buffer.concat(parts);
      const headers = { ...response.headers };
      if (url.pathname === "/") {
        const links = Object.keys(hosts).map(key => `<a href="/?host=${key}&state=${scenario}" ${key === selected ? 'aria-current="page"' : ""}>${key === "macos" ? "Mac" : key === "windows" ? "Windows" : "Linux"}</a>`).join("");
        const states = [["home", "新建对话"], ["workbench", "环境启动"], ["account", "登录"], ["create", "创建账户"], ["ssh", "SSH 主机"], ["download", "首次配置"], ["cached", "已有镜像"], ["progress", "安装进度"], ["failure", "安装失败"], ["ready", "环境就绪"]].map(([key, label]) => `<a href="/?host=${selected}&state=${key}&reset=1" ${key === scenario ? 'aria-current="page"' : ""}>${label}</a>`).join("");
        const banner = `<details class="installation-preview"><summary>验收场景 · 模拟数据</summary><nav>${states}</nav><nav>${links}</nav></details>`;
        const previewCSS = `
          :root { --preview-bar: 28px; }
          #root { position: relative; contain: layout; height: calc(100dvh - var(--preview-bar)); }
          #root :is(.client-shell,.app,.account-gate) { height: 100%; }
          .installation-preview {
            position: fixed; z-index: 99; inset: auto 0 0; color: var(--ink,#30302d);
            background: var(--paper,#fff); border-top: 1px solid var(--line,#ddd);
            font: 12px/1.45 system-ui; max-height: 65dvh; overflow: auto;
          }
          .installation-preview summary {
            width: fit-content; min-height: calc(var(--preview-bar) - 1px);
            padding: 4px 14px; margin-left: auto; cursor: pointer; color: var(--muted,#666);
          }
          .installation-preview nav { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 4px; padding: 4px 10px 8px; }
          .installation-preview a { color: inherit; padding: 3px 7px; text-decoration: none; border-radius: 5px; }
          .installation-preview a:hover,.installation-preview [aria-current] { background: var(--hover,#eee); }
        `;
        body = Buffer.from(body.toString().replace("</head>", `<style>${previewCSS}</style><script>window.cageNativeBridge={postMessage:async()=>null};</script></head>`).replace('<div id="root">', banner + '<div id="root">'));
        delete headers["content-length"];
        delete headers.etag;
        headers["cache-control"] = "no-store";
      }
      res.writeHead(response.statusCode, headers); res.end(body);
    });
  });
  request.on("error", () => { res.writeHead(502); res.end("Start the Cage frontend preview server first."); });
  req.pipe(request);
}).listen(port, "127.0.0.1", () => console.log(`Installation copy preview: http://127.0.0.1:${port}/?host=macos`));
