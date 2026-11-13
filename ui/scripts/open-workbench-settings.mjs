export async function openWorkbenchSettings(page) {
  const sidebar = page.locator("#workspace-sidebar");
  const account = sidebar.getByRole("button", { name: /^账户菜单，/ });
  await sidebar.waitFor({ state: "attached" });
  if (await sidebar.getAttribute("inert") !== null) {
    await page.getByRole("button", { name: "展开侧栏", exact: true }).first().click();
  }
  await account.click();
  await sidebar.getByRole("menuitem", { name: "设置", exact: true }).click();
}
