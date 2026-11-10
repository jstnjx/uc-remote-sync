import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { IntegrationAPI, StatusCodes } from "../src/integration/api.js";
import { EntityManager } from "../src/integration/entities.js";
import { AgentServer } from "../src/agent/server.js";
import { entityChangeAttributes } from "../src/core/events.js";
import { ProxyStateRelay } from "../src/service/state-relay.js";
import { proxyCommandCandidates, RemoteSyncService } from "../src/service/index.js";
import { CoreApiError } from "../src/core/client.js";
import { reachableAgentUrl } from "../src/shared/util.js";
import { connectWebSocket } from "../src/transport/websocket.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

class FakeService {
  constructor() {
    this.status = { state: "connected", last_sync_at: null, last_sync_result: "ok", pending_changes: false };
    this.config = { role: "child", pairing_identifier: "RMS-ABCD-EFGH", peers: [] };
    this.agentUrl = "http://child:11081";
    this.proxyCatalog = { entities: [] };
    this.commands = [];
  }
  addStatusListener(listener) { this.statusListener = listener; }
  addProxyListener(listener) { this.proxyListener = listener; }
  addProxyStateListener(listener) { this.proxyStateListener = listener; }
  async forwardProxyCommand(sourceEntityId, cmdId, params, options) { this.commands.push({ sourceEntityId, cmdId, params, options }); return { success: true }; }
  async forwardActivityCommand() { return { success: true }; }
}

