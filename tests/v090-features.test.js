import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { CoreApiError, CoreClient } from "../src/core/client.js";
import { CoreWebSocket } from "../src/core/events.js";
import {
  IntegrationAPI, RequestUserInput, SetupError, Select, IntegrationSetupError, localize, messageText
} from "../src/integration/api.js";
import { acceptWebSocketUpgrade, connectWebSocket } from "../src/transport/websocket.js";
import { bool, checkbox, number, password } from "../src/setup/forms.js";
import { installOrUpdateDriver, provisionSatelliteByPin, runRemoteDriverSetup } from "../src/service/satellite-provisioner.js";
import { AgentServer } from "../src/agent/server.js";
import { createUiHandler } from "../src/web/server.js";
import { SatelliteManager } from "../src/service/satellite-manager.js";
import { buildDriverArchive } from "../src/shared/package.js";
import { buildApplyPreview } from "../src/apply/preview.js";
import { compareVersions, safeEqual, versionAtLeast } from "../src/shared/util.js";
import { APP_VERSION } from "../src/shared/constants.js";
import { stableConfiguration } from "../src/protocol/snapshot.js";
import { recentLogs } from "../src/shared/logger.js";

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

async function waitFor(messages, predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Message timeout: ${JSON.stringify(messages).slice(0, 2000)}`);
}

async function fakeCoreWebSocket({ rejectFirst = 0, retryAfter = "0" } = {}) {
  const port = await freePort();
  const stats = { connections: 0, open: 0, maxOpen: 0, rejected: 0, requests: [] };
  const server = http.createServer((request, response) => { response.writeHead(404); response.end(); });
  server.on("upgrade", (request, socket, head) => {
    if (stats.rejected < rejectFirst) {
      stats.rejected += 1;
      socket.end(`HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${retryAfter}\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const peer = acceptWebSocketUpgrade(request, socket, head);
    stats.connections += 1; stats.open += 1; stats.maxOpen = Math.max(stats.maxOpen, stats.open);
    peer.on("close", () => { stats.open -= 1; });
    peer.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      stats.requests.push(message.msg);
      peer.send(JSON.stringify({ kind: "resp", req_id: message.id, code: 200, msg: "result", msg_data: { echo: message.msg } }));
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, stats, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// -----------------------------------------------------------------------------
// Core client
// -----------------------------------------------------------------------------

test("Core WebSocket requests share one session instead of one connection per call", async () => {
  const core = await fakeCoreWebSocket();
  const client = new CoreClient({ host: "127.0.0.1", port: core.port, api_key: "abcdefghijklmnop" });
  try {
    const results = await Promise.all(["get_profiles", "get_pages", "get_groups", "get_docks", "update_page"].map((name) => client.coreMessage(name, {})));
    assert.deepEqual(results.map((item) => item.echo), ["get_profiles", "get_pages", "get_groups", "get_docks", "update_page"]);
    await client.coreMessage("get_profile", {});
    assert.equal(core.stats.connections, 1);
    assert.equal(core.stats.maxOpen, 1);
  } finally {
    await client.close();
    await core.close();
  }
});

test("Core WebSocket connect waits and retries when the Core reports its connection limit (503)", async () => {
  const core = await fakeCoreWebSocket({ rejectFirst: 2, retryAfter: "0" });
  const socket = new CoreWebSocket({ host: "127.0.0.1", port: core.port, api_key: "abcdefghijklmnop" });
  try {
    const response = await socket.request("get_version", undefined, 5000);
    assert.equal(response.msg_data.echo, "get_version");
    assert.equal(core.stats.rejected, 2);
    assert.equal(core.stats.connections, 1);
  } finally {
    await socket.close();
    await core.close();
  }
});

test("Wake on WLAN is read from wifi.wake_on_wlan with a fallback to the deprecated field", async () => {
  const calls = [];
  let modern = true;
  const fetchImpl = async (url, options) => {
    calls.push({ method: options.method, path: new URL(url).pathname, body: options.body ? JSON.parse(options.body) : null });
    if (options.method === "GET") return jsonResponse(200, modern ? { wifi: { wake_on_wlan: { enabled: false } } } : { wake_on_wlan: { enabled: true } });
    if (options.body && JSON.parse(options.body).wifi) return jsonResponse(400, { message: "unknown field wifi" });
    return jsonResponse(200, {});
  };
  const client = new CoreClient({ host: "remote", api_key: "abcdefghijklmnop" }, { fetchImpl });
  assert.equal(await client.wakeOnWlan(), false);
  modern = false;
  assert.equal(await client.wakeOnWlan(), true);
  await client.setWakeOnWlan(true);
  const patches = calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(patches.map((call) => call.body), [{ wifi: { wake_on_wlan: { enabled: true } } }, { wake_on_wlan: { enabled: true } }]);
});

test("compatibility fallbacks surface a real validation error instead of a later 404", async () => {
  const fetchImpl = async (url) => new URL(url).pathname.endsWith("/first")
    ? jsonResponse(400, { message: "name is required" })
    : jsonResponse(404, { message: "not found" });
  const client = new CoreClient({ host: "remote", api_key: "abcdefghijklmnop" }, { fetchImpl });
  await assert.rejects(
    client.requestFirst([{ kind: "json", method: "POST", path: "/first" }, { kind: "json", method: "POST", path: "/second" }]),
    (error) => error instanceof CoreApiError && error.status === 400
  );
});

test("API key creation uses unique names and retries when the Core reports ALREADY_EXISTS", async () => {
  const names = [];
  let first = true;
  const fetchImpl = async (_url, options) => {
    const name = JSON.parse(options.body).name;
    names.push(name);
    if (first) { first = false; return jsonResponse(422, { code: "ALREADY_EXISTS", message: "Data already exists" }); }
    return jsonResponse(201, { name, api_key: "new-key-abcdefghijklmnop", active: true, scopes: ["admin"] });
  };
  const result = await CoreClient.provisionApiKey("remote", "1234", { name: "Remote Sync Living Room", fetchImpl });
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  for (const name of names) assert.match(name, /^Remote Sync Living Room [0-9a-f]{6}$/);
  assert.equal(result.name, names[1]);
  assert.equal(result.apiKey, "new-key-abcdefghijklmnop");
});

test("keys created by Remote Sync are revoked by exact name", async () => {
  const deleted = [];
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    if (options.method === "DELETE") { deleted.push(target.pathname); return new Response(null, { status: 204 }); }
    return jsonResponse(200, [{ key_id: "k1", name: "Remote Sync abc123" }, { key_id: "k2", name: "Remote Sync abc1234" }, { key_id: "k3", name: "Home Assistant" }], { "Pagination-Count": "3" });
  };
  const client = new CoreClient({ host: "remote", api_key: "abcdefghijklmnop" }, { fetchImpl });
  assert.equal(await client.deleteApiKeysNamed("Remote Sync abc123"), 1);
  assert.deepEqual(deleted, ["/api/auth/api_keys/k1"]);
});

