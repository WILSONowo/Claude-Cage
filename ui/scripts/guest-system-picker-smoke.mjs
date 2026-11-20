import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

for (const platform of ["darwin", "windows", "linux"]) {
  for (const fresh of [true, false]) {
    const { page, browser, errors } = await createWorkbench({
      initialization: { required: true, tracked: true },
      clientContext: { mode: "local", connection_id: "local", client_platform: platform, server_platform: platform },
      async beforeNavigate(page, state) {
        state.status.local_vm_storage = true;
        const endpoints = {
          "environment/guest-systems": fresh ? { fresh, available: true, system: "debian-13", linux_systems: ["debian-13"] } : { fresh },
          "environment/storage": { directory: "/fixture/cage", has_environment: !fresh },
          "host/debian-mirrors": { decided: true },
        };
        for (const [path, json] of Object.entries(endpoints)) {
          await page.route("**/api/" + path, route => route.fulfill({ json }));
        }
      },
    });
    try {
      const region = page.locator(".guest-system-picker");
      if (fresh) await region.getByText("Debian 13", { exact: true }).waitFor();
      assert.equal(await region.getByRole("combobox").count(), 0);
      await page.getByRole("button", { name: "下一步" }).click();
      const [submitted] = await Promise.all([
        page.waitForRequest(req => req.url().endsWith("/api/start") && req.method() === "POST", { timeout: 6000 }),
        page.getByRole("button", { name: "开始安装" }).click({ timeout: 5000 }),
      ]);
      const body = submitted.postDataJSON();
      assert.equal(body.guest_system, fresh ? "debian-13" : undefined);
      assert.deepEqual(errors, []);
    } catch (err) { console.error(await page.locator("body").innerText()); throw err; } finally { await browser.close(); }
    console.log(platform, fresh ? "fresh Debian 13" : "existing system kept");
  }
}