function lightDescriptor(attributes) {
  return { local_id: "proxy_1", target_entity_id: "remote_sync.main.proxy_1", source_entity_id: "hass.main.light.kitchen", entity_type: "light", name: { en: "Kitchen" }, features: ["on_off"], attributes };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

// -----------------------------------------------------------------------------
// Integration driver: subscribed proxy entities receive state changes
// -----------------------------------------------------------------------------

async function subscribedApi(initialAttributes) {
  const port = await freePort();
  const previous = { port: process.env.UC_INTEGRATION_HTTP_PORT, mdns: process.env.UC_DISABLE_MDNS_PUBLISH };
  process.env.UC_INTEGRATION_HTTP_PORT = String(port);
  process.env.UC_DISABLE_MDNS_PUBLISH = "true";
  const api = new IntegrationAPI();
  const service = new FakeService();
  service.proxyCatalog = { entities: [lightDescriptor(initialAttributes)] };
  const manager = new EntityManager(api, service);
  manager.register();
  await api.init({ driver_id: "remote_sync", version: "1.0.0", min_core_api: "0.17.0", name: { en: "Remote Sync" }, developer: { name: "test" }, port });
  const client = await connectWebSocket(`ws://127.0.0.1:${port}/`);
  const sent = [];
  client.on("message", (value) => sent.push(JSON.parse(value.toString())));
  let nextId = 100;
  const request = async (msg, msg_data = {}, id = nextId++) => {
    client.send(JSON.stringify({ kind: "req", id, msg, msg_data }));
    return waitFor(sent, (item) => item.kind === "resp" && item.req_id === id);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  return {
    api, service, manager, sent, request, settle,
    changes: () => sent.filter((item) => item.msg === "entity_change").map((item) => item.msg_data),
    async close() {
      client.close();
      await api.close();
      if (previous.port === undefined) delete process.env.UC_INTEGRATION_HTTP_PORT; else process.env.UC_INTEGRATION_HTTP_PORT = previous.port;
      if (previous.mdns === undefined) delete process.env.UC_DISABLE_MDNS_PUBLISH; else process.env.UC_DISABLE_MDNS_PUBLISH = previous.mdns;
    }
  };
}

async function waitFor(messages, predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Message timeout: ${JSON.stringify(messages).slice(0, 1000)}`);
}

test("a subscribed proxy entity reports state changes from a new snapshot to the Remote", async () => {
  const session = await subscribedApi({ state: "OFF" });
  try {
    await session.request("subscribe_events", { entity_ids: ["proxy_1"] });
    const states = await session.request("get_entity_states");
    assert.deepEqual(states.msg_data.map((item) => item.attributes.state), ["OFF"]);

    session.service.proxyListener({ entities: [lightDescriptor({ state: "ON", brightness: 120 })] });
    await session.settle();
    assert.deepEqual(session.changes(), [{ entity_id: "proxy_1", entity_type: "light", attributes: { state: "ON", brightness: 120 } }]);
    const after = await session.request("get_entity_states");
    assert.equal(after.msg_data[0].attributes.state, "ON");
  } finally { await session.close(); }
});

test("live proxy state updates reach subscribed entities only once and only when changed", async () => {
  const session = await subscribedApi({ state: "OFF" });
  try {
    await session.request("subscribe_events", { entity_ids: ["proxy_1"] });
    session.service.proxyStateListener([{ local_id: "proxy_1", attributes: { state: "ON" } }]);
    session.service.proxyStateListener([{ local_id: "proxy_1", attributes: { state: "ON" } }]);
    session.service.proxyStateListener([{ local_id: "unknown", attributes: { state: "ON" } }]);
    await session.settle();
    assert.deepEqual(session.changes(), [{ entity_id: "proxy_1", entity_type: "light", attributes: { state: "ON" } }]);
  } finally { await session.close(); }
});

test("status sensors still notify the Remote after the store separation", async () => {
  const session = await subscribedApi({ state: "OFF" });
  try {
    await session.request("subscribe_events", { entity_ids: ["status"] });
    session.service.statusListener({ ...session.service.status, state: "error" }, session.service.config);
    await session.settle();
    assert.ok(session.changes().some((item) => item.entity_id === "status" && item.attributes.value === "error"));
  } finally { await session.close(); }
});

test("a command for a configured entity without a prior subscription is still executed", async () => {
  const session = await subscribedApi({ state: "OFF" });
  try {
    const response = await session.request("entity_command", { entity_type: "light", entity_id: "proxy_1", cmd_id: "on", params: { brightness: 10 } });
    assert.equal(response.code, StatusCodes.Ok);
    assert.deepEqual(session.service.commands, [{ sourceEntityId: "hass.main.light.kitchen", cmdId: "on", params: { brightness: 10 }, options: { entityType: "light" } }]);
  } finally { await session.close(); }
});

// -----------------------------------------------------------------------------
// Command ids
// -----------------------------------------------------------------------------

test("short Integration-API command ids are qualified for the Core REST API", () => {
  assert.deepEqual(proxyCommandCandidates("on", "light"), ["light.on", "on"]);
  assert.deepEqual(proxyCommandCandidates("play_pause", "media_player"), ["media_player.play_pause", "play_pause"]);
  assert.deepEqual(proxyCommandCandidates("light.on", "light"), ["light.on"]);
  assert.deepEqual(proxyCommandCandidates("activity.on", null), ["activity.on"]);
  assert.deepEqual(proxyCommandCandidates("on", null), ["on"]);
});

test("the Primary falls back to the short command id when the Core rejects the qualified one", async () => {
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  service.config = { role: "master", peers: [] };
  const executed = [];
  service.client = {
    async executeEntityCommand(_id, cmdId) {
      executed.push(cmdId);
      if (cmdId === "media_player.MY_RECORDINGS") throw new CoreApiError(400, "PUT", "/entities/x/command", { code: "BAD_REQUEST" });
      return {};
    },
    async getJson() { return { attributes: { state: "ON" } }; }
  };
  const result = await service.executeProxyCommand({ source_entity_id: "x", cmd_id: "MY_RECORDINGS", entity_type: "media_player" });
  assert.equal(result.success, true);
  assert.deepEqual(executed, ["media_player.MY_RECORDINGS", "MY_RECORDINGS"]);

  executed.length = 0;
  const qualified = await service.executeProxyCommand({ source_entity_id: "x", cmd_id: "on", entity_type: "light" });
  assert.equal(qualified.success, true);
  assert.equal(qualified.cmd_id, "light.on");
  assert.deepEqual(executed, ["light.on"]);
});

// -----------------------------------------------------------------------------
// Agent URL
// -----------------------------------------------------------------------------

test("an external Primary advertises its own address, not the Primary Remote's", () => {
  const interfaces = {
    docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
    eth0: [{ family: "IPv4", address: "192.168.1.10", internal: false }],
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }]
  };
  const external = { remote: { host: "192.168.1.20" }, agent_port: 11081 };
  assert.equal(reachableAgentUrl(external, { interfaces, env: {} }), "http://192.168.1.10:11081");
  assert.equal(reachableAgentUrl(external, { interfaces, env: { UC_MDNS_ADDRESS: "192.168.1.99" } }), "http://192.168.1.99:11081");

  const onRemote = { remote: { host: "192.168.1.20" }, agent_port: 11081 };
  const remoteInterfaces = { wlan0: [{ family: "IPv4", address: "192.168.1.20", internal: false }], usb0: [{ family: "IPv4", address: "10.0.0.1", internal: false }] };
  assert.equal(reachableAgentUrl(onRemote, { interfaces: { usb0: remoteInterfaces.usb0, wlan0: remoteInterfaces.wlan0 }, env: {} }), "http://192.168.1.20:11081");
  assert.equal(reachableAgentUrl({ ...onRemote, agent_public_url: "http://primary.lan:11081/" }, { interfaces, env: {} }), "http://primary.lan:11081");
});

// -----------------------------------------------------------------------------
// Core events and the live state relay
// -----------------------------------------------------------------------------

test("entity_change attributes are read from every event shape the Core uses", () => {
  assert.deepEqual(entityChangeAttributes({ attributes: { state: "ON" } }), { state: "ON" });
  assert.deepEqual(entityChangeAttributes({ new_state: { attributes: { state: "PLAYING", volume: 20 } } }), { state: "PLAYING", volume: 20 });
  assert.deepEqual(entityChangeAttributes({ entity: { attributes: { state: "OFF" } } }), { state: "OFF" });
  assert.deepEqual(entityChangeAttributes({ new_state: "ON" }), { state: "ON" });
  assert.equal(entityChangeAttributes({ event_type: "CHANGE" }), null);
});

test("the Primary relays coalesced live states of proxied entities to enabled Satellites", async () => {
  const pushes = [];
  const config = { role: "master", peers: [
    { peer_id: "a", name: "A", token: "token-a", enabled: true },
    { peer_id: "b", name: "B", token: "token-b", enabled: false }
  ] };
  const relay = new ProxyStateRelay({
    getConfig: () => config,
    getClient: () => ({ async getJson(path) { return path.includes("sensor") ? { attributes: { state: "ON", value: 21.5, nested: { ignored: true } } } : null; } }),
    resolvePeerUrl: async (peer) => ({ url: `http://${peer.peer_id}.test:11081` }),
    fetchImpl: async (url, options) => { pushes.push({ url, auth: options.headers.Authorization, body: JSON.parse(options.body) }); return new Response("{}", { status: 200 }); },
    flushDelayMs: 5
  });
  relay.setSnapshot({ data: { entities: [{ entity_id: "hass.main.media_player.tv" }, { entity_id: "hass.main.sensor.temp" }], remotes: [] } });

  assert.equal(relay.handle({ entity_id: "hass.main.light.not_proxied", attributes: { state: "ON" } }), false);
  relay.handle({ entity_id: "hass.main.media_player.tv", attributes: { state: "PLAYING" } });
  relay.handle({ entity_id: "hass.main.media_player.tv", attributes: { media_title: "News" } });
  relay.handle({ entity_id: "hass.main.sensor.temp", attributes: null });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await relay.flush();

  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].url, "http://a.test:11081/v1/proxy/state");
  assert.equal(pushes[0].auth, "Bearer token-a");
  assert.deepEqual(pushes[0].body.states, [
    { source_entity_id: "hass.main.media_player.tv", attributes: { state: "PLAYING", media_title: "News" } },
    { source_entity_id: "hass.main.sensor.temp", attributes: { state: "ON", value: 21.5 } }
  ]);
  const current = await relay.currentStates();
  assert.equal(current.length, 2);
});

