import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createWorkbench } from "./workbench-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  root,
  configFile: join(root, "vite.config.js"),
  server: { host: "127.0.0.1", port: 0 },
});
const output = process.env.CAGE_PASSWORD_EVIDENCE;
if (output) await mkdir(output, { recursive: true });
await vite.listen();
// Edge exposes its native reveal control only in the browser's user-agent shadow tree.
async function checkEdgeReveal(page, input) {
  if (!(await page.evaluate(() => CSS.supports("selector(input::-ms-reveal)"))))
    return;
  const devtools = await page.context().newCDPSession(page);
  try {
    await devtools.send("DOM.enable");
    await devtools.send("CSS.enable");
    const { root } = await devtools.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    function descendants(node) {
      return [
        node,
        ...[...(node.children || []), ...(node.shadowRoots || [])].flatMap(
          descendants,
        ),
      ];
    }
    const id = await input.getAttribute("id");
    const field = descendants(root).find(
      (node) => node.nodeName === "INPUT" && node.attributes?.includes(id),
    );
    const nativeEye = descendants(field).find((node) =>
      node.attributes?.includes("-ms-reveal"),
    );
    assert.ok(nativeEye, "Edge native reveal control exists");
    const { computedStyle } = await devtools.send(
      "CSS.getComputedStyleForNode",
      { nodeId: nativeEye.nodeId },
    );
    assert.equal(
      computedStyle.find((entry) => entry.name === "display")?.value,
      "none",
    );
  } finally {
    await devtools.detach();
  }
}

