import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

// Run against the local UI (CAGE_UI_URL) with simulated guest responses.
// Only an explicit click on the main button may submit a start.
for (const platform of ["debian-13", "windows-11", "macos"]) {
  for (const scenario of ["cold", "warm-stopped", "warm-running"]) {
    let appRunning = scenario === "warm-running", launches = 0, guestReads = 0;
    const snapshot = () => ({ installed: true, running: appRunning, managed: true,
      screen: false, input: false, native_user_session: platform === "windows-11" });
    const { page, browser, state, errors } = await createWorkbench({
      beforeNavigate: async (page, state) => {
        state.account.guest_system = state.status.guest_system = platform;
        state.status.vm_running = state.status.ready = scenario !== "cold";
        await page.route("**/api/claude-desktop", route => { guestReads++; return route.fulfill({ json: snapshot() }); });
        await page.route("**/api/claude-desktop/vnc-credentials", route => route.fulfill({ status: 503, body: "Display pending" }));
        await page.route("**/api/claude-desktop/start", route => {
          assert.ok(state.status.vm_running);
          launches++; appRunning = true;
          return route.fulfill({ json: state.status.job = { id: "app", kind: "claude-desktop-start", running: false } });
        });
        await page.route("**/api/macos/claude/window", route => {
          const { action } = route.request().postDataJSON();
          if (action === "launch") { assert.ok(state.status.vm_running); launches++; appRunning = true; }
          if (action === "status") guestReads++;
          return route.fulfill({ json: snapshot() });
        });
      },
    });
    try {
      const navigate = page.getByRole("button", { name: "Claude Desktop", exact: true });
      const primary = page.getByRole("button", { name: "打开 Claude Desktop", exact: true });
      const envStarts = () => state.requests.filter(request => request.path === "/start").length;
      await navigate.click();
      if (scenario === "warm-running") {
        await page.getByRole("button", { name: "关闭应用", exact: true }).waitFor();
        assert.equal(launches, 0);
        await page.getByRole("button", { name: "Code", exact: true }).click();
        await navigate.click();
        await page.getByRole("button", { name: "关闭应用", exact: true }).waitFor();
      } else {
        await primary.waitFor();
        assert.ok(await primary.isEnabled());
        assert.equal((await primary.boundingBox()).height, 32);
        assert.equal(launches, 0);
        assert.equal(envStarts(), 0);
        if (scenario === "cold") assert.equal(guestReads, 0);
        await primary.click();
        await page.getByRole("button", { name: "关闭应用", exact: true }).waitFor();
      }
      assert.equal(launches, scenario === "warm-running" ? 0 : 1);
      assert.equal(envStarts(), scenario === "cold" ? 1 : 0);
      assert.deepEqual(errors, []);
      console.log(platform, scenario, { launches, environmentStarts: envStarts() });
    } finally { await browser.close(); }
  }
}