test("Web Configurator PIN verification uses the Core login endpoint", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(new URL(url).pathname);
    if (new URL(url).pathname === "/api/pub/logout") return jsonResponse(200, {});
    return JSON.parse(options.body).password === "1234" ? jsonResponse(200, {}, { "Set-Cookie": "id=x; Path=/" }) : jsonResponse(401, {});
  };
  assert.equal(await CoreClient.verifyWebConfiguratorPin("remote", "0000", { fetchImpl }), false);
  assert.equal(await CoreClient.verifyWebConfiguratorPin("remote", "1234", { fetchImpl }), true);
  assert.ok(seen.includes("/api/pub/login"));
});

// -----------------------------------------------------------------------------
// Integration API setup protocol
// -----------------------------------------------------------------------------

async function setupSession(handler) {
  const port = await freePort();
  const previous = { port: process.env.UC_INTEGRATION_HTTP_PORT, mdns: process.env.UC_DISABLE_MDNS_PUBLISH };
  process.env.UC_INTEGRATION_HTTP_PORT = String(port);
  process.env.UC_DISABLE_MDNS_PUBLISH = "true";
  const api = new IntegrationAPI();
  await api.init({ driver_id: "test_driver", version: "1.0.0", min_core_api: "0.17.0", name: { en: "Test" }, developer: { name: "jstnjx" }, port }, handler);
  const client = await connectWebSocket(`ws://127.0.0.1:${port}/`);
  const messages = [];
  client.on("message", (value) => messages.push(JSON.parse(value.toString())));
  return {
    api, client, messages,
    async close() {
      client.close();
      await api.close();
      process.env.UC_INTEGRATION_HTTP_PORT = previous.port;
      if (previous.mdns === undefined) delete process.env.UC_DISABLE_MDNS_PUBLISH; else process.env.UC_DISABLE_MDNS_PUBLISH = previous.mdns;
    }
  };
}

