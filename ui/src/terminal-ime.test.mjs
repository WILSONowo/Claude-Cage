import test from "node:test";
import assert from "node:assert/strict";
import { installTerminalIME } from "./terminal-ime.mjs";

test("macOS direct IME commits clear xterm's stale keydown gate", () => {
  const textarea = new EventTarget();
  const core = { _keyDownSeen: true, _keyPressHandled: true };
  const dispose = installTerminalIME(textarea, { textarea, _core: core });
  for (const data of "。（）”；") {
    core._keyDownSeen = true;
    const event = new Event("beforeinput");
    Object.assign(event, { inputType: "insertText", data, isComposing: false });
    textarea.dispatchEvent(event);
    assert.equal(core._keyDownSeen, false, data);
    assert.equal(core._keyPressHandled, true);
    assert.equal(event.defaultPrevented, false);
  }
  dispose();
  core._keyDownSeen = true;
  const event = new Event("beforeinput");
  Object.assign(event, { inputType: "insertText", data: "（" });
  textarea.dispatchEvent(event);
  assert.equal(core._keyDownSeen, true);
});

test("composition, paste and unrelated targets retain xterm state", () => {
  const textarea = new EventTarget();
  const core = { _keyDownSeen: true };
  const dispose = installTerminalIME(textarea, { textarea, _core: core });
  for (const fields of [
    { inputType: "insertCompositionText", data: "中文" },
    { inputType: "insertText", data: "中", isComposing: true },
    { inputType: "insertFromPaste", data: "（" },
    { inputType: "insertText", data: null },
  ]) {
    const event = new Event("beforeinput");
    Object.assign(event, fields);
    textarea.dispatchEvent(event);
    assert.equal(core._keyDownSeen, true);
  }
  dispose();
  const host = new EventTarget();
  const disposeHost = installTerminalIME(host, { textarea, _core: core });
  const event = new Event("beforeinput");
  Object.assign(event, { inputType: "insertText", data: "（" });
  host.dispatchEvent(event);
  assert.equal(core._keyDownSeen, true);
  disposeHost();
});