test("a Satellite without the live state endpoint is skipped until the next snapshot", async () => {
  let calls = 0;
  const config = { role: "master", peers: [{ peer_id: "old", name: "Old", token: "t", enabled: true }] };
  const relay = new ProxyStateRelay({
    getConfig: () => config,
    getClient: () => null,
    resolvePeerUrl: async () => ({ url: "http://old.test:11081" }),
    fetchImpl: async () => { calls += 1; return new Response("{}", { status: 404 }); },
    flushDelayMs: 1
  });
  relay.setSnapshot({ data: { entities: [{ entity_id: "hass.main.light.x" }] } });
  relay.handle({ entity_id: "hass.main.light.x", attributes: { state: "ON" } });
  await new Promise((resolve) => setTimeout(resolve, 10)); await relay.flush();
  relay.handle({ entity_id: "hass.main.light.x", attributes: { state: "OFF" } });
  await new Promise((resolve) => setTimeout(resolve, 10)); await relay.flush();
  assert.equal(calls, 1);
});

test("a Satellite applies pushed proxy states and serves them to its integration driver", async () => {
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  service.config = { role: "child", pairing: { paired_master_id: "m" }, peers: [] };
  service.proxyStore = { save() {}, load() { return { entities: [] }; }, clear() {} };
  service.proxyCatalog = { entities: [lightDescriptor({ state: "OFF" })], mapping: {} };
  const received = [];
  service.addProxyStateListener((changes) => received.push(...changes));
  const result = service.applyProxyStates([
    { source_entity_id: "hass.main.light.kitchen", attributes: { state: "ON", brightness: 80, junk: { x: 1 } } },
    { source_entity_id: "hass.main.light.unknown", attributes: { state: "ON" } }
  ]);
  assert.deepEqual(result, { success: true, applied: 1 });
  assert.deepEqual(received, [{ local_id: "proxy_1", attributes: { state: "ON", brightness: 80 } }]);
  assert.equal(service.proxyCatalog.entities[0].attributes.brightness, 80);
  await service.stop();
});