const rejectedPage = () => new RequestUserInput({ en: "Set up", de: "Einrichten" }, [password("pin", { en: "PIN", de: "PIN" })], { errorMessage: { en: "Wrong PIN", de: "Falsche PIN" } });

test("rejected input is corrected in place with INVALID_INPUT on Remotes with the new setup API", async () => {
  const session = await setupSession(async () => rejectedPage());
  try {
    session.client.send(JSON.stringify({ kind: "req", id: 1, msg: "setup_driver", msg_data: { setup_data: {}, reconfigure: false, language: "de_DE" } }));
    const page = await waitFor(session.messages, (item) => item.msg === "driver_setup_change" && item.msg_data.state === "WAIT_USER_ACTION");
    assert.equal(page.msg_data.error, "INVALID_INPUT");
    assert.deepEqual(page.msg_data.error_message, { de: "Falsche PIN", en: "Wrong PIN" });
    assert.deepEqual(page.msg_data.require_user_action.input.title, { de: "Einrichten", en: "Set up" });
    assert.deepEqual(page.msg_data.require_user_action.input.settings.map((item) => item.id), ["pin"]);
  } finally { await session.close(); }
});

test("older Remotes get the rejection as a label and only legacy error codes", async () => {
  let call = 0;
  const session = await setupSession(async () => (call++ === 0 ? rejectedPage() : new SetupError(IntegrationSetupError.AlreadyConfigured, "Already set up")));
  try {
    session.client.send(JSON.stringify({ kind: "req", id: 1, msg: "setup_driver", msg_data: { setup_data: {}, reconfigure: false } }));
    const page = await waitFor(session.messages, (item) => item.msg === "driver_setup_change" && item.msg_data.state === "WAIT_USER_ACTION");
    assert.equal(page.msg_data.error, undefined);
    const settings = page.msg_data.require_user_action.input.settings;
    assert.equal(settings[0].id, "error");
    assert.equal(settings[0].field.label.value.en, "Wrong PIN");
    session.client.send(JSON.stringify({ kind: "req", id: 2, msg: "set_driver_user_data", msg_data: { input_values: { pin: "1" } } }));
    const stop = await waitFor(session.messages, (item) => item.msg === "driver_setup_change" && item.msg_data.event_type === "STOP", 3000);
    assert.equal(stop.msg_data.error, "OTHER");
    assert.equal(stop.msg_data.error_message, undefined);
  } finally { await session.close(); }
});

test("the driver asks the Remote for its version and runtime information", async () => {
  const session = await setupSession(async () => rejectedPage());
  try {
    const versionRequest = await waitFor(session.messages, (item) => item.kind === "req" && item.msg === "get_version");
    session.client.send(JSON.stringify({ kind: "resp", req_id: versionRequest.id, code: 200, msg: "version", msg_data: { api: "0.19.1" } }));
    const runtimeRequest = await waitFor(session.messages, (item) => item.kind === "req" && item.msg === "get_runtime_info");
    session.client.send(JSON.stringify({ kind: "resp", req_id: runtimeRequest.id, code: 200, msg: "runtime_info", msg_data: { driver_id: "test_driver", intg_ids: ["test_driver.main"] } }));
    const info = await new Promise((resolve) => session.api.once("remote_info", resolve));
    assert.equal(info.version.api, "0.19.1");
    assert.deepEqual(info.runtime.intg_ids, ["test_driver.main"]);
    assert.equal(session.api.supportsSetupV2, true);
  } finally { await session.close(); }
});

