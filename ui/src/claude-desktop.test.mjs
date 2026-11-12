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

function fixture({ platform = "windows-11", native = true, visible = true, windowVisible = true } = {}) {
  const hooks = [], effects = [], timers = new Map(), requests = [];
  let cursor = 0, dirty = false, nextTimer = 0, lastJob;
  const current = { installed: true, running: true, failed: false, native_user_session: native };
  const props = {
    status: { vm_running: true, guest_system: platform, job: { running: false } },
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
      if (path === "/claude-desktop") return { ...current };
      assert.equal(path, "/claude-desktop/start", "recovery must not close or reinstall the existing application");
      lastJob = { id: `activation-${requests.length}`, kind: "claude-desktop-start", running: false };
      return lastJob;
    },
    useWindowVisibility: () => windowVisible,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const module = componentModule(dependencies);
  const h = {
    props, requests,
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
    async finish() { await h.update({ status: { ...props.status, job: { ...lastJob } } }); },
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

test("native Windows activates on explicit entry, but ordinary polling does not repeat it", async () => {
  const h = fixture();
  await h.flush();
  assert.equal(h.starts.length, 1);
  await h.finish();
  await h.poll();
  await h.poll();
  assert.equal(h.starts.length, 1);
  await h.update({ visible: false });
  await h.poll();
  assert.equal(h.starts.length, 1);
  await h.update({ visible: true });
  assert.equal(h.starts.length, 2);
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
  assert.equal(recoveryButton(h).props.disabled, true);
  await h.finish();
  let button = recoveryButton(h);
  assert.equal(button.props.disabled, false);
  await button.props.onClick();
  await h.flush();
  assert.equal(h.starts.length, 2);
  assert.deepEqual(h.starts.at(-1).body, {});
  assert.equal(recoveryButton(h).props.disabled, true);
  await h.finish();
  await h.update({ status: { ...h.props.status, job: { id: "other", kind: "project", running: true } } });
  button = recoveryButton(h);
  assert.equal(button.props.disabled, true);
  assert.equal(h.starts.length, 2);
});

test("recovery entry is confined to the running native Windows toolbar", async () => {
  for (const settings of [{ platform: "linux" }, { native: false }]) {
    const h = fixture(settings);
    await h.flush();
    assert.equal(recoveryButton(h), undefined);
  }
});
