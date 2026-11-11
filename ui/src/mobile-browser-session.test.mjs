import test from "node:test";
import assert from "node:assert/strict";

// The transport reads the optional desktop attachment when it is imported.
globalThis.location = new URL("http://localhost/");
const { connectDisplay } = await import("./mobile-cli/browser-session.mjs");
delete globalThis.location;

const settle = () => new Promise(resolve => setImmediate(resolve));
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers:{"Content-Type":"application/json"}});
const frame = {id:"phone-session", image:"image", document:"document", width:390, height:640};
function display(t, respond) {
  const saved = Object.fromEntries(["fetch", "window", "Image", "ResizeObserver"].map(key => [key, globalThis[key]]));
  globalThis.window = {devicePixelRatio:1};
  globalThis.Image = class { async decode() {} };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.fetch = async (path, options) => path.endsWith("/close") ? json({id:frame.id}) : respond(path, options);
  t.mock.timers.enable({apis:["setTimeout", "Date"], now:1000});
  const states = [];
  const session = connectDisplay({clientWidth:390, clientHeight:640}, state => states.push(state), frame.id, false, "browser");
  t.after(() => {
    session.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  return {session, states};
}

test("a changing browser document is reread without requiring manual recovery", async t => {
  let reads = 0;
  const {states} = display(t, () => ++reads <= 2 ? json({}, 425) : json(frame));
  await settle();
  t.mock.timers.tick(1000); await settle();
  t.mock.timers.tick(1000); await settle();
  assert.equal(reads, 3);
  assert.equal(states.at(-1).frame?.document, frame.document);
  assert.equal(states.some(state => state.error), false);
});

test("persistent frame changes stop waiting after the existing recovery deadline", async t => {
  let reads = 0, available = false;
  const {session, states} = display(t, () => { reads++; return available ? json(frame) : json({}, 425); });
  await settle();
  t.mock.timers.tick(90000); await settle();
  assert.equal(reads, 2);
  assert.ok(states.at(-1).error);
  available = true;
  session.refresh(); await settle();
  assert.equal(states.at(-1).frame?.document, frame.document);
});

test("a conflicting input is never retried", async t => {
  let writes = 0;
  const {session, states} = display(t, path => {
    if (path.endsWith("/action")) { writes++; return json({}, 409); }
    return json(frame);
  });
  await settle();
  assert.equal(await session.send({type:"tap", x:10, y:10}, states.at(-1).frame), false);
  t.mock.timers.tick(1000); await settle();
  assert.equal(writes, 1);
  assert.ok(states.at(-1).error);
});

test("closing a display cancels a pending frame reread", async t => {
  let reads = 0;
  const {session} = display(t, () => { reads++; return json({}, 425); });
  await settle();
  session.close();
  t.mock.timers.tick(1000); await settle();
  assert.equal(reads, 1);
});

test("unclassified conflicts such as a paused network gate are not reread", async t => {
  let reads = 0;
  const {states} = display(t, () => { reads++; return json({}, 409); });
  await settle();
  t.mock.timers.tick(5000); await settle();
  assert.equal(reads, 1);
  assert.ok(states.at(-1).error);
});
