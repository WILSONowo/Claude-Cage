import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";
for (const [platform, system, version, edition] of [
  ["darwin", "macos", "26.5", ""],
  ["windows", "windows-11", "25H2", "Professional"],
  ["linux", "ubuntu-22.04", "22.04", ""],
  ["linux", "ubuntu-24.04", "24.04", ""],
]) {
  let planRequests = 0;
  const fixture = await createWorkbench({
    initialization: { required: true, tracked: true },
    clientContext: {
      mode: "local",
      connection_id: "local",
      client_platform: platform,
      server_platform: platform,
    },
    beforeNavigate: async (page, state) => {
      state.status.local_vm_storage = true;
      await page.route("**/api/environment/storage", route => route.fulfill({ json: { directory: "/fixture/cage", has_environment: true } }));
      await page.route("**/api/environment/guest-systems", (route) =>
        route.fulfill({ json: { fresh: false, available: true, system, pending: { system, id: "original", source: { host: { system } }, editor_terms: true } } }),
      );
      await page.route("**/api/environment/guest-systems/clone", (route) => {
        planRequests++;
        return route.fulfill({
          json: {
            key: "source-key",
            enough_space: true,
            minimum_free_gib: 64,
            free_gib: 100,
            download_bytes: 5000000000,
            plan: {
              host: {
                system,
                version,
                build: "host-build",
                edition,
                language: "zh-CN",
              },
              version,
              build: "image-build",
              format: system === "macos" ? "ipsw" : "esd",
            },
          },
        });
      });
    },
  });
  try {
    const { page } = fixture;
    const region = page.locator(".guest-system-picker");
    await region.waitFor();
    assert.equal(await region.getByRole("combobox").count(), 0);
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByText("首次检测的本机构建号 host-build · 镜像构建号 image-build").waitFor();
    const submit = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/start") && request.method() === "POST",
    );
    await page
      .getByRole("button", {
        name: "开始安装",
        exact: true,
      })
      .click();
    const body = (await submit).postDataJSON();
    assert.equal(body.clone_key, undefined); // Backend resumes the saved plan.
    assert.equal(body.guest_system, system);
    assert.equal(planRequests, 1);
    assert.deepEqual(fixture.errors, []);
    console.log(platform, "resumed saved host-matched image");
  } finally {
    await fixture.browser.close();
  }
}
