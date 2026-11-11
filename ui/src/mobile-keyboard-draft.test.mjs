import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import {transformWithOxc} from "vite";

// Exercise the actual JSX component's form handler without a native browser.
// The hook adapter applies functional state setters to the latest draft.
const source = await readFile(new URL("./mobile-cli/remote-browser.jsx", import.meta.url), "utf8");
const begin = source.indexOf("function RemoteKeyboard(");
const end = source.indexOf("function LoginKeyboard(", begin);
assert.ok(begin >= 0 && end > begin);
const {code} = await transformWithOxc(source.slice(begin, end), "keyboard.jsx", {jsx:{runtime:"classic"}});
function component(state, send, busy = false) {
  const Keyboard = runInNewContext(code + "; RemoteKeyboard;", {
    React:{createElement:(type, props, ...children) => ({type, props:props || {}, children})},
    useState:() => [state.text, next => {state.text = typeof next === "function" ? next(state.text) : next;}],
    TextEncoder, Tool:()=>{}, Check:()=>{}, Delete:()=>{}, CornerDownLeft:()=>{}, X:()=>{},
  });
  return Keyboard({frame:{focus:"input", password:false}, busy, send, onClose:()=>{}});
}
test("a delayed insertion preserves text edited while its receipt is pending", async () => {
  const state = {text:"submitted"}, sent = [];
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const form = component(state, async payload => {sent.push(payload.text); return gate;});
  const submitting = form.props.onSubmit({preventDefault(){}});
  state.text = "new draft";
  release(true);
  await submitting;
  assert.equal(state.text, "new draft");
  assert.deepEqual(sent, ["submitted"]);
});
test("an unchanged accepted draft is cleared", async () => {
  const state = {text:"submitted"};
  await component(state, async () => true).props.onSubmit({preventDefault(){}});
  assert.equal(state.text, "");
});
test("a rejected insertion retains the draft", async () => {
  const state = {text:"submitted"};
  await component(state, async () => false).props.onSubmit({preventDefault(){}});
  assert.equal(state.text, "submitted");
});
test("a busy display does not submit text", async () => {
  const state = {text:"submitted"};
  await component(state, async () => {throw Error("unexpected send");}, true).props.onSubmit({preventDefault(){}});
  assert.equal(state.text, "submitted");
});