test("localization narrows texts to the requested language with an English fallback", () => {
  assert.deepEqual(localize({ en: "Role", de: "Rolle", fr: "Rôle" }, "de_CH"), { de: "Rolle", en: "Role" });
  assert.deepEqual(localize({ en: "Role" }, "de_DE"), { en: "Role" });
  assert.deepEqual(localize("Role", null), { en: "Role" });
  assert.equal(messageText({ en: "Wrong", de: "Falsch" }, "de"), "Falsch");
});

test("setup field helpers follow the Integration-API setting schema", () => {
  assert.deepEqual(checkbox("x", "X", true).field, { checkbox: { value: true } });
  assert.deepEqual(number("n", "N", 600, { min: 300, max: 86400, unit: "s" }).field.number, { value: 600, min: 300, max: 86400, decimals: 0, unit: { en: "s" } });
  assert.deepEqual(password("p", "P").field, { password: { value: "" } });
  assert.equal(bool("true"), true);
  assert.equal(bool("false", true), false);
  assert.equal(bool("yes"), true);
  assert.equal(bool(undefined, true), true);
});

test("select entities expose options and handle select_option", async () => {
  const selected = [];
  const entity = new Select("action", { en: "Action" }, { options: ["Sync", "Preview"], cmdHandler: async (_entity, cmd, params) => { selected.push([cmd, params.option]); return 200; } });
  assert.equal(entity.entity_type, "select");
  assert.deepEqual(entity.attributes, { state: "ON", options: ["Sync", "Preview"], current_option: "" });
  assert.equal(await entity.command("select_option", { option: "Preview" }), 200);
  assert.deepEqual(selected, [["select_option", "Preview"]]);
});

// -----------------------------------------------------------------------------
// Satellite provisioning
// -----------------------------------------------------------------------------

function fakeProvisioningCore({ driver = null, setupPages = [] } = {}) {
  const state = { driver, installs: [], setupPayloads: [], wake: false, setupStarted: null, pages: [...setupPages] };
  const nextSetup = () => state.pages.length ? state.pages.shift() : { state: "OK" };
  return {
    state,
    version: async () => ({ device_name: "Bedroom", api: "0.19.0" }),
    integrationDriver: async () => state.driver,
    installCustomIntegration: async (archive, options) => { state.installs.push({ size: archive.length, ...options }); state.driver = { driver_id: "remote_sync", version: APP_VERSION }; return state.driver; },
    integrationSetup: async () => (state.setupStarted ? state.current : null),
    abortIntegrationSetup: async () => null,
    startIntegrationSetup: async (options) => { state.setupStarted = options; state.current = nextSetup(); return state.current; },
    integrationSetupUserData: async (_driver, payload) => { state.setupPayloads.push(payload); state.current = nextSetup(); return state.current; },
    keepIntegrationSetupAlive: async () => null,
    wakeOnWlan: async () => state.wake,
    setWakeOnWlan: async (value) => { state.wake = value; },
    close: async () => {}
  };
}

