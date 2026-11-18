import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

// Execute the production JSX and its effects without a guest, login or browser.
// Only the rendering hooks, child views, API and clock are isolated here.
const source = await readFile(new URL("./claude-desktop.jsx", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "claude-desktop.jsx", {
  jsx: { runtime: "classic" },
});
const componentModule = new Function("dependencies", `
  const { React, useState, useRef, useEffect, api, useWindowVisibility,
    localStorage, setTimeout, clearTimeout, InlineSelect, Download,
    ChevronDown, ChevronUp, Monitor, PanelLeftOpen, Power, RefreshCw,
    BrowserUploads, ProjectDialog, SafetyMessage, RemoteView } = dependencies;
  ${code.replace(/^import[\s\S]*?;\s*$/gm, "")
    .replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, "")
    .replace(/^export /gm, "")}
  return { ClaudeDesktop, DesktopToolbar };
`);

function fixture({ platform = "windows-11", native = true, visible = true, windowVisible = true, snapshotError = "", vmRunning = true, installed = true, running = installed, historyError = "" } = {}) {
  const hooks = [], effects = [], timers = new Map(), requests = [];
  let cursor = 0, dirty = false, nextTimer = 0, lastJob;
  const current = { installed, running, failed: false, native_user_session: native };
  const props = {
    status: { vm_running: vmRunning, guest_system: platform, job: { running: false } },
    visible,
  };
  const createElement = (type, values, ...children) => ({ type, props: { ...values, children: children.flat() } });
  const dependencies = {
    React: { createElement },
    useState(initial) {
      const slot = hooks[cursor++] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slot.value, (next) => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (!Object.is(slot.value, value)) { slot.value = value; dirty = true; }
      }];
    },
    useRef(initial) { return hooks[cursor++] ??= { current: initial }; },
    useEffect(effect, deps) {
      const index = cursor++, slot = hooks[index];
      if (slot && deps.every((value, i) => Object.is(value, slot.deps[i]))) return;
      effects.push(() => {
        slot?.cleanup?.();
        hooks[index] = { deps, cleanup: effect() };
      });
    },
    api: async (path, body) => {
      requests.push({ path, body });
      if (path === "/claude-desktop") {
        if (snapshotError) throw new Error(snapshotError);
        return { ...current };
      }
      if (path === "/status") return props.status;
      if (path === "/jobs/history") {
        if (historyError) throw new Error(historyError);
        return [{ ...lastJob }];
      }
      assert.ok(path === "/claude-desktop/start" || (!native && path === "/claude-desktop/install"));
      lastJob = { id: `action-${requests.length}`, kind: `claude-desktop-${path.split("/").pop()}`, running: false };
      return lastJob;
    },
    useWindowVisibility: () => windowVisible,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const module = componentModule(dependencies);
  const h = {
    props, requests, current,
    get starts() { return requests.filter((r) => r.path === "/claude-desktop/start"); },
    render() { cursor = 0; dirty = false; h.tree = module.ClaudeDesktop(props); },
    async flush() {
      // Drain the real async refresh/run chain as well as state-driven renders.
      for (let i = 0; i < 20; i++) {
        while (effects.length) effects.shift()();
        await Promise.resolve();
        if (dirty) h.render();
      }
      assert.equal(effects.length, 0);
      assert.equal(dirty, false);
    },
    async update(next) { Object.assign(props, next); h.render(); await h.flush(); },
    async poll() {
      const callbacks = [...timers.values()]; timers.clear();
      for (const callback of callbacks) callback();
      await h.flush();
    },
    async finish(result = {}) { await h.update({ status: { ...props.status, job: { ...lastJob, ...result } } }); },
    toolbar() {
      const view = find(h.tree, (node) => node.type === module.DesktopToolbar);
      // Toolbar has its own stable hook slot, distinct from the parent view.
      cursor = 1000;
      return module.DesktopToolbar(view.props);
    },
  };
  h.render();
  return h;
}

function find(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of node.props?.children || []) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

const recoveryButton = (h) => find(h.toolbar(), (node) =>
  node.type === "button" && node.props.children.includes("恢复操作"));

test("navigation, polling and foregrounding only read native Windows desktop state", async () => {
  const h = fixture();
  await h.flush();
  await h.poll();
  await h.update({ visible: false });
  await h.poll();
  await h.update({ visible: true });
  assert.ok(h.requests.filter(r => r.path === "/claude-desktop").length >= 2);
  assert.equal(h.starts.length, 0);
});

test("hidden, non-Windows and non-native running views do not request foreground activation", async () => {
  for (const settings of [
    { visible: false },
    { windowVisible: false },
    { platform: "linux" },
    { platform: "macos" },
    { native: false },
  ]) {
    const h = fixture(settings);
    await h.flush();
    await h.poll();
    assert.equal(h.starts.length, 0, JSON.stringify(settings));
  }
});

test("recovery uses start with no credentials or stop/install request and is disabled while busy", async () => {
  const h = fixture();
  await h.flush();
  let button = recoveryButton(h);
  assert.equal(button.props.disabled, false);
  await button.props.onClick();
  await h.flush();
  assert.equal(h.starts.length, 1);
  assert.deepEqual(h.starts.at(-1).body, {});
  assert.equal(recoveryButton(h).props.disabled, true);
  await h.finish();
  await h.update({ status: { ...h.props.status, job: { id: "other", kind: "project", running: true } } });
  button = recoveryButton(h);
  assert.equal(button.props.disabled, true);
  assert.equal(h.starts.length, 1);
});

