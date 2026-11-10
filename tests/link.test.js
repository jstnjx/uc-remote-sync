import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentServer } from "../src/agent/server.js";
import { LinkHub } from "../src/link/hub.js";
import { LinkClient, linkUrl } from "../src/link/client.js";
import { DriftGuard } from "../src/service/drift-guard.js";
import { HardwareAdapter, hardwareFromResponses } from "../src/apply/hardware.js";
import { RemoteSyncService } from "../src/service/index.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function waitUntil(predicate, timeout = 3000, label = "condition") {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const TOKEN = "c".repeat(40);

async function primary({ hubOptions = {} } = {}) {
  const port = await freePort();
  const states = new Map([["hass.main.light.a", { state: "OFF" }]]);
  const commands = [];
  const hub = new LinkHub({
    fullState: async () => ({ states: [...states].map(([id, attributes]) => ({ source_entity_id: id, attributes })), activities: [] }),
    onCommand: async (peer, message) => { commands.push({ peer: peer.peer_id, ...message }); return { success: true, status: 200, cmd_id: message.cmd_id }; },
    ...hubOptions
  });
  const config = { role: "master", node_id: "m", node_name: "M", agent_token: "m".repeat(40), agent_port: port, peers: [{ peer_id: "sat", name: "Satellite", enabled: true, command_token: TOKEN }] };
  const agent = new AgentServer(config, {
    applyCallback: async () => ({}), statusCallback: () => ({}), syncCallback: async () => ({}), pairingCallback: async () => ({}),
    linkCallback: ({ socket, peer }) => hub.attach(socket, peer)
  });
  await agent.start();
  return {
    port, hub, states, commands, agent,
    setState(id, attributes) { states.set(id, attributes); hub.publish("state", { states: [{ source_entity_id: id, attributes }] }); },
    async close() { hub.close(); await agent.stop(); }
  };
}

function satellite(port, { token = TOKEN, ...options } = {}) {
  const applied = [];
  const fulls = [];
  const client = new LinkClient({
    getTarget: () => ({ url: `http://127.0.0.1:${port}`, token }),
    hello: () => ({ node_id: "sat", version: "test" }),
    onFull: async (message) => { fulls.push(message); for (const state of message.states) applied.push(state); },
    onEvent: async (message) => { if (message.type === "state") applied.push(...message.states); },
    reconnectScheduleMs: [20, 20, 50],
    ...options
  });
  return { client, applied, fulls };
}

// -----------------------------------------------------------------------------
// Persistent link
// -----------------------------------------------------------------------------

test("link URL is derived from the Primary agent URL", () => {
  assert.equal(linkUrl("http://10.1.1.170:11081"), "ws://10.1.1.170:11081/v1/link");
  assert.equal(linkUrl("https://primary.lan/"), "wss://primary.lan/v1/link");
});

test("a Satellite links up, receives a full state image and then live events in order", async () => {
  const p = await primary();
  const s = satellite(p.port);
  try {
    s.client.start();
    await waitUntil(() => s.client.connected, 3000, "link");
    assert.equal(s.fulls.length, 1);
    assert.deepEqual(s.applied, [{ source_entity_id: "hass.main.light.a", attributes: { state: "OFF" } }]);
    assert.equal(p.hub.isConnected("sat"), true);

    p.setState("hass.main.light.a", { state: "ON" });
    p.setState("hass.main.light.a", { state: "ON", brightness: 50 });
    await waitUntil(() => s.applied.length === 3, 2000, "live events");
    assert.deepEqual(s.applied.slice(1).map((item) => item.attributes), [{ state: "ON" }, { state: "ON", brightness: 50 }]);
    assert.equal(s.client.lastSeq, p.hub.seq);
  } finally { s.client.stop(); await p.close(); }
});

