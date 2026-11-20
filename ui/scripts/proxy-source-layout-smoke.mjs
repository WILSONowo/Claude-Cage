import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chooseInline, createWorkbench, openWorkbenchSettings } from "./workbench-fixture.mjs";

const output = process.env.CAGE_PROXY_LAYOUT_OUTPUT;
if (output) await mkdir(output, { recursive: true });

function measure(form) {
  const fields = [...form.querySelectorAll("label")].flatMap(label => {
    const control = label.querySelector('input:not([type=file]),textarea,[role=combobox]') || label.control;
    if (!control || control.type === "file") return [];
    const node = [...label.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    const range = document.createRange();
    range.selectNodeContents(node);
    const text = range.getBoundingClientRect();
    const box = (control.closest(".password-input") || control).getBoundingClientRect();
    const column = (label.closest(".secret-field") || label).getBoundingClientRect();
    return [{
      name: node.textContent.trim(), gap: box.top - text.bottom, left: box.left - text.left,
      edges: Math.max(Math.abs(box.left - column.left), Math.abs(box.right - column.right)),
    }];
  });
  const formBounds = form.getBoundingClientRect();
  const overflow = Math.max(0, -formBounds.left, formBounds.right - innerWidth, form.scrollWidth - form.clientWidth);
  const rows = [...form.querySelectorAll(".proxy-import-pair")].filter(row => row.children.length > 1)
    .map(row => Array.from(row.children, child => {
      const rect = child.getBoundingClientRect();
      return { top: rect.top, left: rect.left, right: rect.right };
    }));
  return { fields, rows, overflow };
}

async function verify(page, entry, mode, width) {
  const form = page.locator(".proxy-import");
  const { fields, rows, overflow } = await form.evaluate(measure);
  const context = `${entry}/${mode} ${width}px`;
  assert.ok(fields.length >= 2, context);
  if (mode !== "yaml") assert.ok(rows.length > 0, `${context}: expected paired fields`);
  assert.ok(overflow <= 1, `${context}: form overflows by ${overflow}px`);
  for (const field of fields) {
    assert.ok(field.gap >= 1 && field.gap <= 22, `${context}: ${field.name} label gap ${field.gap}`);
    assert.ok(Math.abs(field.left) <= 2 && field.edges <= 2, `${context}: ${field.name} alignment ${JSON.stringify(field)}`);
  }
  for (const [first, second] of rows) {
    if (width >= 1000) {
      assert.ok(Math.abs(first.top - second.top) <= 2 && second.left > first.right, `${context}: two-column row`);
    } else {
      assert.ok(second.top > first.top && Math.abs(first.left - second.left) <= 2, `${context}: single-column row`);
    }
  }
  if (output) {
    const viewport = page.viewportSize();
    const { height } = await form.boundingBox();
    await page.setViewportSize({ width, height: Math.ceil(height + 400) });
    await form.screenshot({ path: path.join(output, `dark-${entry}-${mode}-${width}.png`), animations: "disabled" });
    await page.setViewportSize(viewport);
  }
  console.log(`${context}: ${fields.length} fields aligned`);
}

for (const entry of ["initialization", "settings"]) {
  const initializing = entry === "initialization";
  const { page, browser, errors } = await createWorkbench({
    waitForReady: false, initialization: { required: initializing, tracked: true },
    clientContext: { mode: "local", connection_id: "local", client_platform: "windows", server_platform: "windows" },
    beforeNavigate: async (page, state) => {
      state.status.local_vm_storage = true;
      state.appearance.mode = "dark";
      await page.emulateMedia({ colorScheme: "dark" });
      const fixtures = {
        "environment/storage": { directory: "D:\\Cage", has_environment: false },
        "environment/guest-systems": { fresh: true, available: true, system: "debian" },
        proxy: { active: false, sources: [], port: 17896, core_available: true },
      };
      for (const [endpoint, json] of Object.entries(fixtures)) {
        await page.route("**/api/" + endpoint, route => route.fulfill({ json }));
      }
    },
  });
  try {
    if (initializing) {
      await page.getByRole("button", { name: "下一步" }).click();
    } else {
      await openWorkbenchSettings(page);
      await page.getByRole("button", { name: "网络与代理", exact: true }).click();
      await page.getByRole("tab", { name: "订阅", exact: true }).click();
    }
    await page.getByRole("button", { name: "添加来源", exact: true }).click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const form = page.locator(".proxy-import");
      for (const [mode, name] of [["url", "订阅链接"], ["yaml", "本地 YAML"], ["manual", "手动节点"]]) {
        await form.getByRole("button", { name, exact: true }).click();
        if (mode === "manual") await chooseInline(form.getByRole("combobox", { name: "协议" }), "socks5");
        await verify(page, entry, mode, width);
      }
      await chooseInline(form.getByRole("combobox", { name: "协议" }), "ssh");
      const auth = form.getByRole("combobox", { name: "认证方式" });
      await chooseInline(auth, "password");
      await verify(page, entry, "ssh-password", width);
      await chooseInline(auth, "private-key");
      await verify(page, entry, "ssh-key", width);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
