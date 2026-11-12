import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = process.env.CAGE_REMOTE_QA_DIR;
if (output) await mkdir(output, { recursive: true });
for (const [width, height, size, mode] of [[1280, 850, 14, "light"], [375, 640, 24, "dark"]]) {
  let releaseVerification;
  const { browser, page, errors } = await createWorkbench({
    viewport: { width, height },
    beforeNavigate: async (page, state) => {
      Object.assign(state.appearance, { uiFontSize: size, mode, reducedMotion: "on" });
      await page.route("**/api/client/hosts", route => route.fulfill({ json: { hosts: [{
        id: "test", name: "测试主机", user: "user", host: "example.test", port: 22, auth: { kind: "key_file", identity_file: "/isolated/test" },
      }] } }));
      await page.route("**/api/vault", async route => {
        if (route.request().method() === "POST") {
          await new Promise(resolve => { releaseVerification = resolve; });
          return route.fulfill({ status: 400, contentType: "text/plain; charset=utf-8", body: "密码不正确" });
        }
        return route.fulfill({ json: { entries: [{ id: "one", origin: "https://example.test", username: "user" }], blocked: [] } });
      });
    },
  });
  page.setDefaultTimeout(5000);
  async function inspect(input, name) {
    const group = input.locator(".."), eye = group.locator("button.password-reveal");
    await input.waitFor();
    assert.equal(await input.getAttribute("type"), "password");
    assert.ok(await eye.isDisabled());
    await input.evaluate(n => n.blur());
    await page.mouse.move(0, 0);
    const outline = () => group.evaluate(n => getComputedStyle(n).boxShadow);
    assert.match(await outline(), /inset/, name + " has a resting inset border");
    await input.hover(); assert.match(await outline(), /inset/, name + " has a hover inset border");
    await input.focus(); await input.press("Tab");
    assert.ok(!await eye.evaluate(n => n === document.activeElement), "empty field skips inactive reveal");
    await input.fill("Sample!");
    assert.ok(await eye.isEnabled());
    const geometry = await group.evaluate(n => {
      const input = n.querySelector("input"), eye = n.querySelector("button"), icon = eye.querySelector("svg");
      const [box, text, button, graphic] = [n, input, eye, icon].map(e => e.getBoundingClientRect());
      return {
        border: getComputedStyle(n).borderLeftWidth,
        innerBorder: getComputedStyle(input).borderLeftWidth,
        label: input.labels[0]?.textContent,
        labelGap: box.top - input.labels[0].getBoundingClientRect().bottom,
        fieldGap: parseFloat(getComputedStyle(n.parentElement).rowGap),
        tied: eye.getAttribute("aria-controls") === input.id,
        icons: eye.querySelectorAll("svg").length,
        fits: button.right <= box.right && graphic.right <= button.right && graphic.left >= button.left &&
          graphic.bottom <= button.bottom && graphic.top >= button.top && text.right <= button.left + 1,
        inputOutline: getComputedStyle(input).outlineStyle, ring: getComputedStyle(n).boxShadow,
      };
    });
    assert.equal(geometry.border, "0px", name + " draws its border with the inset shadow");
    assert.equal(geometry.innerBorder, "0px", name);
    assert.equal(geometry.inputOutline, "none", name);
    assert.notEqual(geometry.ring, "none", name);
    assert.ok(Math.abs(geometry.labelGap - geometry.fieldGap) <= 1, name + " label follows the field spacing");
    assert.ok(geometry.label && geometry.tied && geometry.fits && geometry.icons === 1, name + " " + JSON.stringify(geometry));
    await input.press("Tab");
    assert.ok(await eye.evaluate(n => n === document.activeElement && getComputedStyle(n).outlineStyle !== "none"), name);
    await eye.press("Space"); assert.equal(await input.getAttribute("type"), "text");
    await eye.press("Enter"); assert.equal(await input.getAttribute("type"), "password");
    if (output) await group.screenshot({ path: join(output, "control-" + name + "-" + width + ".png") });
    await input.focus();
    await input.evaluate(n => n.setSelectionRange(2, 5));
    await eye.click();
    assert.ok(await input.evaluate(n => n === document.activeElement && n.selectionStart === 2 && n.selectionEnd === 5), name);
    await input.fill("");
    assert.equal(await input.getAttribute("type"), "password");
    assert.ok(await eye.isDisabled());
  }
  async function section(name) {
    await page.locator(".settings-content").waitFor();
    const compact = page.getByRole("combobox", { name: "设置分组" });
    if (await compact.isVisible()) {
      await compact.click();
      await page.getByRole("option", { name, exact: true }).click();
    } else await page.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name, exact: true }).click();
  }
  const sidebar = page.getByRole("complementary", { name: "项目与终端" });
  const openSidebar = async () => {
    if (!await sidebar.isVisible()) await page.getByRole("button", { name: "展开侧栏", exact: true }).first().click();
  };
  try {
    await openSidebar();
    await sidebar.getByRole("button", { name: "SSH 主机", exact: true }).click();
    await inspect(page.getByLabel("密钥口令（如果已设置）", { exact: true }), "ssh");
    await page.getByRole("button", { name: "返回工作台侧栏" }).click();
    await openSidebar();
    await sidebar.getByRole("button", { name: "设置", exact: true }).click();
    await section("网络与代理");
    await page.getByRole("button", { name: "添加来源", exact: true }).click();
    await page.getByRole("button", { name: "手动节点", exact: true }).click();
    await inspect(page.getByLabel("密码", { exact: true }), "proxy");
    await page.locator(".proxy-import").getByRole("button", { name: "取消", exact: true }).click();
    await section("远程连接");
    await page.getByRole("button", { name: "自建中继", exact: true }).click();
    await inspect(page.getByLabel("管理令牌（可选）", { exact: true }), "relay");
    await section("密码保险箱");
    await page.getByRole("button", { name: "添加密码", exact: true }).click();
    await inspect(page.getByLabel("网站密码", { exact: true }), "vault");
    await page.locator(".vault-editor").getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "查看密码", exact: true }).click();
    const authorization = page.getByLabel("Cage 账户密码", { exact: true });
    await inspect(authorization, "verification");
    await authorization.fill("incorrect");
    await page.getByRole("button", { name: "验证并查看", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".vault-editor input.password-value:disabled"));
    assert.ok(await authorization.locator("..").locator("button").isDisabled());
    assert.equal(await page.getByLabel("已保存的网站密码", { exact: true }).count(), 0);
    releaseVerification();
    await page.getByRole("alert").filter({ hasText: "密码不正确" }).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS SSH, proxy, relay and vault input/authorization controls", width, size, mode);
  } finally { releaseVerification?.(); await browser.close(); }
}
