import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const { browser, page, state, errors } = await createWorkbench();
let releaseGit, releaseStart;
const gitGate = new Promise(resolve => { releaseGit = resolve; });
const startGate = new Promise(resolve => { releaseStart = resolve; });
let starts = 0;
const history = [];
const assertLoading = async message => {
  await page.getByRole("heading", { name: "正在启动环境", exact: true }).waitFor();
  await page.locator(".welcome-subtitle").getByText(message, { exact: true }).waitFor();
  assert.ok(await page.getByRole("button", { name: "查看操作详情", exact: true }).isEnabled());
  assert.equal(await page.getByRole("button", { name: "启动 Cage 环境", exact: true }).count(), 0);
  assert.equal(await page.getByRole("dialog").count(), 0);
};
try {
  await page.route("**/api/jobs/history", route => route.fulfill({ json: history }));
  await page.route("**/api/host/git", async route => {
    await gitGate;
    await route.fulfill({ json: state.hostGit });
  });
  await page.route("**/api/start", async route => {
    starts++;
    await startGate;
    await route.fulfill({ json: { id: "delayed-start" } });
  });
  const gitRequested = page.waitForRequest("**/api/host/git");
  await page.getByRole("button", { name: "启动 Cage 环境", exact: true }).click();
  await gitRequested;
  await assertLoading("正在检查本机 Git 安全保护…");
  const startRequested = page.waitForRequest("**/api/start");
  releaseGit();
  await startRequested;
  await assertLoading("正在启动 Cage 环境…");
  const startResponse = page.waitForResponse("**/api/start");
  releaseStart();
  await startResponse;
  // An older idle status must not re-enable the button after acceptance.
  await page.waitForResponse("**/api/status");
  await assertLoading("正在启动 Cage 环境…");
  await page.getByRole("button", { name: "Claude Desktop", exact: true }).click();
  const staleHistory = page.waitForResponse("**/api/jobs/history");
  await assertLoading("正在启动 Cage 环境…");
  await staleHistory;
  await assertLoading("正在启动 Cage 环境…");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  assert.equal(starts, 1);
  state.status.job = { id: "delayed-start", kind: "start", running: true, message: "正在准备测试环境…" };
  await page.locator(".welcome-subtitle").getByText("正在准备测试环境…", { exact: true }).waitFor();
  await assertLoading("正在准备测试环境…");
  state.status.job = { ...state.status.job, running: false, error: "测试启动失败" };
  await page.getByRole("button", { name: "启动 Cage 环境", exact: true }).waitFor();

  await page.route("**/api/start", route => route.fulfill({ status: 503, contentType: "text/plain; charset=utf-8", body: "测试请求失败" }));
  await page.getByRole("button", { name: "启动 Cage 环境", exact: true }).click();
  await page.getByText("测试请求失败", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "启动 Cage 环境", exact: true }).isEnabled(), true);

  await page.route("**/api/host/git", route => route.fulfill({ status: 503, contentType: "text/plain; charset=utf-8", body: "测试检查失败" }));
  await page.getByRole("button", { name: "启动 Cage 环境", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "测试检查失败" }).waitFor();
  await page.getByRole("button", { name: "暂不启动", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "启动 Cage 环境", exact: true }).isEnabled(), true);
  await page.route("**/api/host/git", route => route.fulfill({ json: state.hostGit }));
  await page.route("**/api/start", route => {
    state.status.job = { id: "newer-job", kind: "project", running: false };
    history.push({ id: "short-start", kind: "start", running: false, error: "已归档的启动失败" });
    return route.fulfill({ json: { id: "short-start" } });
  });
  await page.getByRole("button", { name: "Claude Desktop", exact: true }).click();
  const open = page.getByRole("button", { name: "打开 Claude Desktop", exact: true });
  await open.click();
  await page.getByRole("alert").filter({ hasText: "已归档的启动失败" }).waitFor();
  assert.ok(await open.isEnabled());
  assert.deepEqual(errors, []);
  console.log("PASS: immediate feedback; no Git dialog flash; continuous loading across delayed requests and stale polling; job handoff; failures and cancellation allow retry.");
} finally {
  releaseGit();
  releaseStart();
  await browser.close();
}
