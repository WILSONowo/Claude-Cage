import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const { browser, page, state, errors } = await createWorkbench({
  beforeNavigate(_page, state) {
    Object.assign(state.status, { vm_running: true, ready: true });
    state.appearance.mode = process.env.CAGE_HOME_THEME || "dark";
  },
});
try {
  const home = page.locator(".welcome-content");
  const input = home.getByRole("textbox", { name: "消息" });
  await input.fill("尚未发送的草稿");
  const safetyMessage = "正在核对静态 IP 或动态地区范围…";
  for (const [kind, title, message, running] of [
    ["safety", "正在检查网络", safetyMessage, true],
    ["stop", "正在停止环境", "正在关闭服务…", true],
    ["project", "正在打开项目", "正在连接项目文件夹…", true],
    ["start", "正在启动环境", "正在启动服务…", false],
  ]) {
    state.status.safety = { gate: { mode: kind === "safety" ? "checking" : "closed", until: new Date(Date.now() + 60_000).toISOString() } };
    state.status.job = { id: kind, kind, message, running: true };
    state.status.vm_running = state.status.ready = running;
    await home.getByRole("heading", { name: title }).waitFor();
    assert.equal(await home.getByRole("status").innerText(), message);
    assert.notEqual(await page.locator(".status-feedback").innerText(), message);
    assert.equal(await input.isVisible(), false);
    assert.equal(await home.locator(".start-project-box,.welcome-shortcuts,.onboarding-steps").count(), 0);
    const details = home.getByRole("button", { name: "查看操作详情" });
    await details.click();
    await page.getByRole("region", { name: "日志内容" }).waitFor();
    await page.keyboard.press("Escape");
    if (kind === "safety") {
      if (process.env.CAGE_HOME_PROGRESS_SCREENSHOT) await page.screenshot({ path: process.env.CAGE_HOME_PROGRESS_SCREENSHOT });
      state.status.job = { ...state.status.job, running: false };
      await input.waitFor();
      assert.equal(await input.inputValue(), "尚未发送的草稿");
      assert.equal(await home.getByRole("button", { name: "新建终端" }).isEnabled(), true);
      await page.setViewportSize({ width: 580, height: 540 });
    }
  }
  state.status.job = { ...state.status.job, running: false, error: "模拟启动失败", message: "启动未完成" };
  await home.getByRole("alert").getByText("模拟启动失败").waitFor();
  assert.equal(await home.locator(".start-project-box").isVisible(), true);
  state.status.vm_running = true;
  state.status.job = { running: false };
  await home.getByRole("button", { name: "恢复浏览器" }).waitFor();
  assert.equal(await home.getByRole("button", { name: "新建终端" }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log("Home progress, details, drafts, failure and browser recovery passed.");
} finally { await browser.close(); }