test("agent routes accept pushed states on a Satellite and serve current states on a Primary", async () => {
  const childPort = await freePort();
  const childConfig = { role: "child", node_id: "c", node_name: "C", agent_token: "s".repeat(40), agent_port: childPort, pairing: {} };
  let applied = null;
  const child = new AgentServer(childConfig, {
    applyCallback: async () => ({}), statusCallback: () => ({}), syncCallback: async () => ({}), pairingCallback: async () => ({}),
    proxyStateCallback: async (states) => { applied = states; return { success: true, applied: states.length }; }
  });
  const masterPort = await freePort();
  const masterConfig = { role: "master", node_id: "m", node_name: "M", agent_token: "m".repeat(40), agent_port: masterPort, peers: [{ peer_id: "c", enabled: true, command_token: "k".repeat(40) }] };
  const master = new AgentServer(masterConfig, {
    applyCallback: async () => ({}), statusCallback: () => ({}), syncCallback: async () => ({}), pairingCallback: async () => ({}),
    proxyStatesCallback: async () => [{ source_entity_id: "x", attributes: { state: "ON" } }]
  });
  await child.start(); await master.start();
  try {
    const states = [{ source_entity_id: "x", attributes: { state: "ON" } }];
    const denied = await fetch(`http://127.0.0.1:${childPort}/v1/proxy/state`, { method: "POST", headers: { Authorization: "Bearer wrong" }, body: JSON.stringify({ states }) });
    assert.equal(denied.status, 401);
    const pushed = await fetch(`http://127.0.0.1:${childPort}/v1/proxy/state`, { method: "POST", headers: { Authorization: `Bearer ${childConfig.agent_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ states }) });
    assert.equal(pushed.status, 200);
    assert.deepEqual(applied, states);

    const pulled = await fetch(`http://127.0.0.1:${masterPort}/v1/proxy/states`, { headers: { Authorization: `Bearer ${"k".repeat(40)}` } });
    assert.equal(pulled.status, 200);
    assert.deepEqual((await pulled.json()).states, states);
    const wrongToken = await fetch(`http://127.0.0.1:${masterPort}/v1/proxy/states`, { headers: { Authorization: `Bearer ${masterConfig.agent_token}` } });
    assert.equal(wrongToken.status, 401);
  } finally { await child.stop(); await master.stop(); }
});

// -----------------------------------------------------------------------------
// Findings from field logs (Remote 3, firmware core 0.83.2)
// -----------------------------------------------------------------------------

test("a slow forward is answered before the Remote's command timeout and finishes in the background", async () => {
  const { answerWithin } = await import("../src/integration/entities.js");
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  let late = null;
  const started = Date.now();
  const result = await answerWithin(slow, 30, (value) => { late = value; });
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(result, { success: true, pending: true });
  release({ success: false, error: "primary failed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(late, { success: false, error: "primary failed" });

  const fast = await answerWithin(Promise.resolve({ success: true, status: 200 }), 1000, () => assert.fail("not late"));
  assert.deepEqual(fast, { success: true, status: 200 });
});

test("a refused connection to the Primary fails fast instead of waking it for 90 seconds", async () => {
  const port = await freePort();
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  service.config = { role: "child", peers: [], pairing: { master_agent_url: `http://127.0.0.1:${port}`, master_command_token: "t".repeat(32), master_mac: "aa:bb:cc:dd:ee:ff", master_broadcasts: ["127.255.255.255"] } };
  const started = Date.now();
  const result = await service.forwardProxyCommand("uc.main.activity", "activity.on");
  assert.equal(result.success, false);
  assert.match(result.error, /not running on the Primary/);
  assert.ok(Date.now() - started < 3000);
});

test("the dashboard learns whether the remote has finished the integration setup", async () => {
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  assert.equal(await service.setupFinished(), null);
  service.setRuntimeInfoProvider(async () => ({ driver_id: "remote_sync", intg_ids: [] }));
  assert.equal(await service.setupFinished(), false);
  service.setRuntimeInfoProvider(async () => ({ driver_id: "remote_sync", intg_ids: ["remote_sync.main"] }));
  assert.equal(await service.setupFinished(), true);
  service.setRuntimeInfoProvider(async () => { throw new Error("no remote"); });
  assert.equal(await service.setupFinished(), null);
});

test("Core-internal remote options are not advertised and do not change proxy ids", async () => {
  const { buildProxyCatalog } = await import("../src/proxy/catalog.js");
  const manifest = (options) => ({ source_node_id: "m", data: { entities: [], remotes: [{ source_id: "uc.main.remote.tv", detail: { name: { en: "TV" }, features: ["send_cmd"], options } }] } });
  const previous = buildProxyCatalog(manifest({ kind: "IR", editable: true, simple_commands: ["A"] }));
  const next = buildProxyCatalog(manifest({ kind: "IR", editable: true, simple_commands: ["A"] }), { entities: previous.entities.map((item) => ({ ...item, options: { ...item.options, kind: "IR", editable: true } })) });
  assert.equal(next.entities[0].options.kind, undefined);
  assert.equal(next.entities[0].options.editable, undefined);
  assert.equal(next.entities[0].local_id, previous.entities[0].local_id);
});

test("playback position updates are relayed at most every few seconds, other changes immediately", async () => {
  const published = [];
  const relay = new ProxyStateRelay({
    getConfig: () => ({ role: "master", peers: [] }), getClient: () => null, resolvePeerUrl: async () => ({ url: "http://x" }),
    publish: (states) => published.push(...states), flushDelayMs: 2, positionIntervalMs: 80
  });
  relay.setSnapshot({ data: { entities: [{ entity_id: "hass.main.media_player.tv" }] } });
  const id = "hass.main.media_player.tv";
  relay.handle({ entity_id: id, attributes: { state: "PLAYING", media_position: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 15));
  for (let second = 2; second <= 5; second += 1) relay.handle({ entity_id: id, attributes: { media_position: second } });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(published.length, 1, "position-only updates are held back");

  relay.handle({ entity_id: id, attributes: { media_title: "Next" } });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(published.length, 2);
  assert.deepEqual(published[1].attributes, { media_position: 5, media_title: "Next" }, "a real change carries the latest position");

  relay.handle({ entity_id: id, attributes: { media_position: 9 } });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(published.at(-1).attributes, { media_position: 9 }, "held positions are still delivered after the interval");
  relay.clear();
});
