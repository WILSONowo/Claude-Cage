// Exercise the disconnected client shell where the workbench has no backend yet.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = process.env.CAGE_REMOTE_QA_DIR;
if (output) await mkdir(output, { recursive: true });
const host = {
  id: "layout-test", name: "开发服务器（新加坡）",
  host: "long-remote-hostname.dev.example", port: 2222, user: "developer",
  auth: { kind: "key_file", identity_file: "/home/example/.ssh/test_key" },
};
for (const [width, height, size, system, expected] of [
  [1280, 850, 14, "light", "dark"], [720, 600, 18, "light", "light"], [375, 640, 24, "dark", "dark"],
]) {
  const view = { mode: "none", client_only: true, desktop_gateway: true, connection_id: "layout",
    connection: { state: "disconnected" }, client_platform: "windows", server_platform: "linux" };
  let hosts = [], appearanceRequests = 0;
  const { browser, page, errors } = await createWorkbench({
    viewport: { width, height }, clientContext: view,
    beforeNavigate: async page => {
      page.on("request", req => { if (new URL(req.url()).pathname === "/api/appearance") appearanceRequests++; });
      await page.emulateMedia({ colorScheme: system, reducedMotion: "reduce" });
      await page.addInitScript(({ mode, size }) => localStorage.setItem("cage-appearance", JSON.stringify({
        mode, uiFontSize: size, reducedMotion: "on",
      })), { mode: width === 1280 ? "dark" : "system", size });
    },
    clientRequest: async (route, path) => {
      if (path === "/client/context") return route.fulfill({ json: view });
      if (path === "/client/hosts") return route.fulfill({ json: { hosts } });
      if (path === "/client/local-status") return route.fulfill({ json: { known: true, available: false } });
      throw Error("Unexpected client request " + path);
    },
  });
  page.setDefaultTimeout(5000);
  const sidebar = page.getByRole("complementary", { name: "SSH 主机" });
  const check = async (surface, name) => {
    await surface.waitFor();
    const issues = await surface.evaluate(root => {
      const nodes = [...root.querySelectorAll("button,input,summary,code,label,footer,p")].filter(n => n.checkVisibility() && n.getClientRects().length);
      const bounds = root.getBoundingClientRect();
      return nodes.flatMap(n => {
        const rect = n.getBoundingClientRect();
        const label = n.ariaLabel || n.textContent.trim().slice(0, 24) || n.tagName;
        const spilled = n.matches("button,summary,code,p") && n.scrollWidth > n.clientWidth + 2;
        if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.right > innerWidth + 1 || spilled) return [label];
        return [];
      });
    });
    assert.deepEqual(issues, [], name + " fits its surface");
    if (output) await page.screenshot({ path: join(output, "ssh-" + width + "-" + name + ".png") });
  };
  try {
    await sidebar.getByText("还没有远程主机").waitFor();
    await page.waitForFunction(([theme, size]) => document.documentElement.dataset.theme === theme &&
      getComputedStyle(document.documentElement).fontSize === size + "px", [expected, size]);
    await check(sidebar, "empty");
    await sidebar.getByRole("button", { name: "添加远程主机" }).click();
    const dialog = page.getByRole("dialog", { name: "添加远程主机" });
    await check(dialog, "add-key");
    const footer = dialog.locator("footer");
    const save = footer.getByRole("button", { name: "保存主机" });
    const rect = await save.boundingBox();
    assert.ok(rect.y >= 0 && rect.y + rect.height <= height, "save stays visible before scrolling");
    assert.ok(await footer.getByRole("button", { name: "取消" }).evaluate(cancel => cancel.compareDocumentPosition(cancel.nextElementSibling) & Node.DOCUMENT_POSITION_FOLLOWING));
    await save.click();
    assert.ok(await dialog.getByLabel("主机名称").evaluate(n => n === document.activeElement && !n.validity.valid));
    await dialog.getByRole("combobox", { name: "SSH 登录方式" }).click();
    await page.getByRole("option", { name: "本机 SSH agent" }).click();
    await dialog.getByText("云端安装路径", { exact: true }).click();
    await dialog.getByLabel("Cage 配置文件", { exact: false }).scrollIntoViewIfNeeded();
    assert.equal(await dialog.getByLabel("本机私钥文件").count(), 0);
    await check(dialog, "advanced-agent");
    const scrolled = await save.boundingBox();
    assert.ok(Math.abs(rect.y - scrolled.y) < 1 || scrolled.y + scrolled.height <= height,
      "expanding paths or scrolling cannot push the footer below the viewport");
    await footer.getByRole("button", { name: "取消" }).click();
    hosts = [host];
    await page.reload();
    await sidebar.getByLabel("密钥口令（如果已设置）").waitFor();
    await sidebar.getByRole("button", { name: "编辑", exact: true }).click();
    await check(page.getByRole("dialog", { name: "编辑远程主机" }), "edit");
    await page.keyboard.press("Escape");
    await sidebar.getByRole("button", { name: "移除连接" }).click();
    await check(page.getByRole("dialog", { name: "移除 SSH 主机" }), "remove");
    await page.keyboard.press("Escape");
    for (const [code, message] of [["host_key_unknown", "首次连接，需要核对主机指纹"], ["host_key_changed", "SSH 主机密钥已变更"]]) {
      view.candidate = { id: "trust", mode: "remote", host_id: host.id, connection: { state: "failed",
        host_id: host.id, error_code: code, message, host_key: { algorithm: "ssh-ed25519", fingerprint: "SHA256:" + "a".repeat(43) } } };
      await page.reload();
      const verify = sidebar.getByRole("button", { name: "确认指纹并信任" });
      await verify.scrollIntoViewIfNeeded();
      await check(sidebar, code);
    }
    for (const [phase, text] of [["cloud_upload_63", "正在上传部署包 63%"], ["cloud_install", "正在安装云端环境…"], ["cloud_start", "正在启动服务…"]]) {
      view.candidate.connection = { state: "connecting", host_id: host.id, phase };
      await page.reload();
      await sidebar.getByRole("button", { name: text, exact: true }).waitFor();
      await check(sidebar, phase);
    }
    assert.equal(appearanceRequests, 0, "disconnected shell uses the cached appearance without a backend request");
    assert.deepEqual(errors, []);
    console.log("PASS SSH " + width + "px / " + size + "px / " + expected);
  } finally { await browser.close(); }
}
