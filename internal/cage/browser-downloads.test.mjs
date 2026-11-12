import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadManager } from "./browser-downloads.mjs";

function fixture(t, save) {
  const directory = mkdtempSync(join(tmpdir(), "cage-download-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { directory, save };
  const manager = new DownloadManager(options);
  const begin = (name = "report.txt") => {
    const id = randomUUID();
    manager.begin(id, name);
    writeFileSync(join(directory, "Downloads", id), "complete source");
    return id;
  };
  return { directory, options, manager, begin };
}

function completed(manager, id) {
  manager.progress({ guid: id, state: "completed", receivedBytes: 15, totalBytes: 15 });
  return manager.queue;
}

test("failed saves persist and can be retried after controller restart", async t => {
  let attempts = 0;
  const f = fixture(t, async (id, name) => {
    if (++attempts === 1) throw new Error("共享连接暂时不可用");
    unlinkSync(join(f.directory, "Downloads", id));
    return { ok: true, path: `/shared/Downloads/${name}`, name, bytes: 15 };
  });
  const id = f.begin();
  await completed(f.manager, id);
  assert.equal(f.manager.snapshot()[0].state, "failed");
  assert.equal(f.manager.snapshot()[0].retryable, true);
  assert.equal(statSync(join(f.directory, "download-state.json")).mode & 0o777, 0o600);
  const reopened = new DownloadManager(f.options);
  assert.equal(reopened.snapshot()[0].id, id);
  assert.equal(reopened.snapshot()[0].retryable, true);
  assert.deepEqual(reopened.retry(id), { ok: true });
  assert.deepEqual(reopened.retry(id), { ok: true }, "duplicate retry should not enqueue another copy");
  await reopened.queue;
  assert.equal(attempts, 2);
  assert.equal(reopened.snapshot()[0].state, "saved");
  assert.equal(reopened.snapshot()[0].path, "/shared/Downloads/report.txt");
  assert.equal(new DownloadManager(f.options).snapshot()[0].state, "saved");
});

test("interrupted copies are retryable only with a complete source, interrupted downloads are not", async t => {
  let release;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const saving = f.begin();
  completed(f.manager, saving);
  await Promise.resolve();
  const downloading = f.begin("partial.txt");
  const reopened = new DownloadManager(f.options);
  const records = reopened.snapshot();
  assert.equal(records.find(r => r.id === saving).retryable, true);
  assert.equal(records.find(r => r.id === downloading).retryable, false);
  assert.ok(records.every(r => r.state === "failed"));
  unlinkSync(join(f.directory, "Downloads", saving));
  assert.throws(() => reopened.retry(saving), /源文件/);
  release({ ok: false, error: "interrupted" });
  await f.manager.queue;
});

test("finished download history stays bounded without losing current transfers", async t => {
  const f = fixture(t, async (_id, name) => ({ ok: true, path: `/shared/Downloads/${name}`, name }));
  const active = f.begin("still-downloading.txt");
  for (let i = 0; i < 60; i++) await completed(f.manager, f.begin(`${i}.txt`));
  const records = f.manager.snapshot();
  assert.equal(records.filter(r => r.state === "saved").length, 50);
  assert.ok(records.some(r => r.id === active && r.state === "downloading"));
  assert.equal(JSON.parse(readFileSync(join(f.directory, "download-state.json"))).length, 51);
  assert.ok(records.every(r => !("sourceReady" in r) && !("url" in r)));
});

test("recoverable failed saves retain their records and reserve active download capacity", async t => {
  const f = fixture(t, async () => { throw new Error("shared directory unavailable"); });
  const canceled = [];
  f.manager.cancel = id => canceled.push(id);
  const ids = [];
  for (let index = 0; index < 50; index++) {
    const id = f.begin(`report-${index}.txt`);
    ids.push(id);
    await completed(f.manager, id);
  }
  const excess = randomUUID();
  f.manager.begin(excess, "wait-for-recovery.txt");
  assert.deepEqual(canceled, [excess]);
  assert.equal(f.manager.snapshot().filter(record => record.retryable).length, 50);
  assert.equal(f.manager.snapshot().find(record => record.id === ids[0]).name, "report-0.txt");

  const restored = new DownloadManager({...f.options, save: async (_id, name) => ({ok:true, path:`/shared/${name}`})});
  assert.equal(restored.snapshot().filter(record => record.retryable).length, 50);
  assert.deepEqual(restored.retry(ids[0]), {ok:true});
  await restored.queue;
  const next = randomUUID();
  restored.begin(next, "new-download.txt");
  assert.equal(restored.snapshot().find(record => record.id === next).state, "downloading");
});

test("successful download history cannot evict a complete file awaiting recovery", async t => {
  let first = true;
  const f = fixture(t, async (_id, name) => {
    if (first) { first = false; throw new Error("temporary save failure"); }
    return {ok:true, path:`/shared/${name}`};
  });
  const pending = f.begin("recover-me.txt");
  await completed(f.manager, pending);
  for (let index = 0; index < 55; index++) await completed(f.manager, f.begin(`saved-${index}.txt`));
  const retained = f.manager.snapshot().find(record => record.id === pending);
  assert.ok(retained?.retryable, "a failed save with a complete source must remain retryable after history pruning");
  assert.equal(retained.name, "recover-me.txt");
  assert.equal(f.manager.snapshot().filter(record => record.state === "saved").length, 50);
});
