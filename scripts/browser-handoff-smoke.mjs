import assert from "node:assert/strict";
import { createPrivacyController } from "./browser-privacy-fixture.mjs";

const fixture = await createPrivacyController({ headless: false });
const { api, cdp, evaluate, origin, waitFor } = fixture;
try {
  await api("/visibility", { visible: false });
  const opened = await api("/new", { url: origin + "/authorize", source: "guest" });
  await waitFor(() => evaluate(opened.id, "!document.hidden"), "guest-open restores a visible page");
  await waitFor(() => evaluate(opened.id, "location.pathname === '/authorize'"), "fixture authorization page loaded");
  const browser = (await api("/tabs")).handoff;
  assert.equal(browser.view, "browser");
  assert.equal(browser.id, opened.id);
  assert.equal(typeof browser.sequence, "string");
  assert.deepEqual((await api("/tabs")).handoff, browser);
  await cdp(opened.id, "Runtime.evaluate", { expression: "void window.open('/consent', 'consent')", userGesture: true });
  await waitFor(async () => {
    const state = await api("/tabs");
    return state.handoff?.sequence !== browser.sequence && state.handoff?.id === state.active
      && state.tabs.some(tab => tab.id === state.active && tab.url === origin + "/consent");
  }, "authorization popup is active and replayable");
  await api("/desktop-focus", {});
  const desktop = (await api("/tabs")).handoff;
  assert.equal(desktop.view, "desktop");
  assert.notEqual(desktop.sequence, browser.sequence);
  await api("/new", { url: "about:blank" });
  assert.deepEqual((await api("/tabs")).handoff, desktop);
  console.log("PASS guest URL opens a visible Chromium tab, handoff survives reconnection, desktop callback supersedes it, and manual creation leaves it alone");
} finally { await fixture.close(); }