test("installOrUpdateDriver installs a missing driver, updates an old one and skips a current one", async () => {
  const packageBuilder = () => Buffer.from("archive");
  const missing = fakeProvisioningCore();
  assert.equal((await installOrUpdateDriver(missing, { packageBuilder, waitMs: 5000, pollMs: 1 })).action, "installed");
  assert.equal(missing.state.installs[0].update, false);

  const old = fakeProvisioningCore({ driver: { driver_id: "remote_sync", version: "0.8.0" } });
  const updated = await installOrUpdateDriver(old, { packageBuilder, waitMs: 5000, pollMs: 1 });
  assert.equal(updated.action, "updated");
  assert.equal(old.state.installs[0].update, true);

  const current = fakeProvisioningCore({ driver: { driver_id: "remote_sync", version: APP_VERSION } });
  assert.equal((await installOrUpdateDriver(current, { packageBuilder })).action, "current");
  assert.equal(current.state.installs.length, 0);

  await assert.rejects(installOrUpdateDriver(fakeProvisioningCore(), { allowInstall: false }), /not installed/);
});

test("remote driver setup answers the Satellite pages through the Core setup API", async () => {
  const core = fakeProvisioningCore({
    setupPages: [
      { state: "WAIT_USER_ACTION", require_user_action: { input: { title: { en: "Set up satellite remote" }, settings: [
        { id: "detected_network", label: { en: "Network" }, field: { label: { value: { en: "wlan0" } } } },
        { id: "pin", label: { en: "PIN" }, field: { password: { value: "" } } },
        { id: "enable_wake_on_wlan", label: { en: "WoWLAN" }, field: { checkbox: { value: false } } },
        { id: "remote_http_port", label: { en: "Port" }, field: { text: { value: "" } } }
      ] } } },
      { state: "WAIT_USER_ACTION", require_user_action: { confirmation: { title: { en: "Satellite is ready to pair" } } } },
      { state: "OK" }
    ]
  });
  await runRemoteDriverSetup(core, { setupData: { role: "satellite" }, answers: { pin: "4321", enable_wake_on_wlan: "true" }, pollMs: 1 });
  assert.deepEqual(core.state.setupStarted.setupData, { role: "satellite" });
  assert.deepEqual(core.state.setupPayloads, [
    { input_values: { pin: "4321", enable_wake_on_wlan: "true", remote_http_port: "" } },
    { confirm: true }
  ]);
});

test("remote driver setup stops when the Satellite rejects the same page again", async () => {
  const page = { state: "WAIT_USER_ACTION", require_user_action: { input: { title: { en: "Set up" }, settings: [{ id: "pin", label: { en: "PIN" }, field: { password: { value: "" } } }] } } };
  const core = fakeProvisioningCore({ setupPages: [page, { ...page, error: "INVALID_INPUT", error_message: { en: "Wrong PIN" } }] });
  await assert.rejects(runRemoteDriverSetup(core, { answers: { pin: "0" }, pollMs: 1 }), /Wrong PIN/);
});

test("provisioning by PIN installs, configures, pairs and enables Wake on WLAN", async () => {
  const core = fakeProvisioningCore({ setupPages: [{ state: "OK" }] });
  let agentRole = null;
  const pinPairs = [];
  const result = await provisionSatelliteByPin({
    address: "10.1.1.102",
    pin: "4321",
    primaryName: "Living Room",
    provisionApiKey: async (host, pin, options) => { assert.equal(host, "10.1.1.102"); assert.equal(pin, "4321"); assert.match(options.name, /Living Room/); return { apiKey: "management-key-123456", active: true }; },
    coreClientFactory: (endpoint) => { assert.equal(endpoint.api_key, "management-key-123456"); return core; },
    peerClientFactory: (url) => ({
      publicCapabilities: async () => {
        assert.equal(url, "http://10.1.1.102:11081");
        if (!core.state.driver) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        if (core.state.setupStarted && !agentRole) agentRole = "unassigned";
        return { service: "remote-sync", role: agentRole };
      },
      pinPair: async (key) => { pinPairs.push(key); agentRole = "child"; return { agent_token: "satellite-token-abcdefghijklmnop", node_name: "Bedroom", assigned: true }; }
    }),
    packageBuilder: () => Buffer.from("archive"),
    pollMs: 1,
    onProgress: () => {}
  });
  assert.equal(result.installation.action, "installed");
  // The Satellite's integration setup only needs the PIN; PIN pairing then makes it a Satellite.
  assert.deepEqual(core.state.setupStarted.setupData, { pin: "4321" });
  assert.deepEqual(pinPairs, ["management-key-123456"]);
  assert.equal(result.token, "satellite-token-abcdefghijklmnop");
  assert.equal(result.coreApiKey, "management-key-123456");
  assert.equal(core.state.wake, true);
  assert.equal(result.agentUrl, "http://10.1.1.102:11081");
});

