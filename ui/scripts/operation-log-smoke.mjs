import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createWorkbench } from "./workbench-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = process.env.CAGE_UI_URL;
const vite = target ? null : await createServer({ root, configFile: `${root}/vite.config.js`, server: { host: "127.0.0.1", port: 0, hmr: false } });
const evidence = process.env.CAGE_OPERATION_LOG_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
const output = [
  "Checking image cache...", "  cache hit: base.img", "Verifying SHA-256 digest...",
].join("\n") + "\n";
const longOutput = output + '  <manifest> & "cache" — 保留原始缩进\n\n'
  + "sha256:" + "b".repeat(64) + "\n"
  + Array.from({ length: 100 }, (_, i) => `  unpacking package ${i}\n`).join("");
await vite?.listen();
const url = target || `http://127.0.0.1:${vite.httpServer.address().port}`;
try {
  for (const [entry, width, font, mode] of [
    ["initialization", 1280, 14, "light"], ["initialization", 375, 24, "dark"],
    ["workbench", 1024, 16, "dark"], ["mac", 560, 20, "light"],
  ]) {
    let clipboard, rejectCopy = false;
    const { page, browser, state, errors } = await createWorkbench({
      url,
      viewport: { width, height: width === 375 ? 620 : 760 },
      waitForReady: false,
      initialization: { required: entry === "initialization", tracked: true, started: true },
      nativeRequest: body => {
        if (body.action === "clipboardWrite") {
          if (rejectCopy) throw new Error("Clipboard unavailable");
          clipboard = body.text;
        }
      },
      beforeNavigate: async (page, state) => {
        Object.assign(state.appearance, { mode, uiFontSize: font });
        Object.assign(state.account, entry === "mac" ? { initial_mac_setup: true, guest_system: "macos", macos_guest_user: "cage" } : {});
        state.status.job = { id: "install", kind: entry === "workbench" ? "start" : "guest-install", running: true,
          message: "正在准备基础环境", ...(entry === "initialization" && {
            setup_progress: { system: "windows-11", phase: "image", label: "正在下载系统镜像", received: 32, total: 128 },
          }) };
        if (entry === "workbench") await page.route("**/api/jobs/history", route => route.fulfill({ json: [
          { id: "previous", label: "更新 Claude Desktop", kind: "claude-desktop-update", message: "已完成", log: "Package verification complete" },
          ...Array.from({ length: 30 }, (_, index) => ({ id: "record-" + index, label: "启动环境 " + index, log: "record " + index })),
        ] }));
        await page.emulateMedia({ reducedMotion: "reduce" });
      },
    });
    try {
      const open = entry === "initialization" ? page.getByRole("region", { name: "环境安装进度" }).getByRole("button", { name: "操作详情" })
        : entry === "mac" ? page.getByRole("button", { name: "查看操作详情" }) : page.locator('.status-bar [title="操作详情"]');
      await open.click();
      const dialog = page.getByRole("dialog").last();
      const buffer = dialog.getByRole("region", { name: "日志内容" });
      await buffer.waitFor();
      assert.equal(await dialog.locator("header").count(), 1);
      assert.equal(await dialog.getByRole("heading", { level: 2 }).count(), 1);
      assert.equal(await dialog.getByText("操作输出", { exact: true }).count(), 0);
      assert.ok(await buffer.evaluate(n => n.parentElement.matches('[role="dialog"]')
        && n === document.activeElement && getComputedStyle(n).borderWidth === "0px"), "dialog opens directly on an unframed, focused terminal");
      await dialog.getByText("等待输出…").waitFor();
      const copy = dialog.getByRole("button", { name: "复制日志" }), end = dialog.getByRole("button", { name: "跳到最新输出" });
      assert.ok(await copy.isDisabled());
      assert.ok(await end.isDisabled());
      state.status.job.log = output;
      await dialog.locator("pre").waitFor();
      assert.equal(await dialog.locator("pre").textContent(), output);
      assert.ok(await buffer.evaluate(n => n.scrollWidth <= n.clientWidth + 1));
      if (evidence) await page.screenshot({ path: `${evidence}/${entry}-${width}-running.png`, animations: "disabled" });
      await copy.click();
      await dialog.getByRole("status").filter({ hasText: "已复制日志" }).waitFor();
      assert.equal(clipboard, output);
      await dialog.getByRole("button", { name: "关闭面板" }).focus();
      await page.keyboard.press("Tab");
      assert.ok(await buffer.evaluate(n => n === document.activeElement), "log participates in dialog focus loop");
      state.status.job.log = longOutput;
      await page.waitForFunction(() => { const n = document.querySelector(".operation-log-terminal"); return n.textContent.includes("package 99") && n.scrollTop > 0 && n.scrollHeight - n.scrollTop - n.clientHeight <= 2; });
      await copy.click();
      assert.equal(clipboard, longOutput);
      assert.ok(await buffer.evaluate(n => n.scrollWidth <= n.clientWidth + 1), "long digest wraps within viewport");
      await buffer.press("Control+Home");
      await page.waitForFunction(() => document.querySelector(".operation-log-terminal").scrollTop <= 1);
      state.status.job.log += "network handshake complete\n";
      await page.waitForFunction(() => document.querySelector(".operation-log-output").textContent.includes("network handshake complete"));
      assert.equal(await buffer.evaluate(n => n.scrollTop), 0, "reading position was preserved");
      await end.click();
      assert.ok(await buffer.evaluate(n => n.scrollHeight - n.scrollTop - n.clientHeight <= 2));
      rejectCopy = true;
      await copy.click();
      await dialog.getByRole("status").filter({ hasText: "复制失败" }).waitFor();
      state.status.job.log = output;
      state.status.job.running = false;
      state.status.job.message = "镜像校验未通过";
      state.status.job.error = "镜像校验失败，已保留下载文件。";
      await dialog.getByRole("alert").filter({ hasText: state.status.job.error }).first().waitFor();
      await page.waitForFunction(expected => document.querySelector(".operation-log-output").textContent === expected, output);
      const layout = await dialog.evaluate(n => ({ outside: n.getBoundingClientRect().right > innerWidth + 1,
        overflow: [...n.querySelectorAll(".modal-head, .operation-log-terminal, .operation-log-output, .operation-log-prompt")].some(el => el.scrollWidth > el.clientWidth + 1) }));
      assert.deepEqual(layout, { outside: false, overflow: false });
      if (evidence) {
        await dialog.getByText("复制失败，可选中日志复制。").waitFor({ state: "hidden" });
        await buffer.evaluate(n => { n.scrollTop = 0; });
        await page.screenshot({ path: `${evidence}/${entry}-${width}.png`, animations: "disabled" });
      }
      if (entry === "workbench") {
        await dialog.getByRole("combobox", { name: "选择操作记录" }).click();
        const search = page.getByRole("combobox", { name: "搜索选项" });
        const list = page.getByRole("listbox", { name: "选择操作记录选项" });
        await search.waitFor();
        assert.ok(await list.evaluate(node => node.scrollHeight > node.clientHeight));
        await search.fill("启动环境 29");
        assert.equal(await list.getByRole("option").count(), 1);
        await search.press("Escape");
        assert.equal(await search.inputValue(), "");
        for (let index = 0; index < 18; index++) await search.press("ArrowDown");
        assert.ok(await list.evaluate(node => node.scrollTop > 0));
        await search.fill("更新 Claude Desktop");
        await search.press("Enter");
        await buffer.getByText("Package verification complete").waitFor();
        await page.keyboard.press("Escape");
        await open.click();
        await buffer.getByText("镜像校验未通过").waitFor();
      }
      state.status.job = { ...state.status.job, id: "retry", running: true, error: "", message: "正在重试", log: "" };
      await dialog.getByText("等待输出…").waitFor();
      assert.ok(await copy.isDisabled());
      state.status.job.log = longOutput;
      await page.waitForFunction(() => {
        const n = document.querySelector(".operation-log-terminal");
        return n && n.textContent.includes("package 99") && n.scrollHeight - n.scrollTop - n.clientHeight <= 2;
      });
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
      console.log(`PASS ${entry} ${width}px/${font}px ${mode}: single terminal dialog, initial focus, empty/live/failure, raw copy and denial, wrapping, keyboard, scroll following and retention`);
    } finally { await browser.close(); }
  }
} finally { await vite?.close(); }
