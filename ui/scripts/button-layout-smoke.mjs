import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const workspace = "/projects/layout";
const { browser, page, errors } = await createWorkbench({
  beforeNavigate: async (_page, state) => {
    Object.assign(state.status, { ready: true, vm_running: true, projects: [workspace] });
    state.settings.workspace = workspace;
  },
});
try {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [width, font] of [[1410, 14], [1024, 16], [720, 20], [375, 24]]) {
    await page.setViewportSize({ width, height: 780 });
    await page.locator(".home-composer").waitFor();
    await page.evaluate(size => document.documentElement.style.setProperty("--ui-font-size", size + "px"), font);
    if (width <= 680 && await page.getByRole("button", { name: "收起侧栏" }).isVisible())
      await page.getByRole("button", { name: "收起侧栏" }).click();
    const greeting = page.locator(".welcome-heading:has(.greeting-mark)");
    const rect = await greeting.evaluate(node => {
      const text = node.lastChild;
      const range = document.createRange();
      range.selectNodeContents(text);
      return range.getClientRects()[0].toJSON();
    });
    await page.mouse.move(rect.left + 1, rect.top + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.right - 1, rect.top + rect.height / 2, { steps: 10 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => getSelection().toString()), "");
    assert.equal(await greeting.locator("img").evaluate(img => img.draggable), false);

    const composer = page.locator(".home-composer");
    const send = composer.getByRole("button", { name: "发送", exact: true });
    const sendBounds = await send.boundingBox();
    assert.equal(sendBounds.width, 30);
    assert.equal(sendBounds.height, 30);
    const folderBounds = await composer.locator(".composer-project").boundingBox();
    assert.ok(Math.abs(sendBounds.x - folderBounds.x - folderBounds.width - 8) < 1);
    if (font === 14) {
      const heights = await page.locator(".welcome-shortcuts > button").evaluateAll(items => items.map(el => el.offsetHeight));
      assert.deepEqual(heights, [28, 28, 28]);
    }
    const input = composer.getByRole("textbox");
    const start = await composer.boundingBox();
    await input.fill("可选的消息");
    await input.press("Control+a");
    assert.equal(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), "可选的消息");
    assert.equal(await input.evaluate(el => getComputedStyle(el).borderTopWidth), "0px");
    assert.equal(await input.evaluate(el => getComputedStyle(el).outlineStyle), "none");
    assert.ok(await composer.evaluate(el => getComputedStyle(el).boxShadow.includes("20px") && getComputedStyle(el).outlineStyle === "none"));
    assert.deepEqual(await composer.boundingBox(), start);
    await input.fill("");

    assert.equal(await page.locator(".sidebar-status").count(), 0);
    const stop = page.locator(".status-bar").getByRole("button", { name: "停止环境", exact: true });
    const bounds = await stop.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    await stop.click();
    const confirmation = page.getByRole("dialog", { name: "停止当前环境？" });
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();

    await page.getByRole("button", { name: "打开项目", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "打开项目", exact: true });
    const offset = await dialog.locator("footer").evaluate(footer =>
      footer.getBoundingClientRect().right - footer.querySelector("button.primary").getBoundingClientRect().right
      - parseFloat(getComputedStyle(footer).paddingRight));
    assert.ok(Math.abs(offset) <= 1, `footer edge offset at ${width}px: ${offset}px`);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();

    const trigger = page.getByRole("button", { name: "新建终端", exact: true });
    const before = await trigger.boundingBox();
    await trigger.click();
    const menu = page.getByRole("menu", { name: "新建终端" });
    const icons = await menu.getByRole("menuitem").locator("svg").evaluateAll(items => items.map(svg => svg.innerHTML));
    assert.equal(icons.length, 2);
    assert.equal(icons[0], icons[1]);
    const after = await trigger.boundingBox(), popup = await menu.boundingBox();
    assert.ok(Math.abs(before.y - after.y) <= 1, "opening the menu keeps the trigger in place");
    assert.ok(popup.x >= 0 && popup.x + popup.width <= width + 1);
    assert.ok(Math.min(Math.abs(popup.y - after.y - after.height), Math.abs(after.y - popup.y - popup.height)) <= 8);
    await page.keyboard.press("Escape");
    assert.ok(await trigger.evaluate(node => document.activeElement === node));
    console.log(`PASS ${width}px window / ${font}px text`);
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const touchSend = page.locator(".composer-tools .composer-send");
  const touch = await touchSend.evaluate(el => {
    const style = getComputedStyle(el);
    return [el.offsetWidth, el.offsetHeight, style.width, style.height, style.backgroundClip];
  });
  assert.deepEqual(touch, [44, 44, "30px", "30px", "padding-box"]);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