test("events missed while the Satellite was away are replayed on reconnect, not lost", async () => {
  const p = await primary();
  const s = satellite(p.port);
  try {
    s.client.start();
    await waitUntil(() => s.client.connected);
    // Simulate standby: the Satellite's connection drops.
    for (const session of p.hub.sessions.values()) session.socket.terminate();
    await waitUntil(() => !s.client.connected, 2000, "disconnect");
    p.setState("hass.main.light.a", { state: "ON" });
    p.setState("hass.main.light.b", { state: "OFF" });
    await waitUntil(() => s.client.connected && s.applied.length >= 3, 3000, "resume");
    assert.equal(s.fulls.length, 1, "a resume must not need a second full image");
    assert.deepEqual(s.applied.slice(1).map((item) => item.source_entity_id), ["hass.main.light.a", "hass.main.light.b"]);
    assert.equal(s.client.lastSeq, p.hub.seq);
  } finally { s.client.stop(); await p.close(); }
});

test("when missed events are no longer buffered the Satellite receives a complete image instead", async () => {
  const p = await primary({ hubOptions: { bufferSize: 2 } });
  const s = satellite(p.port);
  try {
    s.client.start();
    await waitUntil(() => s.client.connected);
    s.client.stop();
    for (let i = 0; i < 5; i += 1) p.setState("hass.main.light.a", { state: i % 2 ? "ON" : "OFF", step: i });
    s.client.start();
    await waitUntil(() => s.fulls.length === 2 && s.client.connected, 3000, "second image");
    assert.deepEqual(s.applied.at(-1).attributes, { state: "OFF", step: 4 });
    assert.equal(s.client.lastSeq, p.hub.seq);
  } finally { s.client.stop(); await p.close(); }
});

test("a restarted Primary (new epoch) sends a complete image", async () => {
  const p = await primary();
  const s = satellite(p.port);
  try {
    s.client.start();
    await waitUntil(() => s.client.connected);
    const oldEpoch = s.client.epoch;
    s.client.stop();
    p.hub.epoch = "restarted";
    p.hub.seq = 0; p.hub.buffer = [];
    s.client.start();
    await waitUntil(() => s.fulls.length === 2 && s.client.connected, 3000, "image after restart");
    assert.notEqual(s.client.epoch, oldEpoch);
  } finally { s.client.stop(); await p.close(); }
});

test("events published while a full image is read follow it and are never overwritten by it", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const p = await primary({ hubOptions: { fullState: async () => { await gate; return { states: [{ source_entity_id: "hass.main.light.a", attributes: { state: "OFF" } }], activities: [] }; } } });
  const s = satellite(p.port);
  try {
    s.client.start();
    await waitUntil(() => p.hub.sessions.size === 1, 2000, "session");
    await new Promise((resolve) => setTimeout(resolve, 30));
    p.hub.publish("state", { states: [{ source_entity_id: "hass.main.light.a", attributes: { state: "ON" } }] });
    release();
    await waitUntil(() => s.client.connected && s.applied.length === 2, 2000, "image + event");
    assert.deepEqual(s.applied.map((item) => item.attributes.state), ["OFF", "ON"], "the newer event must be applied after the image");
  } finally { s.client.stop(); await p.close(); }
});

test("a sequence gap makes the Satellite ask for a complete image", async () => {
  const p = await primary();
  const s = satellite(p.port);
  try {
    s.client.start();
    await waitUntil(() => s.client.connected);
    const session = [...p.hub.sessions.values()][0];
    session.send({ type: "state", epoch: p.hub.epoch, seq: p.hub.seq + 5, states: [{ source_entity_id: "x", attributes: { state: "ON" } }] });
    await waitUntil(() => s.fulls.length === 2, 2000, "resync image");
    assert.equal(s.applied.some((item) => item.source_entity_id === "x"), false, "an out-of-order event is never applied");
  } finally { s.client.stop(); await p.close(); }
});

