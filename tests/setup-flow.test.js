import test from "node:test";
import assert from "node:assert/strict";
import * as uc from "../src/integration/api.js";
import { CoreApiError } from "../src/core/client.js";
import { SetupFlow } from "../src/setup/index.js";
import { parseRemoteAddress } from "../src/setup/common.js";

class MemoryStore {
  constructor(value = null) { this.value = value; }
  load() { return this.value; }
  save(value) { this.value = value; return value; }
}

function fakeCore(calls, { wake = false } = {}) {
  return (endpoint) => ({
    version: async () => ({ device_name: "Living Room", address: "aa:bb:cc:dd:ee:01" }),
    integrations: async () => [],
    wakeOnWlan: async () => wake,
    setWakeOnWlan: async (value) => { calls.push(["wake", value, endpoint.host]); },
    close: async () => {}
  });
}

const network = async () => ({ mac: "aa:bb:cc:dd:ee:01", broadcasts: ["10.1.1.255"], interface: "wlan0", source: "test" });

function flow(store, calls, options = {}) {
  return new SetupFlow(store, async (config) => calls.push(["configured", config.role]), {
    coreClientFactory: fakeCore(calls, options),
    provisionApiKey: options.provisionApiKey || (async (host, pin) => {
      calls.push(["key", host, pin]);
      if (pin !== "1234") throw new CoreApiError(401, "POST", "/auth/api_keys", {});
      return { apiKey: "api-key-abcdefghijklmnop", active: true };
    }),
    detectNetwork: network,
    remoteHint: options.remoteHint
  });
}

test("driver.json collects the PIN, so a correct PIN completes setup on the first page", async () => {
  const store = new MemoryStore();
  const calls = [];
  const page = await flow(store, calls).handler(new uc.DriverSetupRequest(false, { pin: "1234" }));
  assert.equal(page.constructor.name, "RequestUserConfirmation");
  assert.match(page.title.en, /dashboard/i);
  assert.match(page.header.en, /:11081\/ui/);
  assert.equal(store.value.role, "unassigned");
  assert.equal(store.value.remote.host, "127.0.0.1");
  assert.equal(store.value.remote.api_key, "api-key-abcdefghijklmnop");
  assert.equal(store.value.node_name, "Living Room");
  assert.ok(!store.value.sync.sections.includes("docks"));
  assert.deepEqual(calls.filter((call) => call[0] === "wake"), [["wake", true, "127.0.0.1"]]);
  assert.deepEqual(calls.at(-1), ["configured", "unassigned"]);
});

test("the setup page contains only the PIN and a wrong PIN is corrected in place", async () => {
  const store = new MemoryStore();
  const calls = [];
  const setup = flow(store, calls);
  const form = await setup.handler(new uc.DriverSetupRequest(false, {}));
  assert.deepEqual(form.settings.map((item) => item.id), ["pin"]);
  assert.ok(form.settings[0].field.password);
  const retry = await setup.handler(new uc.UserDataResponse({ pin: "0000" }));
  assert.deepEqual(retry.settings.map((item) => item.id), ["pin"]);
  assert.match(retry.errorMessage.en, /rejected/);
  const done = await setup.handler(new uc.UserDataResponse({ pin: "1234" }));
  assert.equal(done.constructor.name, "RequestUserConfirmation");
  assert.equal((await setup.handler(new uc.UserConfirmationResponse(true))).constructor.name, "SetupComplete");
});

test("an external instance uses the address of the Remote running the setup", async () => {
  const store = new MemoryStore();
  const calls = [];
  await flow(store, calls, { remoteHint: () => "::ffff:10.1.1.170" }).handler(new uc.DriverSetupRequest(false, { pin: "1234" }));
  assert.equal(store.value.remote.host, "10.1.1.170");
  assert.deepEqual(calls[0], ["key", "10.1.1.170", "1234"]);
});

test("reconfiguring renews the API key and keeps the role, peers and settings", async () => {
  const existing = {
    schema_version: 6, role: "master", node_id: "primary", node_name: "Living Room",
    remote: { host: "10.1.1.170", port: 8080, scheme: "http", api_key: "old-key-abcdefgh" },
    agent_token: "a".repeat(40), agent_port: 11081, peers: [],
    sync: { sections: ["entities"], interval_seconds: 1800, auto_sync: false }
  };
  const store = new MemoryStore(existing);
  const calls = [];
  const setup = flow(store, calls);
  const form = await setup.handler(new uc.DriverSetupRequest(true, {}));
  assert.deepEqual(form.settings.map((item) => item.id), ["reconfigure_info", "pin"]);
  const done = await setup.handler(new uc.UserDataResponse({ pin: "1234" }));
  assert.match(done.header.en, /renewed/);
  assert.equal(store.value.role, "master");
  assert.equal(store.value.remote.host, "10.1.1.170");
  assert.equal(store.value.remote.port, 8080);
  assert.equal(store.value.remote.api_key, "api-key-abcdefghijklmnop");
  assert.equal(store.value.sync.interval_seconds, 1800);
  assert.deepEqual(calls[0], ["key", "10.1.1.170", "1234"]);
});

test("an unapproved API key asks for approval before finishing", async () => {
  const store = new MemoryStore();
  const calls = [];
  const setup = flow(store, calls, { provisionApiKey: async () => ({ apiKey: "api-key-abcdefghijklmnop", active: false }) });
  const approval = await setup.handler(new uc.DriverSetupRequest(false, { pin: "1234" }));
  assert.match(approval.title.en, /Approve/);
  assert.equal(store.value, null);
  const done = await setup.handler(new uc.UserConfirmationResponse(true));
  assert.equal(done.constructor.name, "RequestUserConfirmation");
  assert.equal(store.value.role, "unassigned");
});

test("remote setup port overrides an embedded or default HTTP port", () => {
  assert.deepEqual(parseRemoteAddress("10.1.1.170", "8080"), { scheme: "http", host: "10.1.1.170", port: 8080 });
  assert.deepEqual(parseRemoteAddress("https://10.1.1.170:8443", ""), { scheme: "https", host: "10.1.1.170", port: 8443 });
});

test("remote setup rejects invalid HTTP ports", () => {
  assert.throws(() => parseRemoteAddress("10.1.1.170", "70000"), /between 1 and 65535/);
  assert.throws(() => parseRemoteAddress("10.1.1.170", "abc"), /between 1 and 65535/);
});
