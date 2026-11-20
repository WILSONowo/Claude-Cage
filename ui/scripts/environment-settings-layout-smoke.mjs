import assert from "node:assert/strict";
import { chooseInline, createWorkbench, openWorkbenchSettings } from "./workbench-fixture.mjs";

const { browser, page, state } = await createWorkbench({
  waitForReady: false,
  clientContext: { mode: "local", connection_id: "local", client_platform: "windows", server_platform: "windows" },
  beforeNavigate: async (page, state) => {
    Object.assign(state.status, { local_vm_storage: true, vm_running: true, ready: true, guest_system: "debian" });
    state.settings.browser_graphics = { backend: "", disable_webgl: false, block_canvas_read: false };
    await page.route("**/api/environment/storage", route => route.fulfill({
      json: { directory: "D:\\Cage", has_environment: true },
    }));
  },
});
async function openEnvironmentSettings() {
  await openWorkbenchSettings(page);
  await page.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: "环境与恢复" }).click();
  await page.getByRole("heading", { name: "环境与恢复" }).waitFor();
}
try {
  await openEnvironmentSettings();
  const storage = page.getByRole("region", { name: "本机环境存储" });
  await storage.getByRole("button", { name: "迁移到此位置" }).waitFor();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 850 });
    const positions = await storage.evaluate(element => {
      const project = element.nextElementSibling;
      const diagnostics = element.parentElement.querySelector('section[aria-label="日志与诊断"]');
      const actions = diagnostics.querySelector("button").parentElement;
      return {
        project: project.getBoundingClientRect().top - element.getBoundingClientRect().bottom,
        diagnostics: diagnostics.getBoundingClientRect().top - diagnostics.previousElementSibling.getBoundingClientRect().bottom,
        exportAction: actions.getBoundingClientRect().top - actions.previousElementSibling.getBoundingClientRect().bottom,
      };
    });
    for (const [section, gap] of Object.entries(positions)) {
      assert.ok(gap >= (section === "exportAction" ? 8 : 16) && gap <= 40, `${width}px ${section} gap: ${gap}px`);
    }
    console.log(`${width}px section gaps`, positions);
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  const graphics = page.getByRole("region", { name: "浏览器图形" });
  await chooseInline(graphics.getByRole("combobox", { name: "渲染后端" }), "swiftshader");
  await graphics.getByRole("switch", { name: "关闭 WebGL" }).check();
  await graphics.getByRole("switch", { name: "阻止网页读取 Canvas 图像" }).check();
  assert.equal(await page.getByRole("button", { name: "保存并重启" }).count(), 0);
  const saved = page.waitForRequest(request => request.url().endsWith("/api/settings") && request.method() === "POST");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  assert.deepEqual((await saved).postDataJSON().browser_graphics, {
    backend: "swiftshader", disable_webgl: true, block_canvas_read: true,
  });
  assert.equal(await page.getByRole("dialog", { name: "应用设置并重启环境？" }).count(), 0);
  state.status.guest_system = "windows-11";
  await page.reload();
  await openEnvironmentSettings();
  assert.equal(await graphics.count(), 0, "Windows guests should not show Linux browser controls");
  console.log("Linux browser graphics settings saved while running, Windows guest controls hidden");
} finally {
  await browser.close();
}