test("provisioning reports a rejected Satellite PIN clearly", async () => {
  await assert.rejects(provisionSatelliteByPin({
    address: "10.1.1.102",
    pin: "0000",
    provisionApiKey: async () => { throw new CoreApiError(401, "POST", "/auth/api_keys", {}); }
  }), /rejected the PIN/);
});

// -----------------------------------------------------------------------------
// Agent PIN pairing endpoint
// -----------------------------------------------------------------------------

test("Satellite agent returns its pairing token only for a key its own Core accepts, with rate limiting", async () => {
  const port = await freePort();
  const previous = process.env.UC_MDNS_ADDRESS;
  process.env.UC_MDNS_ADDRESS = "127.0.0.1";
  const config = {
    role: "child", node_id: "child-node", node_name: "Bedroom", pairing_identifier: "RMS-ABCD-EFGH",
    pairing: { ready_to_pair: true }, agent_token: "satellite-agent-token-abcdefghijklmnopqrstuvwxyz", agent_port: port, remote: {}
  };
  const server = new AgentServer(config, {
    statusCallback: () => ({}),
    pinPairingCallback: async (key) => key === "valid-core-key-123"
  });
  server.publisher = null;
  await server.start();
  server.publisher?.close(); server.publisher = null;
  const pair = (key) => fetch(`http://127.0.0.1:${port}/v1/pairing/pin`, { method: "POST", headers: { "Content-Type": "application/json", "X-Remote-Sync-Core-Key": key }, body: "{}" });
  try {
    const ok = await pair("valid-core-key-123");
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).agent_token, config.agent_token);
    for (let index = 0; index < 5; index += 1) assert.equal((await pair("wrong-core-key-000")).status, 401);
    assert.equal((await pair("valid-core-key-123")).status, 429);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { Authorization: "Bearer satellite-agent-token-abcdefghijklmnopqrstuvwxyZ" } });
    assert.equal(unauthorized.status, 401);
  } finally {
    await server.stop();
    if (previous === undefined) delete process.env.UC_MDNS_ADDRESS; else process.env.UC_MDNS_ADDRESS = previous;
  }
});

// -----------------------------------------------------------------------------
// Web dashboard
// -----------------------------------------------------------------------------