test("commands travel over the link and return the Primary's result", async () => {
  const p = await primary();
  const s = satellite(p.port);
  try {
    s.client.start();
    await waitUntil(() => s.client.connected);
    const result = await s.client.request("command", { source_entity_id: "hass.main.light.a", cmd_id: "on", entity_type: "light" });
    assert.deepEqual(result, { success: true, status: 200, cmd_id: "on" });
    assert.equal(p.commands[0].peer, "sat");
  } finally { s.client.stop(); await p.close(); }
});

test("a wrong command token cannot open a link", async () => {
  const p = await primary();
  const s = satellite(p.port, { token: "wrong".repeat(8) });
  try {
    s.client.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(s.client.connected, false);
    assert.equal(p.hub.sessions.size, 0);
    assert.match(String(s.client.lastError), /401/);
  } finally { s.client.stop(); await p.close(); }
});

test("a silent Satellite is dropped by the heartbeat", async () => {
  const p = await primary({ hubOptions: { heartbeatMs: 20, timeoutMs: 60 } });
  const s = satellite(p.port, { heartbeatMs: 10_000, timeoutMs: 60_000 });
  try {
    s.client.start();
    await waitUntil(() => p.hub.isConnected("sat"));
    // Stop answering: the Satellite's process froze (no pongs, no pings).
    const session = [...p.hub.sessions.values()][0];
    session.socket.removeAllListeners("message");
    await waitUntil(() => !p.hub.sessions.has("sat") || p.hub.sessions.get("sat") !== session, 2000, "heartbeat drop");
  } finally { s.client.stop(); await p.close(); }
});

// -----------------------------------------------------------------------------
// Satellite command routing
// -----------------------------------------------------------------------------

function childService(link) {
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  service.config = { role: "child", peers: [], pairing: { master_agent_url: "http://127.0.0.1:9", master_command_token: TOKEN } };
  service.link = link;
  return service;
}

test("Satellite commands use the link when it is up", async () => {
  const sent = [];
  const service = childService({ connected: true, request: async (type, payload) => { sent.push({ type, ...payload }); return { success: true, status: 200 }; }, nudge() {} });
  const result = await service.forwardProxyCommand("hass.main.light.a", "on", { brightness: 3 }, { entityType: "light" });
  assert.equal(result.success, true);
  assert.equal(sent[0].type, "command");
  assert.equal(sent[0].entity_type, "light");
  assert.ok(sent[0].issued_age_ms >= 0 && sent[0].issued_age_ms < 1000);
});

test("a command the link sent but the Primary did not answer is not repeated over HTTP", async () => {
  let httpCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { httpCalls += 1; return new Response("{}", { status: 200 }); };
  try {
    const service = childService({ connected: true, request: async () => { throw Object.assign(new Error("timeout"), { code: "LINK_TIMEOUT" }); }, nudge() {} });
    const result = await service.forwardProxyCommand("hass.main.light.a", "toggle");
    assert.equal(result.success, false);
    assert.equal(httpCalls, 0, "a toggle must never run twice");
  } finally { globalThis.fetch = original; }
});

test("a command falls back to HTTP when the link dropped before sending", async () => {
  let body = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ success: true }), { status: 200 }); };
  let nudged = false;
  try {
    const service = childService({ connected: true, request: async () => { throw Object.assign(new Error("down"), { code: "LINK_DOWN" }); }, nudge() { nudged = true; } });
    const result = await service.forwardProxyCommand("uc.main.activity", "activity.on", undefined, { issuedAt: Date.now() - 500 });
    assert.equal(result.success, true);
    assert.equal(body.cmd_id, "activity.on");
    assert.ok(body.issued_age_ms >= 500);
    assert.equal(nudged, true);
  } finally { globalThis.fetch = original; }
});

// -----------------------------------------------------------------------------
// Newest action wins
// -----------------------------------------------------------------------------

function primaryService() {
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  service.config = { role: "master", peers: [] };
  const executed = [];
  service.client = {
    async executeEntityCommand(id, cmd) { executed.push(`${id}:${cmd}`); return {}; },
    async getJson() { return null; },
    async activityReadiness() { return null; }
  };
  return { service, executed };
}

