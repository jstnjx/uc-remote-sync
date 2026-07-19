import test from "node:test";
import assert from "node:assert/strict";
import { PrimarySetup } from "../src/setup/primary.js";
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

test("Primary setup can add a manual Satellite and continue configuring", async () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123456789";
  const setup = new PrimarySetup(new MemoryStore(), async () => {}, null, {
    discovery: { discoverReady: async () => [] },
    manualSatelliteInspector: async (options) => ({
      identifier: "RMS-ABCD-EFGH",
      name: options.name || "Bedroom",
      address: "10.1.1.102",
      hostname: null,
      port: 11081,
      url: "http://10.1.1.102:11081",
      version: "0.7.4",
      node_id: "satellite-node",
      ready: true,
      mac: "34:90:ea:c9:2a:8c",
      broadcasts: ["10.1.1.255"],
      interface: "wlan0",
      network_source: "automatic",
      protocol: {
        version: "0.7.4",
        protocol_version: 2,
        snapshot_schema: 6,
        capabilities: ["proxy_entities"]
      },
      discovery: "manual",
      existing: null,
      manual: true,
      manualToken: options.token
    })
  });

  setup.step = 4;
  setup.draft.details = { node_name: "Primary" };
  setup.draft.settings = { section_docks: "no" };
  setup.draft.prepared = {
    address: { host: "10.1.1.170" },
    version: { address: "primary-node", device_name: "Primary" }
  };

  const form = await setup.handleData({
    manual_satellite_address: "10.1.1.102",
    manual_satellite_agent_port: "11081",
    manual_satellite_token: token,
    manual_satellite_name: "Bedroom",
    satellite_setup_action: "add_manual"
  });

  const fields = new Map(form.settings.map((item) => [item.id, item]));
  assert.ok(fields.has("satellite_info_abcdefgh"));
  assert.equal(fields.get("satellite_token_abcdefgh").field.text.value, token);
  assert.equal(fields.get("manual_satellite_address").field.text.value, "");
  assert.equal(fields.get("satellite_setup_action").field.dropdown.value, "complete");
  assert.match(fields.get("manual_satellite_notice").field.label.value.en, /Bedroom/);
});

test("manual Satellite URL is saved as the runtime fallback after pairing", async () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123456789";
  const store = new MemoryStore();
  const setup = new PrimarySetup(store, async () => {}, null, {
    discovery: { discoverReady: async () => [] },
    manualSatelliteInspector: async (options) => ({
      identifier: "RMS-WXYZ-2345",
      name: "Office",
      address: "10.1.1.103",
      hostname: null,
      port: 12000,
      url: "http://10.1.1.103:12000",
      version: "0.7.4",
      node_id: "office-node",
      ready: true,
      mac: "34:90:ea:c9:2a:8d",
      broadcasts: ["10.1.1.255"],
      interface: "wlan0",
      network_source: "automatic",
      protocol: {
        version: "0.7.4",
        protocol_version: 2,
        snapshot_schema: 6,
        capabilities: ["proxy_entities"]
      },
      discovery: "manual",
      existing: null,
      manual: true,
      manualToken: options.token
    }),
    peerClientFactory: (baseUrl, pairingToken) => {
      assert.equal(baseUrl, "http://10.1.1.103:12000");
      assert.equal(pairingToken, token);
      return {
        capabilities: async () => ({
          version: "0.7.4",
          protocol_version: 2,
          snapshot_schema: 6,
          capabilities: ["proxy_entities"]
        }),
        validatePairing: async () => ({
          node_id: "office-node",
          identifier: "RMS-WXYZ-2345",
          mac: "34:90:ea:c9:2a:8d",
          broadcasts: ["10.1.1.255"]
        }),
        claim: async () => ({
          node_id: "office-node",
          paired_at: "2026-07-19T19:00:00.000Z",
          mac: "34:90:ea:c9:2a:8d",
          broadcasts: ["10.1.1.255"]
        })
      };
    }
  });

  setup.step = 4;
  setup.draft.details = { node_name: "Primary", agent_public_url: "http://10.1.1.50:11081" };
  setup.draft.settings = {
    keep_wifi_confirmed: "yes",
    sync_interval: "300",
    auto_sync: "yes",
    prune: "no",
    standby_inhibitor: "yes",
    verify_resource_hashes: "no",
    section_resources: "no",
    section_entities: "yes",
    section_activities: "no",
    section_activity_groups: "no",
    section_macros: "no",
    section_remotes: "no",
    section_profiles: "no",
    section_docks: "no"
  };
  setup.draft.prepared = {
    address: { scheme: "http", host: "10.1.1.170", port: 80 },
    version: { address: "primary-node", device_name: "Primary" },
    remote: {
      host: "10.1.1.170",
      api_key: "abcdefghijklmnopqrstuvwxyz0123456789",
      scheme: "http",
      port: 80,
      mac: "34:90:ea:c9:2a:80",
      broadcasts: ["10.1.1.255"],
      interface: "eth0",
      network_source: "automatic",
      verify_tls: false
    },
    overrides: { mac: null, broadcasts: [] },
    docks: { default_token: "", tokens: {} }
  };

  const result = await setup.handleData({
    manual_satellite_address: "10.1.1.103",
    manual_satellite_agent_port: "12000",
    manual_satellite_token: token,
    manual_satellite_name: "Office",
    satellite_setup_action: "complete"
  });

  assert.equal(result.constructor.name, "SetupComplete");
  assert.equal(store.value.peers.length, 1);
  assert.equal(store.value.peers[0].identifier, "RMS-WXYZ-2345");
  assert.equal(store.value.peers[0].url, "http://10.1.1.103:12000");
  assert.equal(store.value.peers[0].token, token);
});