async function uiServer(service) {
  const handler = createUiHandler(service);
  const server = http.createServer((request, response) => handler(request, response, new URL(request.url, "http://localhost")));
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("dashboard requires the Web Configurator PIN, a session cookie and the request header", async () => {
  const service = {
    config: { role: "child", node_name: "Bedroom" },
    status: {},
    verifyUiPin: async (pin) => pin === "1234",
    statusPayload: () => ({ status: { state: "connected" } }),
    wakeOnWlanState: async () => true,
    provisioningStatus: () => []
  };
  const ui = await uiServer(service);
  const post = (path, body, headers = {}) => fetch(ui.base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const page = await fetch(`${ui.base}/ui`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal((await post("/ui/api/login", { pin: "1234" })).status, 403);
    assert.equal((await post("/ui/api/login", { pin: "0000" }, { "X-Remote-Sync-UI": "1" })).status, 401);
    assert.equal((await fetch(`${ui.base}/ui/api/status`)).status, 401);
    const login = await post("/ui/api/login", { pin: "1234" }, { "X-Remote-Sync-UI": "1" });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const status = await fetch(`${ui.base}/ui/api/status`, { headers: { Cookie: cookie.split(";")[0] } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).wake_on_wlan, true);
    const satellites = await fetch(`${ui.base}/ui/api/satellites`, { headers: { Cookie: cookie.split(";")[0] } });
    assert.equal(satellites.status, 409, "a Satellite dashboard is read-only");
  } finally { await ui.close(); }
});

test("dashboard serves only the allow-listed Remote UI preview assets", async () => {
  const ui = await uiServer({ config: { role: "master" }, status: {} });
  try {
    const script = await fetch(`${ui.base}/ui/remote-ui/remote-ui-web.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);
    assert.match(await script.text(), /window\.RemoteUIWeb/);
    assert.equal((await fetch(`${ui.base}/ui/remote-ui/background.svg`)).status, 200);
    assert.equal((await fetch(`${ui.base}/ui/remote-ui/package.json`)).status, 404);
    assert.equal((await fetch(`${ui.base}/ui/remote-ui/..%2Fserver.js`)).status, 404);
    assert.equal(script.headers.get("cache-control"), "no-cache", "unversioned runtime URLs are revalidated");
    const page = await fetch(`${ui.base}/ui`);
    assert.match(page.headers.get("content-security-policy"), /font-src 'self' https:\/\/fonts\.gstatic\.com/);
    const versioned = (await page.text()).match(/\/ui\/remote-ui\/remote-ui-web\.js\?v=([0-9a-f]{12})/);
    assert.ok(versioned, "the page references the runtime with a content-hash version");
    const cached = await fetch(`${ui.base}${versioned[0]}`);
    assert.match(cached.headers.get("cache-control"), /immutable/);
  } finally { await ui.close(); }
});

test("dashboard login is rate limited after repeated wrong PINs", async () => {
  const ui = await uiServer({ config: { role: "master" }, status: {}, verifyUiPin: async () => false });
  try {
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${ui.base}/ui/api/login`, { method: "POST", headers: { "X-Remote-Sync-UI": "1" }, body: JSON.stringify({ pin: "0" }) });
      assert.equal(response.status, 401);
    }
    const limited = await fetch(`${ui.base}/ui/api/login`, { method: "POST", headers: { "X-Remote-Sync-UI": "1" }, body: JSON.stringify({ pin: "0" }) });
    assert.equal(limited.status, 429);
  } finally { await ui.close(); }
});

// -----------------------------------------------------------------------------
// Satellite updates, packaging, previews and helpers
// -----------------------------------------------------------------------------

test("managed Satellites on an older version are updated once per Primary version", async () => {
  const previous = process.env.STATE_DIRECTORY;
  process.env.STATE_DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), "rs-test-"));
  try {
    const config = {
      role: "master",
      sync: { auto_update_satellites: true },
      peers: [
        { peer_id: "rms-a", name: "A", enabled: true, core_api_key: "key-a-123456", url: "http://10.0.0.2:11081" },
        { peer_id: "rms-b", name: "B", enabled: true, core_api_key: null, url: "http://10.0.0.3:11081" }
      ]
    };
    const updates = [];
    const manager = new SatelliteManager({
      getConfig: () => config,
      store: { save: (value) => value },
      resolvePeer: async (peer) => ({ url: peer.url }),
      syncPeer: async () => ({ success: true }),
      notify: () => {},
      updater: async (peer) => { updates.push(peer.peer_id); throw new Error("offline"); }
    });
    manager.record("rms-a", { version: "0.8.0" });
    manager.record("rms-b", { version: "0.8.0" });
    await manager.autoUpdate();
    await manager.autoUpdate();
    assert.deepEqual(updates, ["rms-a"]);
    assert.match(manager.list()[0].last_update_result, /offline/);
    assert.equal(manager.list()[0].managed, true);
    assert.equal(manager.list()[1].managed, false);
  } finally {
    if (previous === undefined) delete process.env.STATE_DIRECTORY; else process.env.STATE_DIRECTORY = previous;
  }
});