test("recovery entry is confined to the running native Windows toolbar", async () => {
  for (const settings of [{ platform: "linux" }, { native: false }]) {
    const h = fixture(settings);
    await h.flush();
    assert.equal(recoveryButton(h), undefined);
  }
});


const actionButton = (h, text) => find(h.tree, node =>
  node.type === "button" && node.props.children.includes(text));

test("a later guest installation resolves a failed first install but not a failed repair", async () => {
  for (const installed of [false, true]) {
    const h = fixture({ platform: "linux", native: false, installed, running: false });
    await h.flush();
    await actionButton(h, installed ? "更新 / 修复安装" : "下载并安装").props.onClick();
    await h.flush();
    const error = "依赖下载被代理拒绝";
    await h.finish({ error });
    assert.ok(find(h.tree, node => node.props.message === error));
    h.current.installed = true;
    await h.poll();
    assert.ok(actionButton(h, "打开 Claude Desktop"));
    assert.equal(Boolean(find(h.tree, node => node.props.message === error)), installed);
    assert.equal(h.props.status.job.error, error);
    assert.equal(h.starts.length, 0);
  }
});

test("an unreadable guest snapshot still allows one checked start, with no install", async () => {
  const h = fixture({ platform: "linux", snapshotError: "应用状态超时" });
  await h.flush();
  const open = actionButton(h, "打开 Claude Desktop");
  assert.ok(open);
  assert.equal(actionButton(h, "下载并安装"), undefined);
  let checks = 0;
  await h.update({ onCheckEnvironment: async () => { checks++; return true; } });
  const retry = actionButton(h, "打开 Claude Desktop");
  await Promise.all([retry.props.onClick(), retry.props.onClick()]);
  await h.flush();
  assert.equal(checks, 1);
  assert.equal(h.starts.length, 1);
});

test("an offline preflight lets the workbench start the VM before submitting app work", async () => {
  const h = fixture({ snapshotError: "读取应用状态失败" });
  await h.update({ onCheckEnvironment: async () => false });
  await actionButton(h, "打开 Claude Desktop").props.onClick();
  await h.flush();
  assert.equal(h.starts.length, 0);
  assert.equal(actionButton(h, "打开 Claude Desktop").props.disabled, false);
});

test("if another job replaces the accepted job, history recovery releases the toolbar", async () => {
  for (const historyError of ["", "历史读取失败"]) {
    const h = fixture({ historyError });
    await h.flush();
    await recoveryButton(h).props.onClick();
    await h.flush();
    await h.update({ status: { ...h.props.status, job: { id: "newer-job", kind: "project", running: false } } });
    await h.poll();
    assert.equal(h.requests.filter(r => r.path === "/jobs/history").length, 1);
    assert.equal(recoveryButton(h).props.disabled, false);
    assert.equal(h.starts.length, 1);
  }
});

test("missing desktop requires an explicit install on Linux and gives Windows guest guidance", async () => {
  for (const platform of ["linux", "windows-11"]) {
    const h = fixture({ platform, installed: false });
    await h.flush();
    assert.equal(h.requests.some(r => r.body !== undefined), false);
    assert.equal(Boolean(actionButton(h, "下载并安装")), platform === "linux");
  }
});


test("an offline desktop offers an enabled primary action and does not probe the guest until clicked", async () => {
  const h = fixture({ vmRunning: false });
  await h.flush();
  const before = h.requests.length;
  await h.poll();
  const button = actionButton(h, "打开 Claude Desktop");
  assert.equal(button.props.disabled, false);
  assert.equal(h.requests.length, before);
  assert.equal(h.starts.length, 0);
});

test("explicit open reuses a running Windows desktop without requesting activation", async () => {
  const h = fixture();
  // Click before the initial status fetch resolves.
  await actionButton(h, "打开 Claude Desktop").props.onClick();
  await h.flush();
  assert.equal(h.starts.length, 0);
  assert.ok(recoveryButton(h));
});

test("cold launch shows environment preparation immediately and allows retry after failure", async () => {
  let rejectCheck, stage;
  const h = fixture({ vmRunning: false });
  await h.update({ onOpeningChange: next => { stage = next; }, onCheckEnvironment: () => new Promise((_resolve, reject) => { rejectCheck = reject; }) });
  const pending = actionButton(h, "打开 Claude Desktop").props.onClick();
  await h.flush();
  assert.equal(stage, "check");
  assert.equal(h.starts.length, 0);
  rejectCheck(new Error("客机启动失败"));
  await pending;
  await h.flush();
  assert.equal(stage, "");
  assert.equal(actionButton(h, "打开 Claude Desktop").props.disabled, false);
  assert.ok(find(h.tree, node => node.props.message === "客机启动失败"));
});

test("an explicitly opened desktop completes in the background without rendering a second view", async () => {
  let resolveCheck;
  const h = fixture({ vmRunning: false, running: false });
  await h.update({ onCheckEnvironment: () => new Promise(resolve => { resolveCheck = resolve; }) });
  const pending = actionButton(h, "打开 Claude Desktop").props.onClick();
  await h.flush();
  await h.update({ visible: false, status: { ...h.props.status, vm_running: true } });
  assert.equal(h.tree, null);
  assert.equal(h.starts.length, 0);
  resolveCheck(true);
  await pending;
  await h.flush();
  assert.equal(h.tree, null);
  assert.equal(h.starts.length, 1);
  await h.finish();
  await h.update({ visible: true });
  await h.poll();
  assert.equal(h.starts.length, 1);
});
