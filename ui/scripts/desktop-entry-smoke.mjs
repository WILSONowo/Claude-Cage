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
        await page.route("**/api/vnc-credentials", route => route.fulfill({ status: 503, body: "Browser display pending" }));
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
      if (scenario === "warm-running" && platform === "debian-13") {
        const reconnect = page.getByRole("button", { name: "重新连接画面", exact: true });
        const details = page.getByRole("button", { name: "查看操作详情", exact: true });
        await reconnect.waitFor();
        const [first, second] = await Promise.all([reconnect.boundingBox(), details.boundingBox()]);
        assert.equal(first.height, 32);
        assert.equal(second.height, 32);
        assert.equal(first.y, second.y);
        assert.equal(second.x - first.x - first.width, 8);
        await page.getByRole("button", { name: "打开浏览器", exact: true }).click();
        await page.locator(".claude-desktop-view").waitFor({ state: "detached" });
        await reconnect.waitFor();
        assert.equal(await reconnect.evaluate(button => button.getBoundingClientRect().height), 32);
        assert.equal(await details.count(), 0);
      }
      assert.deepEqual(errors, []);
      console.log(platform, scenario, { launches, environmentStarts: envStarts() });
    } finally { await browser.close(); }
  }
}

// Before 0.1.22, leaving Home unmounted the guest picker and cleared its choice.
// Older Linux accounts then went back to Home without ever requesting /start.
for (const scenario of ["legacy", "legacy-retry", "code-start", "finish-in-code"]) {
  let launches = 0;
  const { page, browser, state, errors } = await createWorkbench({
    clientContext: { mode: "local", connection_id: "local", client_platform: "windows", server_platform: "windows", connection: { state: "disconnected" } },
    beforeNavigate: async (page, state) => {
      state.status.local_vm_storage = true;
      await page.emulateMedia({ colorScheme: "dark" });
      await page.route("**/api/environment/guest-systems", route => route.fulfill({ json: { fresh: false } }));
      let appRunning = false;
      await page.route("**/api/claude-desktop", route => route.fulfill({ json: { installed: true, managed: true, running: appRunning } }));
      await page.route("**/api/claude-desktop/start", route => {
        assert.ok(state.status.vm_running);
        launches++;
        appRunning = true;
        return route.fulfill({ json: state.status.job = { id: "app", kind: "claude-desktop-start", running: false } });
      });
    },
  });
  try {
    let starts = 0;
    await page.route("**/api/start", route => {
      starts++;
      state.status.job = { id: "env-" + starts, kind: "start", running: true, message: "正在启动测试环境 " + starts };
      return route.fulfill({ json: state.status.job });
    });
    const button = name => page.getByRole("button", { name, exact: true });
    const desktop = button("Claude Desktop"), code = button("Code"), open = button("打开 Claude Desktop");
    const heading = page.getByRole("heading", { name: "正在启动环境", exact: true });
    const message = "正在启动浏览器、编辑器与共享文件…";
    const progress = page.locator("main").getByText(message, { exact: true });
    if (scenario === "code-start") {
      await button("启动 Cage 环境").click();
    } else {
      await desktop.click();
      await open.click();
    }
    await heading.waitFor();
    await page.locator("main").getByText("正在启动测试环境 1", { exact: true }).waitFor();
    assert.equal(starts, 1);
    // The VM is already up while its browser/editor/share services are still starting.
    state.status.vm_running = true;
    state.status.job.message = message;
    await code.click();
    await progress.waitFor();
    const codeText = await page.locator("main .welcome-content").innerText();
    await desktop.click();
    await progress.waitFor({ timeout: 8000 });
    assert.equal(await page.locator("main .welcome-content").innerText(), codeText);
    await button("查看操作详情").click();
    await page.getByRole("dialog", { name: "操作详情" }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await open.count(), 0);
    if (scenario === "legacy-retry") {
      state.status.vm_running = false;
      Object.assign(state.status.job, { running: false, error: "测试：环境未启动" });
      await open.click({ timeout: 10000 });
      await page.locator("main").getByText("正在启动测试环境 2", { exact: true }).waitFor();
    }
    if (scenario === "finish-in-code") await code.click();
    Object.assign(state.status, { vm_running: true, ready: true });
    state.status.job.running = false;
    if (scenario === "code-start") {
      await open.waitFor();
      assert.equal(launches, 0, "changing tabs cannot launch an application");
    } else {
      if (scenario === "finish-in-code") {
        const deadline = Date.now() + 10000;
        while (!launches && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(launches, 1, "launch continues while Code is selected");
        assert.equal(await code.getAttribute("aria-pressed"), "true");
        await desktop.click();
      }
      await button("关闭应用").waitFor();
      assert.equal(launches, 1);
    }
    assert.equal(starts, scenario === "legacy-retry" ? 2 : 1);
    assert.deepEqual(errors, []);
    console.log("switching workspace during startup:", scenario, { starts, launches });
  } finally { await browser.close(); }
}
