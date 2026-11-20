import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

for (const [system, name, platform] of [["macos", "macOS", "darwin"], ["windows-11", "Windows 11", "windows"]]) {
  const pending = { id: "existing-installation", system, media: "/fixture/installer", sha256: "a".repeat(64), editor_terms: true };
  const { page, browser } = await createWorkbench({
    initialization: { required: true, tracked: true },
    clientContext: { mode: "local", connection_id: "local", client_platform: platform, server_platform: platform },
    async beforeNavigate(page, state) {
      state.status.local_vm_storage = true;
      const views = {
        "environment/guest-systems": { fresh: false, available: true, system, pending },
        "environment/storage": { directory: "/fixture/cage", has_environment: true },
      };
      for (const [path, json] of Object.entries(views)) await page.route("**/api/" + path, route => route.fulfill({ json }));
    },
  });
  try {
    const region = page.locator(".guest-system-picker");
    await region.getByText(name, { exact: true }).waitFor();
    assert.equal(await region.getByRole("combobox").count(), 0);
    await page.getByRole("button", { name: "下一步" }).click();
    const [request] = await Promise.all([
      page.waitForRequest(req => req.url().endsWith("/api/start") && req.method() === "POST"),
      page.getByRole("button", { name: "开始安装" }).click(),
    ]);
    assert.deepEqual(request.postDataJSON(), { guest_system: system });
    console.log(platform, "resumed recorded manual installation");
  } finally { await browser.close(); }
}

{
  const calls=[];
  const {page,browser,errors}=await createWorkbench({
    waitForReady:false, initialization:{required:true,tracked:true,started:true},
    nativeRequest: message=>{ calls.push(message.action); return null; },
    async beforeNavigate(page,state) {
      state.status.local_vm_storage=true;
      await page.route("**/api/environment/guest-systems",r=>r.fulfill({json:{fresh:false,available:true,system:"macos",pending:{system:"macos",id:"activation-fixture"},activate:true}}));
      await page.route("**/api/environment/guest-systems/activate",r=>{ calls.push("activate"); return r.fulfill({json:{stopping:true}}); });
    }
  });
  try {
    for(let i=0; !calls.includes("reconnect") && i<150;i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(calls.filter(action=>action==="activate").length,1);
    assert.equal(calls.filter(action=>action==="reconnect").length,1);
    assert.deepEqual(errors,[]);
    console.log("installed guest automatically activated and reconnected");
  } finally { await browser.close(); }
}