test("an activity action issued before a newer change on the Primary is dropped and the current state re-announced", async () => {
  const { service, executed } = primaryService();
  const published = [];
  service.linkHub = { publish: (type, payload) => published.push({ type, ...payload }), isConnected: () => false };
  // The Primary turned the activity off a moment ago.
  service.activitySync.lastObservedStates.set("uc.main.tv", "OFF");
  service.activitySync.lastChangeAt.set("uc.main.tv", Date.now() - 1000);
  const stale = await service.executeProxyCommand({ source_entity_id: "uc.main.tv", cmd_id: "activity.on", issued_at: Date.now() - 20_000 });
  assert.equal(stale.superseded, true);
  assert.deepEqual(executed, []);
  assert.equal(published[0].type, "activity");
  assert.equal(published[0].update.state, "OFF");

  const fresh = await service.executeProxyCommand({ source_entity_id: "uc.main.tv", cmd_id: "activity.on", issued_at: Date.now() });
  assert.equal(fresh.success, true);
  assert.equal(fresh.superseded, undefined);
  assert.deepEqual(executed, ["uc.main.tv:activity.on"]);
});

test("commands without an age and non-activity commands are never treated as stale", async () => {
  const { service, executed } = primaryService();
  service.activitySync.lastChangeAt.set("uc.main.tv", Date.now());
  await service.executeProxyCommand({ source_entity_id: "uc.main.tv", cmd_id: "activity.on" });
  await service.executeProxyCommand({ source_entity_id: "hass.main.light.a", cmd_id: "light.on", issued_at: 1 });
  assert.equal(executed.length, 2);
});

// -----------------------------------------------------------------------------
// Drift guard
// -----------------------------------------------------------------------------

function driftFixture({ report = async () => true } = {}) {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-"));
  const reports = [];
  const mappings = {
    kinds: () => ({
      activity: { "uc.main.src-act": "uc.main.sat-act" },
      macro: { "uc.main.src-mac": "uc.main.sat-mac" },
      profile: { "src-prof": "sat-prof" },
      "profile_page:src-prof": { "src-page": "sat-page" },
      activity_group: { "src-group": "sat-group" }
    })
  };
  // The Satellite's objects as its Core reports them; tests change them to simulate edits or running activities.
  const objects = {
    "/activities/uc.main.sat-act": { entity_id: "uc.main.sat-act", name: { en: "Apple TV" }, attributes: { state: "OFF" }, options: { entity_ids: ["a"] } },
    "/macros/uc.main.sat-mac": { entity_id: "uc.main.sat-mac", name: { en: "Macro" }, options: {} },
    "/activity_groups/sat-group": { group_id: "sat-group", name: { en: "Wohnzimmer" }, activities: [{ entity_id: "uc.main.sat-act", state: "OFF" }] },
    "/profiles/sat-prof": { profile_id: "sat-prof", name: "Family" }
  };
  const guard = new DriftGuard({
    getClient: () => ({ getJson: async (p) => (objects[p] ? structuredClone(objects[p]) : null), listPaginated: async () => [] }),
    getMappings: () => mappings,
    getSourceNode: () => "primary",
    report: async (objects) => { reports.push(objects); return report(objects); },
    backupDir,
    reportDelayMs: 5,
    applyGraceMs: 50
  });
  return { guard, reports, backupDir, objects };
}

test("a local edit of a synchronized activity is backed up and reported for restoration", async () => {
  const { guard, reports, backupDir, objects } = driftFixture();
  await guard.captureFingerprints();
  objects["/activities/uc.main.sat-act"].name = { en: "edited locally" };
  assert.equal(guard.note("entity_change", { entity_id: "uc.main.sat-act", entity_type: "activity", event_type: "CHANGE" }), true);
  await waitUntil(() => reports.length === 1, 1000, "report");
  assert.deepEqual(reports[0].map(({ kind, id }) => ({ kind, id })), [{ kind: "activity", id: "uc.main.sat-act" }]);
  const files = fs.readdirSync(backupDir);
  assert.equal(files.length, 1);
  const backup = JSON.parse(fs.readFileSync(path.join(backupDir, files[0]), "utf8"));
  assert.equal(backup.detail.name.en, "edited locally");
  assert.equal(guard.status().reverted_objects, 1);
});