function tarNames(archive) {
  const tar = gunzipSync(archive);
  const names = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

test("the runtime installation archive matches the custom-integration layout", () => {
  const names = tarNames(buildDriverArchive());
  for (const required of ["driver.json", "remote-sync.png", "bin/", "bin/driver.js", "bin/package.json", "bin/web/page.js", "bin/web/remote-ui/remote-ui-web.js", "bin/web/remote-ui/remote-ui-web.css", "bin/web/remote-icons.js", "config/", "data/"]) {
    assert.ok(names.includes(required), `${required} is missing`);
  }
  assert.ok(!names.some((name) => name.startsWith("tests/")));
});

test("previews name the objects that would be created or removed", () => {
  const manifest = {
    operation_id: "op", source_node_id: "primary", source_name: "Primary", sections: ["activities"],
    data: { activities: [{ source_id: "uc.main.activity.1", detail: { name: { en: "Watch TV" } } }, { source_id: "uc.main.activity.2", name: "Music" }] }
  };
  const mappings = { get: (_node, _kind, id) => (id === "uc.main.activity.2" ? "target" : null), items: () => ({ "uc.main.activity.9": "old" }) };
  const preview = buildApplyPreview(manifest, { sync: { prune: true } }, mappings);
  assert.deepEqual(preview.sections.activities.items, { create: ["Watch TV"], update: ["Music"], remove: ["uc.main.activity.9"] });
});

test("version helpers and the single version source", () => {
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(versionAtLeast("0.19.1", "0.19.0"), true);
  assert.equal(versionAtLeast(null, "0.19.0"), false);
  assert.equal(safeEqual("secret", "secret"), true);
  assert.equal(safeEqual("secret", "secreT"), false);
  assert.equal(safeEqual("", ""), false);
  const metadata = JSON.parse(fs.readFileSync(new URL("../driver.json", import.meta.url), "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(APP_VERSION, metadata.version);
  assert.equal(packageJson.version, metadata.version);
  assert.deepEqual(metadata.setup_data_schema.settings.map((item) => item.id), ["info", "pin"]);
  assert.ok(metadata.setup_data_schema.settings[1].field.password);
});

test("expected probe failures are logged at debug level, unexpected ones as warnings", async () => {
  const fetchImpl = async (url) => new URL(url).pathname.endsWith("/ir")
    ? jsonResponse(404, { code: "NOT_FOUND" })
    : jsonResponse(400, { code: "BAD_REQUEST" });
  const client = new CoreClient({ host: "remote", api_key: "abcdefghijklmnop" }, { fetchImpl });
  const before = recentLogs().at(-1)?.seq || 0;
  assert.equal(await client.getJson("/remotes/r1/ir", { optionalStatuses: [400, 404, 405] }), null);
  await assert.rejects(client.getJson("/remotes/r1/other", { optionalStatuses: [404] }));
  const lines = recentLogs({ after: before }).filter((line) => line.namespace === "remote-sync:core-client");
  assert.ok(!lines.some((line) => line.level === "warn" && /\/ir/.test(line.message)), "the expected 404 must not be a warning");
  assert.ok(lines.some((line) => line.level === "warn" && /\/other/.test(line.message)));
});

test("the change hash ignores live state so only configuration changes trigger automatic pushes", () => {
  const configuration = (state, brightness, name = "Kitchen") => ({
    integrations: [{ integration_id: "hue.main", name: "Hue", state: state ? "CONNECTED" : "RECONNECTING", device_state: "CONNECTED" }],
    entities: [{ entity_id: "hue.light.kitchen", name: { en: name }, features: ["dim"], attributes: { state: state ? "ON" : "OFF", brightness } }],
    activities: [{ source_id: "a1", detail: { name: { en: "TV" }, attributes: { state: "OFF" }, options: { included_entities: ["hue.light.kitchen"] } } }]
  });
  const hash = (value) => JSON.stringify(stableConfiguration(value));
  assert.equal(hash(configuration(true, 10)), hash(configuration(false, 200)));
  assert.notEqual(hash(configuration(true, 10)), hash(configuration(true, 10, "Kitchen ceiling")));
});
