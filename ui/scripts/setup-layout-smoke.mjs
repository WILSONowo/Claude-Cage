// Serve the built workbench and run installation-preview.mjs before this check.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.CAGE_PLAYWRIGHT_MODULE || "playwright",
);
const preview = process.env.CAGE_INSTALL_PREVIEW_URL || "http://127.0.0.1:5208";
const output = process.env.CAGE_INITIALIZATION_EVIDENCE;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CAGE_TEST_BROWSER_PATH,
});
const results = [];
const matrix = [
  [
    "create",
    "account",
    { exists: false, unlocked: false, username: "" },
    ".account-gate",
  ],
  [
    "locked",
    "account",
    {
      exists: true,
      unlocked: false,
      username: "工程测试工作区".repeat(3),
      background_running: true,
    },
    ".account-gate",
  ],
  [
    "trusted",
    "account",
    {
      exists: true,
      unlocked: false,
      username: "本机用户",
      trusted_local: true,
      require_authentication: true,
    },
    ".account-gate",
  ],
  [
    "bad-login",
    "account",
    { exists: true, unlocked: false, username: "测试账户" },
    ".account-gate",
  ],
  [
    "shared-account",
    "download",
    {
      exists: true,
      unlocked: true,
      macos_account_host: true,
      macos_credentials_ready: false,
      initial_mac_setup: true,
      username: "fixture",
    },
    ".account-gate",
  ],
  ["reconnect", "account", "offline", ".account-gate"],
  ["storage", "download", null, ".initialization"],
  ["proxy", "download", null, ".initialization"],
  ["cached", "cached", null, ".initialization"],
  ["resume", "resume", null, ".initialization"],
  ["progress", "progress", null, ".initialization"],
  ["failure", "failure", null, ".initialization"],
  ["completed", "ready", null, ".initialization"],
  ["low-space", "space", null, ".initialization"],
  ["startup", "workbench", null, ".welcome"],
];
try {
  for (const [width, height, size, theme] of [
    [1280, 820, 14, "light"],
    [1280, 820, 14, "dark"],
    [375, 680, 24, "dark"],
    [540, 720, 20, "light"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    for (const [name, base, account, selector] of matrix) {
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/api/appearance", async (route) => {
        const response = await route.fetch();
        const appearance = await response.json();
        appearance.uiFontSize = size;
        appearance.mode = theme;
        await route.fulfill({ json: appearance });
      });
      if (name === "trusted")
        await page.route("**/api/client/context", async (route) => {
          const data = await (await route.fetch()).json();
          data.desktop_gateway = true;
          data.connection = { state: "connected" };
          data.connection_id = "local";
          await route.fulfill({ json: data });
        });
      if (account)
        await page.route("**/api/account", (r) =>
          account === "offline"
            ? r.fulfill({
                status: 503,
                contentType: "text/plain;charset=utf-8",
                body: "连接暂时不可用",
              })
            : r.fulfill({ json: account }),
        );
      if (name === "bad-login")
        await page.route("**/api/account/unlock", (r) =>
          r.fulfill({
            status: 401,
            contentType: "text/plain;charset=utf-8",
            body: "密码不正确",
          }),
        );
      await page.goto(new URL("/?host=windows&state=" + base, preview).href);
      const root = page.locator(selector).first();
      await root.waitFor();
      if (name === "reconnect")
        await root.getByRole("button", { name: "重新连接" }).waitFor();
      if (name === "proxy") {
        const nxt = root.getByRole("button", { name: "下一步" });
        const terms = root.getByRole("checkbox");
        if (await terms.count()) await terms.check();
        await nxt.click();
        await root.locator(".proxy-manager").waitFor();
      }
      if (name === "bad-login") {
        await root
          .getByLabel("账户密码", { exact: true })
          .fill("preview-invalid");
        await root
          .getByRole("button", { name: "解锁 Cage", exact: true })
          .click();
        await root.getByRole("alert").waitFor();
      }
      if (["progress", "failure"].includes(name))
        await root.locator(".setup-transfer").waitFor();
      if (name === "trusted")
        await root
          .getByRole("button", { name: "重新进入本机工作区" })
          .waitFor();
      if (["cached", "low-space"].includes(name)) {
        const picker = root.getByRole("combobox", { name: "客户机系统" });
        await picker.click();
        await page
          .getByRole("option", { name: "自动匹配本机系统版本", exact: true })
          .click();
        await root.getByRole("checkbox").check();
        await root.getByRole("button", { name: "下一步" }).click();
        await root
          .getByText(
            name === "cached" ? /已找到匹配的本地镜像/ : /当前可用.*GiB/,
          )
          .waitFor();
      }
      if (name === "storage")
        await root.locator(".initialization-directory-control input").waitFor();
      if (name === "completed")
        await root.getByRole("heading", { name: "环境已就绪" }).waitFor();
      if (name === "startup") {
        const close = page.getByRole("button", {
          name: "收起侧栏",
          exact: true,
        });
        if (width < 680 && (await close.isVisible())) await close.click();
        await root.locator(".start-project-box").waitFor();
      }
      if (name === "create")
        await root.getByLabel("用户名", { exact: true }).waitFor();
      if (name === "locked")
        await root.getByLabel("账户密码", { exact: true }).waitFor();
      await root.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .filter((a) =>
              Number.isFinite(a.effect?.getComputedTiming().endTime),
            )
            .map((a) => a.finished),
        );
      });
      const report = await root.evaluate((root) => {
        const clip = root.getBoundingClientRect(),
          issues = [];
        for (const n of [
          root,
          ...root.querySelectorAll(
            "button,input,h1,h2,fieldset,label,section,li,p,[role=combobox]",
          ),
        ]) {
          const b = n.getBoundingClientRect(),
            s = getComputedStyle(n);
          if (!b.width || !b.height || !n.checkVisibility()) continue;
          const txt =
            n.ariaLabel ||
            n.title ||
            n.innerText ||
            n.placeholder ||
            n.className;
          if (
            n !== root &&
            (b.right > clip.right + 2 || b.left < clip.left - 2)
          )
            issues.push("outside " + txt);
          if (
            n.clientWidth &&
            n.scrollWidth > n.clientWidth + 2 &&
            n.matches("button,h1,h2,fieldset,label,li,p") &&
            s.overflowX === "visible"
          )
            issues.push("spill " + txt);
          if (
            n.matches("button") &&
            n.innerText.trim() &&
            s.overflowY === "visible" &&
            n.scrollHeight > n.clientHeight + 2
          )
            issues.push("text height " + txt);
        }
        const reference = document.createElement("span");
        reference.style.cssText =
          "position:absolute;visibility:hidden;height:var(--control-height);border-radius:var(--panel-radius)";
        root.append(reference);
        const height = reference.getBoundingClientRect().height;
        const buttonRadius = getComputedStyle(reference).borderTopLeftRadius;
          reference.style.borderRadius = "var(--field-radius)";
          const fieldRadius = getComputedStyle(reference).borderTopLeftRadius;
        reference.remove();
        for (const field of root.querySelectorAll(
          ".account-field > input,.account-field > .password-input,.initialization-directory-control input,button.account-submit,.initialization-actions .primary",
        )) {
          if (!field.checkVisibility()) continue;
          if (
            field.getBoundingClientRect().height < height - 1 ||
            getComputedStyle(field).borderTopLeftRadius !== (field.tagName === "BUTTON" ? buttonRadius : fieldRadius)
          ) {
            issues.push(
              "field size or radius " + (field.id || field.className),
            );
          }
        }
        return {
          issues,
          docOverflow: document.documentElement.scrollWidth - innerWidth,
          heading: root.querySelector("h1")?.innerText,
          actualFont: getComputedStyle(document.documentElement).fontSize,
          theme: document.documentElement.dataset.theme,
        };
      });
      const issues = [...report.issues, ...errors];
      if (report.docOverflow > 1)
        issues.push("doc overflow " + report.docOverflow);
      if (report.actualFont !== size + "px" || report.theme !== theme)
        issues.push(
          "unexpected font/theme " + report.actualFont + "/" + report.theme,
        );
      results.push({
        name,
        width,
        size,
        theme,
        heading: report.heading,
        issues,
      });
      console.log(width, theme, name, issues.length ? issues : "PASS");
      if (
        output &&
        [
          "locked",
          "storage",
          "proxy",
          "progress",
          "failure",
          "startup",
          "create",
          "shared-account",
          "completed",
        ].includes(name)
      ) {
        await page.screenshot({
          path: join(output, name + "-" + width + "-" + theme + ".png"),
        });
      }
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
  if (output)
    await writeFile(
      join(output, "matrix.json"),
      JSON.stringify(results, null, 2),
    );
}
assert.equal(results.filter((r) => r.issues.length).length, 0);
assert.equal(results.length, matrix.length * 4);