test("objects that only exist on the Satellite and newly created objects are left alone", () => {
  const { guard } = driftFixture();
  assert.equal(guard.note("entity_change", { entity_id: "uc.main.local-only", entity_type: "activity", event_type: "UPDATE" }), false);
  assert.equal(guard.note("entity_change", { entity_id: "uc.main.sat-act", event_type: "CREATE" }), false);
  assert.equal(guard.note("profile_change", { profile_id: "local-profile" }), false);
  assert.equal(guard.note("profile_change", { profile_id: "sat-prof", page_id: "sat-page" }), true);
  assert.equal(guard.note("active_profile_change", { profile_id: "sat-prof" }), false);
  guard.stop();
});

test("Remote Sync's own changes while applying a snapshot are not drift", async () => {
  const { guard } = driftFixture();
  guard.beginApply();
  assert.equal(guard.note("entity_change", { entity_id: "uc.main.sat-act", event_type: "UPDATE" }), false);
  guard.endApply();
  assert.equal(guard.note("entity_change", { entity_id: "uc.main.sat-act", event_type: "UPDATE" }), false, "grace period after applying");
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(guard.note("entity_change", { entity_id: "uc.main.sat-act", event_type: "UPDATE" }), true);
  guard.stop();
});

test("drift found while the link is down is reported once it is back", async () => {
  let online = false;
  const { guard, reports, objects } = driftFixture({ report: async () => online });
  await guard.captureFingerprints();
  delete objects["/macros/uc.main.sat-mac"];
  guard.note("entity_change", { entity_id: "uc.main.sat-mac", event_type: "DELETE" });
  await waitUntil(() => reports.length === 1, 1000);
  assert.equal(guard.status().pending, 1);
  online = true;
  assert.equal(await guard.flush(), true);
  assert.equal(guard.status().pending, 0);
  assert.equal(reports.at(-1)[0].kind, "macro");
});

// -----------------------------------------------------------------------------
// Remote Two / Remote 3 hardware
// -----------------------------------------------------------------------------

test("hardware layouts are understood in the shapes a Core may answer with", () => {
  const listed = hardwareFromResponses({ version: { model: "UCR3" }, buttonLayout: [{ button: "HOME" }, { button: "BACK" }, { id: "VOICE" }], screenLayout: { grid: { width: 4, height: 6 } } });
  assert.deepEqual(listed, { model: "UCR3", hardware_revision: null, buttons: ["BACK", "HOME", "VOICE"], grid: { width: 4, height: 6 } });
  const keyed = hardwareFromResponses({ version: { model: "UCR2" }, buttonLayout: { buttons: { HOME: {}, BACK: {} } }, screenLayout: { width: 4, height: 7 } });
  assert.deepEqual(keyed.buttons, ["BACK", "HOME"]);
  assert.deepEqual(keyed.grid, { width: 4, height: 7 });
  const unknown = hardwareFromResponses({});
  assert.equal(unknown.buttons, null);
  assert.equal(unknown.grid, null);
});

test("button mappings for buttons the target remote lacks are skipped and reported", () => {
  const adapter = new HardwareAdapter({ model: "UCR3", buttons: ["HOME", "BACK", "MY_BUTTON"] }, { model: "UCR2", buttons: ["HOME", "BACK"] });
  const result = adapter.buttons([{ button: "HOME", short_press: { cmd_id: "a" } }, { button: "MY_BUTTON", short_press: { cmd_id: "b" } }], "activity TV buttons");
  assert.deepEqual(result.map((item) => item.button), ["HOME"]);
  assert.match(adapter.adjustments[0], /MY_BUTTON/);
});

