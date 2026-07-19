import test from "node:test";
import assert from "node:assert/strict";
import * as uc from "../src/integration/api.js";
import { SetupFlow } from "../src/setup/index.js";
import { parseRemoteAddress } from "../src/setup/common.js";

class MemoryStore {
  constructor(value = null) { this.value = value; }
  load() { return this.value; }
  save(value) { this.value = value; }
}

class FakeDiscovery {
  async discoverReady() {
    return [
      { identifier: "RMS-ABCD-EFGH", name: "Bedroom", address: "10.1.1.102", hostname: "remote-sync-abcdefgh.local", port: 11081, url: "http://10.1.1.102:11081", ready: true },
      { identifier: "RMS-WXYZ-2345", name: "Office", address: "10.1.1.103", hostname: "remote-sync-wxyz2345.local", port: 11081, url: "http://10.1.1.103:11081", ready: true }
    ];
  }
}

test("satellite setup shows detected network and advanced overrides after role selection", async () => {
  const flow = new SetupFlow(new MemoryStore(), async () => {}, { discovery: new FakeDiscovery() });
  const roleForm = await flow.handler(new uc.DriverSetupRequest(false));
  assert.deepEqual(roleForm.settings.map((item) => item.id), ["role"]);
  const childForm = await flow.handler(new uc.UserDataResponse({ role: "child" }));
  assert.deepEqual(childForm.settings.map((item) => item.id), ["detected_network", "remote_http_port", "pin", "network_mac_override", "network_broadcast_overrides"]);
});

test("primary setup starts with the dedicated details step", async () => {
  const flow = new SetupFlow(new MemoryStore(), async () => {}, { discovery: new FakeDiscovery() });
  await flow.handler(new uc.DriverSetupRequest(false));
  const primaryForm = await flow.handler(new uc.UserDataResponse({ role: "master" }));
  assert.equal(primaryForm.title?.en || primaryForm.title, "Step 1 of 3 — Define primary details");
  const ids = primaryForm.settings.map((item) => item.id);
  assert.deepEqual(ids, [
    "node_name",
    "remote_address",
    "remote_http_port",
    "pin",
    "agent_public_url",
    "physical_dock_tokens",
    "network_mac_override",
    "network_broadcast_overrides"
  ]);
});


test("remote setup port overrides an embedded or default HTTP port", () => {
  assert.deepEqual(parseRemoteAddress("10.1.1.170", "8080"), { scheme: "http", host: "10.1.1.170", port: 8080 });
  assert.deepEqual(parseRemoteAddress("https://10.1.1.170:8443", ""), { scheme: "https", host: "10.1.1.170", port: 8443 });
});

test("remote setup rejects invalid HTTP ports", () => {
  assert.throws(() => parseRemoteAddress("10.1.1.170", "70000"), /between 1 and 65535/);
  assert.throws(() => parseRemoteAddress("10.1.1.170", "abc"), /between 1 and 65535/);
});
