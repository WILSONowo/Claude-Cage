import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const first = "/projects/first", second = "/projects/second", third = "/projects/third";
for (const remote of [false, true]) {
  const created = [], messages = [];
  let hold = Promise.withResolvers();
  let waiting = false, allowSend = false, session;
  const { browser, page, state, errors } = await createWorkbench({
    ...(remote ? { clientContext: { mode: "remote", connection_id: "qa", client_platform: "win32", server_platform: "linux", connection: { state: "connected" } } } : {}),
    beforeNavigate: async (page, state) => {
      Object.assign(state.status, { ready: true, vm_running: true, projects: [first, second] });
      state.settings.workspace = first;
      state.chosenFolder = third;
      await page.route("**/api/projects/directories?*", route => route.fulfill({ json: { path: third, selectable: true, directories: [] } }));
      await page.route("**/api/mobile/cli/sessions**", async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() === "POST") {
          const body = request.postDataJSON();
          if (path.endsWith("/sessions")) {
            created.push(body);
            session = { ...body, title: "项目对话", generation: body.id, revision: 1, can_send: true, turns: [] };
            if (waiting) await hold.promise;
          } else {
            messages.push({ path, ...body });
            if (!allowSend) return route.fulfill({ status: 409, body: "测试发送失败" });
          }
        }
        return route.fulfill({ json: session || {} });
      });
    },
  });
  try {
    const home = page.locator(".home-composer");
    const picker = home.getByRole("button", { name: /^选择项目文件夹/ });
    const text = home.getByRole("textbox"), send = home.getByRole("button", { name: "发送", exact: true });
    const dialog = page.getByRole("dialog", { name: "选择工作项目" });
    const apply = dialog.getByRole("button", { name: "使用此项目" });
    const choose = async path => {
      await picker.click();
      await dialog.locator('input[type="radio"]').nth(state.status.projects.indexOf(path)).check();
      await apply.click();
    };
    await text.fill("项目切换后的消息");
    await picker.click();
    await dialog.getByRole("button", { name: "取消" }).click();
    assert.equal(await picker.getAttribute("title"), first);
    assert.equal(await text.inputValue(), "项目切换后的消息");

    if (!remote) {
      waiting = true;
      await send.click();
      assert.equal(await picker.isDisabled(), true);
      waiting = false;
      hold.resolve();
      await home.getByRole("alert").waitFor();
      await send.click();
      await page.waitForFunction(() => !document.querySelector(".composer-send").disabled);
      assert.equal(created.length, 2);
      assert.equal(created[0].id, created[1].id);
      assert.equal(messages[0].request_id, messages[1].request_id);
      await choose(second);
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await picker.getAttribute("title"), second);
      assert.equal(await text.inputValue(), "项目切换后的消息");
      assert.equal(await home.getByRole("alert").count(), 0);
      await send.click();
      await home.getByRole("alert").waitFor();
      assert.equal(created.at(-1).workspace, second);
      assert.notEqual(created.at(-1).id, created[0].id);
      assert.notEqual(messages.at(-1).request_id, messages[0].request_id);
      await choose(first);
      await dialog.waitFor({ state: "hidden" });
      await text.fill("修改后的消息");
      await send.click();
      await home.getByRole("alert").waitFor();
      assert.equal(created.at(-1).id, created[0].id);
      assert.notEqual(messages.at(-1).request_id, messages[0].request_id);
    }
    await picker.click();
    await dialog.getByRole("button", { name: remote ? "添加云端项目…" : "添加本机项目…" }).click();
    if (remote) await dialog.getByRole("button", { name: "选择此云端文件夹" }).click();
    await page.waitForFunction(path => document.querySelector("#open-project input:not([type=radio])")?.value === path, third);
    state.failJob = true;
    await apply.click();
    await dialog.getByText(/项目文件夹连接失败/).waitFor();
    assert.equal(await picker.getAttribute("title"), first);
    state.failJob = false;
    await apply.click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await picker.getAttribute("title"), third);
    assert.equal(state.settings.workspace, first);
    assert.ok(state.requests.filter(r => r.path === "/projects/open").every(r => r.body.activate === false));
    await picker.click();
    assert.equal(await dialog.locator('input[type="radio"]:checked').inputValue(), third);
    await page.keyboard.press("Escape");
    if (!remote) {
      await page.getByRole("button", { name: "打开项目", exact: true }).click();
      const manage = page.getByRole("dialog", { name: "打开项目" });
      await manage.getByRole("radio").last().check();
      await manage.getByRole("button", { name: "从 Cage 移除此项目" }).click();
      await manage.getByRole("region", { name: "确认移除项目" }).getByRole("button", { name: "确认移除项目", exact: true }).click();
      await manage.getByRole("region", { name: "确认移除项目" }).waitFor({ state: "hidden" });
      await manage.getByRole("button", { name: "取消" }).click();
      assert.equal(await picker.getAttribute("title"), first);
      await picker.click();
      await dialog.getByRole("button", { name: "添加本机项目…" }).click();
      await page.waitForFunction(path => document.querySelector("#open-project input:not([type=radio])")?.value === path, third);
      await apply.click();
      await dialog.waitFor({ state: "hidden" });
    }
    if (!remote) {
      await page.locator(".project-disclosure").and(page.getByTitle(second, { exact: true })).click();
      assert.equal(await picker.getAttribute("title"), second);
      assert.equal(await text.inputValue(), "修改后的消息");
      await choose(third);
      await dialog.waitFor({ state: "hidden" });
    }
    if (!remote) {
      // A sidebar selection is possible even while the composer picker is disabled.
      waiting = true;
      hold = Promise.withResolvers();
      const before = messages.length;
      const createdRequest = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/mobile/cli/sessions");
      await send.click();
      await createdRequest;
      await page.locator(".project-disclosure").and(page.getByTitle(first, { exact: true })).click();
      assert.equal(await picker.getAttribute("title"), first);
      waiting = false;
      hold.resolve();
      await choose(third);
      await dialog.waitFor({ state: "hidden" });
      assert.equal(messages.length, before, "an old project response sent text after the target changed");
    }
    const draft = await text.inputValue();
    allowSend = true;
    await send.click();
    await page.locator(".desktop-conversation").waitFor();
    assert.equal(created.at(-1).workspace, third);
    assert.ok(messages.at(-1).path.endsWith("/" + created.at(-1).id + "/messages"));
    assert.equal(messages.at(-1).text, draft);
    assert.deepEqual(errors, []);
    console.log("PASS", remote ? "remote" : "local", "composer project selection, draft, retry and destination");
  } finally { hold.resolve(); await browser.close(); }
}