test("nothing is removed when the target layout is unknown or not understood", () => {
  const mapping = [{ button: "HOME" }, { button: "BACK" }];
  assert.deepEqual(new HardwareAdapter(null, null).buttons(mapping, "x"), mapping);
  assert.deepEqual(new HardwareAdapter(null, { buttons: ["SOMETHING_ELSE"] }).buttons(mapping, "x"), mapping, "zero matches means the layout was misread");
  const page = { grid: { width: 4, height: 7 }, items: [{ location: { x: 0, y: 6 } }] };
  assert.deepEqual(new HardwareAdapter(null, { grid: null }).page(page, "x"), page);
});

test("UI pages larger than the target screen are reduced and items that no longer fit are skipped", () => {
  const adapter = new HardwareAdapter({ grid: { width: 4, height: 7 } }, { grid: { width: 4, height: 6 } });
  const page = { name: { en: "Main" }, grid: { width: 4, height: 7 }, items: [
    { type: "icon", location: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
    { type: "icon", location: { x: 0, y: 5 }, size: { width: 4, height: 1 } },
    { type: "icon", location: { x: 1, y: 6 }, size: { width: 1, height: 1 } },
    { type: "media", location: { x: 0, y: 4 }, size: { width: 4, height: 3 } }
  ] };
  const result = adapter.page(page, "activity TV UI");
  assert.deepEqual(result.grid, { width: 4, height: 6 });
  assert.equal(result.items.length, 2);
  assert.match(adapter.adjustments[0], /4×7 to 4×6, 2 item/);
  const fits = { grid: { width: 4, height: 6 }, items: [] };
  assert.equal(adapter.page(fits, "x"), fits, "pages that fit are not touched");
});

test("proxy remote entities have their button mapping and pages adapted too", () => {
  const adapter = new HardwareAdapter(null, { buttons: ["HOME"], grid: { width: 4, height: 6 } });
  const options = adapter.remoteOptions({ simple_commands: ["A"], button_mapping: [{ button: "HOME" }, { button: "RED" }], user_interface: { pages: [{ grid: { width: 4, height: 8 }, items: [] }] } }, "remote tv");
  assert.deepEqual(options.button_mapping, [{ button: "HOME" }]);
  assert.deepEqual(options.user_interface.pages[0].grid, { width: 4, height: 6 });
  assert.deepEqual(options.simple_commands, ["A"]);
});

// -----------------------------------------------------------------------------
// Primary decisions on reconnect
// -----------------------------------------------------------------------------

function masterWithSnapshot(changeHash) {
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  service.config = { role: "master", peers: [{ peer_id: "sat", name: "Sat", enabled: true }] };
  service.syncCoordinator.cachedSnapshot = () => ({ manifest: { content_hash: `content-${Date.now()}`, change_hash: changeHash } });
  const hub = service.createLinkHub();
  return { service, hub };
}

test("a reconnecting Satellite with the current configuration is not re-synchronized, even though live states changed", async () => {
  const { service, hub } = masterWithSnapshot("config-A");
  try {
    await hub.onHello({ peer_id: "sat", name: "Sat" }, { applied_change_hash: "config-A", applied_content_hash: "content-old" });
    assert.equal(service.peerSyncTimers.size, 0);
  } finally { hub.close(); for (const timer of service.peerSyncTimers.values()) clearTimeout(timer); }
});

test("a reconnecting Satellite that missed a configuration change is synchronized at once", async () => {
  const { service, hub } = masterWithSnapshot("config-B");
  try {
    await hub.onHello({ peer_id: "sat", name: "Sat" }, { applied_change_hash: "config-A" });
    assert.equal(service.peerSyncTimers.has("sat"), true);
  } finally { hub.close(); for (const timer of service.peerSyncTimers.values()) clearTimeout(timer); }
});

test("a Satellite that never applied a configuration is synchronized when it links", async () => {
  const { service, hub } = masterWithSnapshot("config-A");
  try {
    await hub.onHello({ peer_id: "sat", name: "Sat" }, {});
    assert.equal(service.peerSyncTimers.has("sat"), true);
  } finally { hub.close(); for (const timer of service.peerSyncTimers.values()) clearTimeout(timer); }
});

test("repeated drift reports cannot cause a synchronization loop", async () => {
  const { service, hub } = masterWithSnapshot("config-A");
  const scheduled = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { scheduled.push(ms); const timer = original(() => {}, 0); return timer; };
  try {
    hub.onDrift({ peer_id: "sat", name: "Sat" }, { objects: [{ kind: "activity", id: "a" }] });
    hub.onDrift({ peer_id: "sat", name: "Sat" }, { objects: [{ kind: "activity", id: "a" }] });
  } finally { globalThis.setTimeout = original; hub.close(); }
  assert.ok(scheduled.includes(0), "the first restoration runs right away");
  assert.equal(scheduled.filter((ms) => ms > 4 * 60_000).length, 1, "a repeated one waits several minutes");
});

// -----------------------------------------------------------------------------
// End to end: Primary service ↔ Satellite service over a real link
// -----------------------------------------------------------------------------

test("end to end: a paired Satellite links, mirrors live states and controls the Primary over the link", async () => {
  const port = await freePort();
  const closedPort = await freePort();
  // Primary
  const master = new RemoteSyncService({ load: () => null, save: () => {} });
  master.config = { role: "master", node_id: "m", node_name: "Living room", peers: [{ peer_id: "sat", name: "Bedroom", enabled: true, command_token: TOKEN, protocol: { capabilities: ["persistent_link"] } }] };
  const executed = [];
  master.client = {
    async executeEntityCommand(id, cmd) { executed.push(`${id}:${cmd}`); return {}; },
    async getJson(p) { return p === "/entities/hass.main.light.kitchen" ? { attributes: { state: "OFF" } } : null; },
    async activityReadiness() { return null; }
  };
  master.linkHub = master.createLinkHub();
  master.stateRelay.flushDelayMs = 5;
  master.stateRelay.setSnapshot({ data: { entities: [{ entity_id: "hass.main.light.kitchen", attributes: { state: "OFF" } }] } });
  const agent = new AgentServer({ ...master.config, agent_token: "m".repeat(40), agent_port: port }, {
    applyCallback: async () => ({}), statusCallback: () => ({}), syncCallback: async () => ({}), pairingCallback: async () => ({}),
    linkCallback: ({ socket, peer }) => master.linkHub.attach(socket, peer)
  });
  await agent.start();

  // Satellite
  const child = new RemoteSyncService({ load: () => null, save: () => {} });
  child.config = { role: "child", node_id: "c", node_name: "Bedroom", peers: [], remote: { host: "127.0.0.1", port: closedPort, scheme: "http", api_key: "x" }, pairing: {} };
  child.client = { async getJson() { return null; }, async versionInfo() { return { model: "UCR2" }; } };
  child.proxyStore = { save() {}, load() { return { entities: [] }; }, clear() {} };
  child.proxyCatalog = { entities: [{ local_id: "proxy_k", source_entity_id: "hass.main.light.kitchen", entity_type: "light", attributes: { state: "UNKNOWN" } }], mapping: {} };
  const shown = [];
  child.addProxyStateListener((changes) => shown.push(...changes));
  try {
    await child.markPaired({ master_id: "m", master_name: "Living room", master_agent_url: `http://127.0.0.1:${port}`, master_command_token: TOKEN });
    await waitUntil(() => child.link?.connected, 4000, "satellite link");
    await waitUntil(() => child.proxyCatalog.entities[0].attributes.state === "OFF", 2000, "initial image");

    // A device changes on the Primary.
    master.stateRelay.handle({ entity_id: "hass.main.light.kitchen", attributes: { state: "ON", brightness: 200 } });
    await waitUntil(() => child.proxyCatalog.entities[0].attributes.brightness === 200, 2000, "live state");
    assert.ok(shown.some((change) => change.local_id === "proxy_k" && change.attributes.state === "ON"));

    // The Satellite controls the device and starts an activity.
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("HTTP must not be used while the link is up"); };
    try {
      const command = await child.forwardProxyCommand("hass.main.light.kitchen", "off", undefined, { entityType: "light" });
      assert.equal(command.success, true);
      const activity = await child.forwardActivityCommand("uc.main.watch-tv", "on");
      assert.equal(activity.success, true);
    } finally { globalThis.fetch = original; }
    assert.deepEqual(executed, ["hass.main.light.kitchen:light.off", "uc.main.watch-tv:activity.on"]);
    assert.equal(master.linkHub.isConnected("sat"), true);
    assert.equal(child.statusPayload().link.connected, true);
  } finally {
    await child.stop();
    master.linkHub.close();
    await agent.stop();
  }
});

