import assert from "node:assert/strict";
import test from "node:test";
import { needsEnvironmentRestart, needsProxySetup } from "./onboarding-state.mjs";

test("only an applied Cage node completes setup", () => {
  assert.equal(needsProxySetup({}, {}, {}), true);
  assert.equal(
    needsProxySetup({}, {}, { active: false, selected: "node" }),
    true,
  );
  assert.equal(
    needsProxySetup({}, {}, { active: true, selected: "node" }),
    false,
  );
});

test("setup offers restart for saved exits, changed environment and explicit recovery", () => {
  const base = { guest_system: "macos", vm_running: true };
  for (const state of [
    { safety: { error: "已保存固定出口。请重启 macOS 客机，登录后重新检测。" } },
    { safety: { error: "出口地址或环境设置变化需要重启环境" } },
    { job: { kind: "start", error: "网络设置已保存，请重启 macOS 客机，登录后重新检测" } },
    { job: { kind: "proxy-network", error: "出口地址或环境设置变化需要重启环境" } },
    { job: { error: "restart needed", recovery: "environment-restart" } },
  ]) {
    assert.equal(needsEnvironmentRestart({ ...base, ...state }), true);
    assert.equal(needsEnvironmentRestart({ ...base, ...state, vm_running: false }), true);
  }
});

test("ordinary failures and stale restart errors do not ask for a restart", () => {
  const base = { guest_system: "macos" };
  for (const status of [undefined, base,
    { ...base, network_error: "无法读取物理网卡，请检查主机网络后重试" },
    { ...base, safety: { error: "关键检查尚未完成" } },
    { ...base, job: { error: "guest logged out", recovery: "guest-login" } },
    { guest_system: "linux", safety: { error: "出口地址或环境设置变化需要重启环境" } },
    { ...base, safety: { error: "出口地址或环境设置变化需要重启环境", gate: { mode: "open" } } },
  ]) assert.equal(needsEnvironmentRestart(status), false);
});
test("running VM, old endpoint and restore file cannot bypass node setup", () => {
  for (const status of [{ vm_running: true }, { can_restore: true }]) {
    assert.equal(
      needsProxySetup({ proxy_url: "socks5://127.0.0.1:17896" }, status, {}),
      true,
    );
  }
});
