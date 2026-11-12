import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

// A resumed setup can already have capture/input permission. The first measured
// reply must still stop at package installation, even before React rerenders.
const permissions = { screen:true, input:true, projects:false, macfuse_installer:true, macfuse:false, managed_credential:true };
const calls = [];
const { page, browser, errors } = await createWorkbench({
  async beforeNavigate(page, state) {
    Object.assign(state.account, { initial_mac_setup:true, guest_system:"macos", macos_guest_user:"cage" });
    Object.assign(state.status, { ready:true, vm_running:true });
    await page.route("**/api/macos/first-setup", async route => {
      const input = route.request().postDataJSON();
      calls.push(input.action);
      if (input.action === "permissions") return route.fulfill({ json:permissions });
      if (input.action === "finish") {
        assert.ok(permissions.macfuse && permissions.projects, "completed setup before installing and checking macFUSE");
        state.account.initial_mac_setup = false;
        return route.fulfill({ json:{ closed:true } });
      }
      return route.fulfill({ json:{} });
    });
  },
});
async function waitCall(action) {
  for (let i=0; !calls.includes(action) && i<300; i++) await new Promise(resolve => setTimeout(resolve,20));
  assert.ok(calls.includes(action), `missing ${action}: ${calls.join(",")}`);
}
try {
  await waitCall("macfuse");
  assert.ok(!calls.includes("projects") && !calls.includes("finish"), "skipped package installation on first permissions reply");
  await page.getByRole("heading", { name:"确认安装 macFUSE" }).waitFor();
  // Closing/canceling Installer does not grant permission or auto-submit again.
  await new Promise(resolve => setTimeout(resolve,2500));
  assert.equal(calls.filter(action => action === "macfuse").length,1);
  assert.ok(!calls.includes("finish"));
  permissions.macfuse = true;
  await waitCall("projects");
  assert.ok(!calls.includes("finish"), "skipped file system extension verification");
  permissions.projects = true;
  await waitCall("finish");
  assert.deepEqual(errors, []);
  console.log("resumed macFUSE setup waits for installer completion and extension verification");
} finally { await browser.close(); }