test("starting an activity is not a local edit, although the activity and its group report changes", async () => {
  const { guard, reports, objects } = driftFixture();
  await guard.captureFingerprints();
  // What happens on a Satellite when an activity runs: its state and the group's view of it change.
  objects["/activities/uc.main.sat-act"].attributes = { state: "ON", step: 2, total_steps: 4 };
  objects["/activity_groups/sat-group"].activities[0].state = "ON";
  guard.note("entity_change", { event_type: "CHANGE", entity_id: "uc.main.sat-act", entity_type: "activity", new_state: { name: { en: "Apple TV" }, attributes: { state: "ON" } } });
  guard.note("activity_group_change", { event_type: "CHANGE", group_id: "sat-group", new_state: objects["/activity_groups/sat-group"] });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(reports, [], "running an activity must never trigger a restoration");
  assert.ok(guard.status().checks >= 2, "the objects were checked");
  guard.stop();
});

test("a real change of a group's members is still detected", async () => {
  const { guard, reports, objects } = driftFixture();
  await guard.captureFingerprints();
  objects["/activity_groups/sat-group"].activities = [];
  guard.note("activity_group_change", { event_type: "CHANGE", group_id: "sat-group", new_state: objects["/activity_groups/sat-group"] });
  await waitUntil(() => reports.length === 1, 1000, "group drift");
  assert.equal(reports[0][0].kind, "activity_group");
  guard.stop();
});