const checks = [];
try {
  for (const [width, font, theme, forcedColors] of [
    [1280, 14, "light", "none"],
    [1280, 14, "dark", "none"],
    [375, 24, "dark", "none"],
    [375, 24, "light", "active"],
  ]) {
    const fixture = await createWorkbench({
      url: `http://127.0.0.1:${vite.httpServer.address().port}`,
      viewport: { width, height: 820 },
      waitForReady: false,
      clientContext: {
        mode: "local",
        connection_id: "fixture",
        desktop_gateway: true,
        client_platform: "windows",
        server_platform: "windows",
        connection: { state: "connected" },
      },
      beforeNavigate: async (page, state) => {
        await page.emulateMedia({
          colorScheme: theme,
          forcedColors,
          reducedMotion: "reduce",
        });
        Object.assign(state.appearance, { mode: theme, uiFontSize: font });
        Object.assign(state.account, {
          exists: true,
          unlocked: false,
          username: "布局验收",
        });
      },
    });
    const { page, browser, state, errors } = fixture;
    try {
      const checkField = async (label, section, scene) => {
        const input = section.getByLabel(label, { exact: true });
        const shell = input.locator("..");
        const reveal = shell.getByRole("button", {
          name: `显示${label}`,
          exact: true,
        });
        await input.waitFor();
        assert.equal(await input.getAttribute("type"), "password");
        assert.equal(
          await reveal.getAttribute("aria-controls"),
          await input.getAttribute("id"),
        );
        assert.equal(await reveal.getAttribute("aria-pressed"), "false");
        assert.equal(await reveal.isDisabled(), true);
        await input.focus();
        await input.press("Tab");
        assert.equal(
          await reveal.evaluate((el) => el.matches(":focus")),
          false,
        );
        if (scene === "login") {
          await input.pressSequentially("demo-password");
          await checkEdgeReveal(page, input);
        } else await input.fill("demo-password");
        await input.focus();
        await input.press("Tab");
        assert.equal(
          await reveal.evaluate((el) => el.matches(":focus-visible")),
          true,
        );
        await reveal.press("Enter");
        assert.equal(await input.getAttribute("type"), "text");
        assert.equal(await reveal.getAttribute("aria-pressed"), "true");
        await reveal.press("Space");
        assert.equal(await input.getAttribute("type"), "password");
        assert.equal(await input.inputValue(), "demo-password");
        assert.equal(await page.evaluate(() => window.passwordSubmits || 0), 0);
        await input.focus();
        await input.evaluate((el) => el.setSelectionRange(2, 5));
        await reveal.click();
        assert.deepEqual(
          await input.evaluate((el) => [
            el.matches(":focus"),
            el.selectionStart,
            el.selectionEnd,
          ]),
          [true, 2, 5],
        );
        await reveal.click();
        await input.press("ArrowRight");
        await input.scrollIntoViewIfNeeded();
        await input.hover();
        const geometry = await shell.evaluate((node) => {
          const probe = document.createElement("span");
          probe.style.boxShadow = "var(--field-ring)";
          node.append(probe);
          const expectedShadow = getComputedStyle(probe).boxShadow;
          probe.remove();
          const input = node.querySelector("input"),
            eye = node.querySelector("button");
          const rect = node.getBoundingClientRect(),
            inputRect = input.getBoundingClientRect(),
            eyeRect = eye.getBoundingClientRect();
          return {
            expectedShadow,
            outside: rect.right > innerWidth + 1 || rect.left < -1,
            overlap: inputRect.right > eyeRect.left + 1,
            inside:
              eyeRect.top >= rect.top &&
              eyeRect.bottom <= rect.bottom &&
              eyeRect.right <= rect.right,
            border: [node, input, eye].map((el) =>
              parseFloat(getComputedStyle(el).borderLeftWidth),
            ),
            innerRing: getComputedStyle(input).outlineStyle,
            innerShadow: getComputedStyle(input).boxShadow,
            outerRing: getComputedStyle(node).outlineStyle,
            outerShadow: getComputedStyle(node).boxShadow,
          };
        });
        assert.equal(geometry.outside, false);
        assert.equal(geometry.overlap, false);
        assert.equal(geometry.inside, true);
        assert.deepEqual(geometry.border, [forcedColors === "active" ? 1 : 0, 0, 0]);
        assert.equal(geometry.innerRing, "none");
        assert.equal(geometry.innerShadow, "none");
        if (forcedColors === "active")
          assert.equal(geometry.outerRing, "solid");
        else {
          assert.notEqual(geometry.expectedShadow, "none");
          assert.equal(geometry.outerShadow, geometry.expectedShadow);
        }
        if (
          output &&
          (scene === "login" ||
            scene === "shared" ||
            (scene === "settings" && label === "当前密码"))
        ) {
          await page.screenshot({
            path: join(
              output,
              `${scene}-${width}-${theme}-${forcedColors}.png`,
            ),
          });
          const field = await input.locator("../..").boundingBox();
          // Include focus rings outside the border in the per-field crop.
          const x = Math.max(0, Math.floor(field.x - 5)),
            y = Math.max(0, Math.floor(field.y - 5));
          await page.screenshot({
            path: join(
              output,
              `field-${scene}-${width}-${theme}-${forcedColors}.png`,
            ),
            clip: {
              x,
              y,
              width: Math.min(width - x, Math.ceil(field.width + 10)),
              height: Math.min(820 - y, Math.ceil(field.height + 10)),
            },
          });
        }
        await input.fill("");
        assert.equal(await reveal.isDisabled(), true);
        checks.push([width, font, theme, forcedColors, scene, label]);
      };
      const listen = () =>
        page.evaluate(() => {
          window.passwordSubmits = 0;
          document.addEventListener(
            "submit",
            () => {
              window.passwordSubmits++;
            },
            true,
          );
        });
      await listen();
      const gate = page.locator(".account-entry");
      await checkField("账户密码", gate, "login");
      const login = gate.getByLabel("账户密码", { exact: true });
      await login.fill(state.accountPassword);
      await login.press("Enter");
      await page.locator(".workbench-shell").waitFor();
      assert.equal(await page.evaluate(() => window.passwordSubmits), 1);
      await page
        .getByRole("button", { name: "启动 Cage 环境", exact: true })
        .waitFor();
      await page.evaluate(() => window.cageNativeAction("settings"));
      await page.locator(".settings-content").waitFor();
      const navigation = page.getByRole("navigation", { name: "设置分组" });
      if (await navigation.isVisible())
        await navigation
          .getByRole("button", { name: "账户", exact: true })
          .click();
      else {
        await page.getByRole("combobox", { name: "设置分组" }).click();
        await page.getByRole("option", { name: "账户", exact: true }).click();
      }
      const settings = page.locator(".account-settings");
      await settings.waitFor();
      await listen();
      for (const label of ["当前密码", "新密码", "确认新密码", "验证账户密码"])
        await checkField(label, settings, "settings");
      Object.assign(state.account, {
        exists: false,
        unlocked: false,
        username: "",
      });
      await page.reload();
      await listen();
      const username = gate.getByLabel("用户名", { exact: true });
      const checkUsernameEdge = async (token, focused = false) => {
        const result = await username.evaluate((node, token) => {
          const probe = document.createElement("span");
          probe.style.boxShadow = `var(${token})`;
          node.after(probe);
          const expected = getComputedStyle(probe).boxShadow;
          probe.remove();
          const style = getComputedStyle(node);
          return { expected, actual: style.boxShadow, outline: style.outlineStyle, border: style.borderLeftWidth };
        }, token);
        assert.equal(result.border, forcedColors === "active" ? "1px" : "0px");
        if (forcedColors === "active") {
          if (focused) assert.equal(result.outline, "solid");
        } else {
          assert.notEqual(result.expected, "none");
          assert.equal(result.actual, result.expected);
        }
      };
      await gate.getByLabel("设置密码", { exact: true }).focus();
      await page.mouse.move(0, 0);
      await checkUsernameEdge("--field-shadow");
      await username.hover();
      await checkUsernameEdge("--field-shadow-hover");
      await username.focus();
      await checkUsernameEdge("--field-ring", true);
      for (const label of ["设置密码", "确认密码"])
        await checkField(label, gate, "register");
      Object.assign(state.account, {
        exists: true,
        unlocked: true,
        trusted_local: true,
        macos_account_host: true,
        macos_credentials_ready: false,
        initial_mac_setup: true,
      });
      await page.reload();
      await listen();
      for (const label of ["设置密码", "确认密码"])
        await checkField(label, gate, "shared");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
} finally {
  await vite.close();
}
if (output)
  await writeFile(
    join(output, "assertions.json"),
    JSON.stringify(checks, null, 2),
  );
console.log(`PASS ${checks.length} password field, keyboard and focus checks`);
