import test from "node:test";
import assert from "node:assert/strict";
import {
  hasManualSatelliteInput,
  inspectManualSatellite,
  parseSatelliteAgentAddress
} from "../src/setup/manual-satellite.js";

class MemoryStore {
  constructor(value = null) { this.value = value; }
  load() { return this.value; }
  save(value) { this.value = value; return value; }
}

test("manual Satellite agent addresses use an embedded, explicit or default port", () => {
  assert.deepEqual(parseSatelliteAgentAddress("10.1.1.102"), {
    scheme: "http",
    host: "10.1.1.102",
    port: 11081,
    url: "http://10.1.1.102:11081"
  });
  assert.equal(parseSatelliteAgentAddress("http://satellite.local:12000").url, "http://satellite.local:12000");
  assert.equal(parseSatelliteAgentAddress("satellite.local", "13000").url, "http://satellite.local:13000");
  assert.throws(() => parseSatelliteAgentAddress("satellite.local", "70000"), /between 1 and 65535/);
});

test("manual Satellite input detection ignores an entirely empty fallback form", () => {
  assert.equal(hasManualSatelliteInput({}), false);
  assert.equal(hasManualSatelliteInput({ manual_satellite_address: "10.1.1.102" }), true);
  assert.equal(hasManualSatelliteInput({ manual_satellite_token: "pairing-token" }), true);
});

test("manual Satellite inspection retrieves identity and network details from the agent", async () => {
  const calls = [];
  const token = "abcdefghijklmnopqrstuvwxyz0123456789";
  const satellite = await inspectManualSatellite({
    address: "10.1.1.102",
    port: "12000",
    token,
    name: "Bedroom",
    masterId: "primary-node",
    masterName: "Primary",
    requiredCapabilities: ["proxy_entities", "dock_tunnel"],
    clientFactory: (baseUrl, pairingToken) => {
      assert.equal(baseUrl, "http://10.1.1.102:12000");
      assert.equal(pairingToken, token);
      return {
        async capabilities(options) {
          calls.push(["capabilities", options]);
          return {
            service: "remote-sync",
            version: "0.7.4",
            api_version: 1,
            protocol_version: 2,
            snapshot_schema: 6,
            capabilities: ["proxy_entities", "dock_tunnel"]
          };
        },
        async validatePairing(payload) {
          calls.push(["validate", payload]);
          return {
            role: "child",
            identifier: "RMS-ABCD-EFGH",
            node_id: "satellite-node",
            node_name: "Remote 3",
            ready_to_pair: true,
            mac: "34:90:ea:c9:2a:8c",
            broadcasts: ["10.1.1.255"],
            network_interface: "wlan0",
            network_source: "automatic"
          };
        }
      };
    },
    detectNetwork: async () => ({
      mac: null,
      broadcasts: [],
      interface: null,
      source: "unavailable"
    })
  });

  assert.equal(satellite.identifier, "RMS-ABCD-EFGH");
  assert.equal(satellite.name, "Bedroom");
  assert.equal(satellite.url, "http://10.1.1.102:12000");
  assert.equal(satellite.manualToken, token);
  assert.equal(satellite.mac, "34:90:ea:c9:2a:8c");
  assert.deepEqual(satellite.broadcasts, ["10.1.1.255"]);
  assert.equal(satellite.discovery, "manual");
  assert.deepEqual(calls[0], ["capabilities", { requiredCapabilities: ["proxy_entities", "dock_tunnel"] }]);
  assert.deepEqual(calls[1], ["validate", { master_id: "primary-node", master_name: "Primary" }]);
});

test("manual Satellite inspection rejects a Satellite paired to another Primary", async () => {
  await assert.rejects(() => inspectManualSatellite({
    address: "10.1.1.102",
    token: "abcdefghijklmnopqrstuvwxyz0123456789",
    masterId: "primary-node",
    masterName: "Primary",
    clientFactory: () => ({
      capabilities: async () => ({
        service: "remote-sync",
        version: "0.7.4",
        api_version: 1,
        protocol_version: 2,
        snapshot_schema: 6,
        capabilities: ["proxy_entities"]
      }),
      validatePairing: async () => ({
        role: "child",
        identifier: "RMS-ABCD-EFGH",
        ready_to_pair: false,
        paired_master_id: "different-primary"
      })
    }),
    detectNetwork: async () => ({ mac: null, broadcasts: [], interface: null, source: "unavailable" })
  }), /already paired with a different Primary/);
});