test("the Primary ignores group events that only report running activities", async () => {
  const { groupFingerprint } = await import("../src/service/index.js");
  const idle = { group_id: "g", name: { en: "Wohnzimmer" }, options: {}, activities: [{ entity_id: "a", name: { en: "Apple TV" }, state: "OFF" }] };
  const running = structuredClone(idle); running.activities[0].state = "ON";
  const edited = structuredClone(idle); edited.activities.push({ entity_id: "b", name: { en: "Vinyl" } });
  assert.equal(groupFingerprint(idle), groupFingerprint(running));
  assert.notEqual(groupFingerprint(idle), groupFingerprint(edited));
  assert.equal(groupFingerprint(idle), groupFingerprint({ ...idle, activities: undefined, activity_ids: ["a"] }), "snapshot records and events compare equal");
});

test("a Satellite whose last attempt failed is not re-synchronized on every wake-up", async () => {
  const { service, hub } = masterWithSnapshot("config-B");
  try {
    service.satelliteManager.record("sat", { last_attempted_change_hash: "config-B", last_error: "page rejected", last_sync_at: new Date().toISOString() });
    await hub.onHello({ peer_id: "sat", name: "Sat" }, { applied_change_hash: "config-A" });
    assert.equal(service.peerSyncTimers.size, 0, "left to the retry backoff");
    service.satelliteManager.record("sat", { last_attempted_change_hash: "config-OLD" });
    await hub.onHello({ peer_id: "sat", name: "Sat" }, { applied_change_hash: "config-A" });
    assert.equal(service.peerSyncTimers.has("sat"), true, "a newer configuration is still sent");
  } finally { hub.close(); for (const timer of service.peerSyncTimers.values()) clearTimeout(timer); }
});
