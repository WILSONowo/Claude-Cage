import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prune } from "./prune-local-builds.mjs";

test("retain two successful builds per platform and preserve unrelated content", async t => {
  const root = await mkdtemp(join(tmpdir(), "cage-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function build(id, platform, complete = true) {
    const dir = join(root, "desktop-00" + id, platform);
    await mkdir(dir, { recursive: true });
    const ver = "0.1." + id;
    const suffix = platform === "windows" ? "windows-amd64-setup-unsigned.exe" : "linux-amd64.deb";
    const name = "Cage-" + ver + "-" + suffix;
    await writeFile(join(dir, name), "payload");
    if (complete) {
      await writeFile(join(dir, "SHA256SUMS"), "0".repeat(64) + "  " + name + "\n");
      await utimes(join(dir, "SHA256SUMS"), id, id);
    }
    return dir;
  }
  const first = await build(1, "windows");
  const second = await build(2, "windows");
  const current = await build(3, "windows");
  const incomplete = await build(4, "windows", false);
  const linux = await build(1, "linux");
  await writeFile(join(first, "review.txt"), "keep");
  assert.deepEqual(await prune(current, true), [first]);
  assert.ok(await stat(join(first, "SHA256SUMS")));
  assert.deepEqual(await prune(current), [first]);
  assert.equal(await readFile(join(first, "review.txt"), "utf8"), "keep");
  await assert.rejects(stat(join(first, "SHA256SUMS")), { code: "ENOENT" });
  for (const dir of [second, current, linux]) assert.ok(await stat(join(dir, "SHA256SUMS")));
  assert.ok(await stat(join(incomplete, "Cage-0.1.4-windows-amd64-setup-unsigned.exe")));
  assert.deepEqual(await prune(current), []);
});
