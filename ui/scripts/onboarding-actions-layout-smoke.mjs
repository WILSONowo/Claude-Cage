import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = process.env.CAGE_ONBOARDING_LAYOUT_OUTPUT;
if (output) await mkdir(output, { recursive: true });

async function checkPair(page, surface, labels, scene, vertical = false) {
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const buttons = labels.map(name => surface.getByRole("button", { name, exact: true }));
    const [a, b] = await Promise.all(buttons.map(button => button.boundingBox()));
    assert.ok(a && b, scene + " buttons visible");
    const sideBySide = Math.abs(a.y - b.y) <= 1;
    const gap = sideBySide ? b.x - a.x - a.width : b.y - a.y - a.height;
    assert.ok(!vertical || !sideBySide, scene + " stacked actions");
    assert.ok(gap >= 6, `${scene} action gap ${gap}px at ${width}px`);
    if (sideBySide) assert.ok(Math.abs(a.height - b.height) <= 1, scene + " unequal heights");
    assert.ok([a, b].every(rect => rect.x >= 0 && rect.x + rect.width <= width + 1), scene + " overflow");
    if (output && width !== 390) {
      await surface.screenshot({ path: path.join(output, `${scene}-${width}.png`), animations: "disabled" });
    }
    console.log(scene, width, gap);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

for (const account of [false, true]) {
  const { page, browser, errors, state } = await createWorkbench({
    waitForReady: false, initialization: { required: !account, tracked: true },
    beforeNavigate: async (page, state) => {
      state.appearance.mode = "dark";
      await page.emulateMedia({ colorScheme: "dark" });
      if (account) {
        Object.assign(state.account, { unlocked: false, recovery_ready: true });
        await page.route("**/api/account/recovery-reset", route => route.fulfill({
          json: { ...state.account, recovery_key: "layout-test-key" },
        }));
        return;
      }
      state.status.local_vm_storage = true;
      state.hostGit = { state: "unset", ready: false, can_enable: true, message: "启动前需要启用本机 Git 安全保护。" };
      const fixtures = {
        "environment/storage": { directory: "D:\\Cage", has_environment: false },
        "environment/guest-systems": { fresh: true, available: true, system: "debian" },
        proxy: { active: true, selected: "node", sources: [{ id: "s", name: "测试", nodes: [{ id: "node", name: "节点", type: "socks5" }] }], port: 17896, core_available: true },
      };
      for (const [endpoint, json] of Object.entries(fixtures)) {
        await page.route("**/api/" + endpoint, route => route.fulfill({ json }));
      }
    },
  });
  try {
    if (account) {
      await page.getByRole("button", { name: "忘记密码？" }).click();
      const recovery = page.getByRole("region", { name: "恢复账户" });
      await checkPair(page, recovery, ["重置密码", "返回密码登录"], "account-recovery", true);
      await recovery.getByLabel("已保存的恢复密钥").fill("old-layout-test-key");
      await recovery.getByLabel("新密码", { exact: true }).fill("test");
      await recovery.getByLabel("确认新密码", { exact: true }).fill("test");
      await recovery.getByRole("button", { name: "重置密码" }).click();
      const saved = page.getByRole("region", { name: "保存恢复密钥" });
      await checkPair(page, saved, ["复制恢复密钥", "下载密钥文件"], "account-save-key");
      const confirm = saved.locator(".account-device-option");
      const confirmBox = await confirm.boundingBox();
      const next = await saved.getByRole("button", { name: "返回登录" }).boundingBox();
      assert.ok(next.y - confirmBox.y - confirmBox.height >= 6, "saved confirmation has space before continue");
    } else {
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: "开始安装" }).click();
      const git = page.getByRole("region", { name: "Git 安全保护" });
      await checkPair(page, git, ["启用 Git 保护", "重新检查并安装"], "initialization-git");
      Object.assign(state.hostGit, { can_enable: false, state: "unavailable" });
      await git.getByRole("button", { name: "重新检查并安装" }).click();
      await git.getByRole("button", { name: "启用 Git 保护" }).waitFor({ state: "detached" });
      const message = await git.locator("p").last().boundingBox();
      const retry = await git.getByRole("button", { name: "重新检查并安装" }).boundingBox();
      assert.ok(retry.y - message.y - message.height >= 6, "single retry below message");
      await page.getByRole("tab", { name: "订阅" }).click();
      await page.getByRole("button", { name: "添加来源", exact: true }).click();
      await page.getByRole("button", { name: "上一步" }).click();
      const dialog = page.getByRole("dialog", { name: "放弃尚未应用的代理修改？" });
      await checkPair(page, dialog, ["取消", "放弃修改"], "initialization-confirm");
      await dialog.getByRole("button", { name: "取消" }).click();
      await page.locator(".proxy-import").waitFor();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
