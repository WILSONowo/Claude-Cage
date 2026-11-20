import assert from "node:assert/strict";
import test from "node:test";
import { browserGraphicsFlags } from "./browser-graphics.mjs";

test("an existing profile keeps Chromium defaults", () => {
  assert.deepEqual(browserGraphicsFlags(), []);
  assert.deepEqual(browserGraphicsFlags({backend: "--unknown-flag"}), []);
});

test("each renderer receives its own flags", () => {
  for (const backend of ["vulkan", "gl", "swiftshader"]) {
    const flags = browserGraphicsFlags({backend});
    assert.ok(flags.includes("--use-gl=angle"));
    assert.ok(flags.includes("--use-angle=" + backend));
    assert.equal(flags.includes("--enable-zero-copy"), backend !== "swiftshader");
  }
});

test("Canvas readback and WebGL can be restricted independently", () => {
  assert.deepEqual(browserGraphicsFlags({block_canvas_read: true}), ["--disable-reading-from-canvas"]);
  assert.deepEqual(browserGraphicsFlags({disable_webgl: true}), ["--disable-3d-apis", "--disable-webgl"]);
});
