import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RemoteSyncService } from "../src/service/index.js";
import { createStatus } from "../src/shared/models.js";

class FakeCoreClient {
  async version() { return { api: "0.17.6", device_name: "Master" }; }
  async integrations() { return [{ integration_id: "hass.main", state: "CONNECTED" }]; }
  async listPaginated(path) {
    if (path === "/entities") return [{ entity_id: "hass.main.light.test", integration_id: "hass.main", name: { en: "Test" } }];
    return [];
  }
  async getJson(path) {
    if (path.startsWith("/entities/")) return { entity_id: "hass.main.light.test", integration_id: "hass.main", name: { en: "Test" } };
    return null;
  }
}

const config = {
  role: "master",
  node_id: "master",
  node_name: "Master",
  peers: [{ peer_id: "rms-test", identifier: "RMS-TEST-TEST", name: "Child", token: "x".repeat(32), enabled: true, url: null, mac: null, broadcasts: [] }],
  sync: { sections: ["entities"], auto_sync: true, interval_seconds: 300, prune: false, use_standby_inhibitor: false, verify_existing_resource_hashes: false }
};

function capabilitiesResponse() {
  return new Response(JSON.stringify({
    service: "remote-sync",
    version: "0.7.0",
    api_version: 1,
    protocol_version: 2,
    snapshot_schema: 6,
    capabilities: ["proxy_entities", "activity_state", "dock_tunnel", "automatic_network_identity", "satellite_management", "credential_rotation", "sync_preview"]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}


test("failed child delivery is retried even when the snapshot hash is unchanged", async () => {
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  service.config = structuredClone(config);
  service.client = new FakeCoreClient();
  service.status = createStatus("connected");
  service.discovery.resolve = async () => ({ url: "http://child.test:11081", hostname: "child.test" });

  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/capabilities")) return capabilitiesResponse();
      requests += 1;
      return new Response(JSON.stringify({ success: false, errors: ["simulated apply failure"] }), { status: 422, headers: { "Content-Type": "application/json" } });
    };
    const failed = await service.syncNow(true);
    assert.equal(failed.success, false);
    assert.equal(service.status.last_snapshot_hash, null);
    assert.equal(service.status.pending_changes, true);
    assert.match(service.status.last_sync_result, /simulated apply failure/);

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/capabilities")) return capabilitiesResponse();
      requests += 1;
      return new Response(JSON.stringify({ success: true, errors: [], warnings: [], counts: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const retried = await service.syncNow(false);
    assert.equal(retried.success, true);
    assert.equal(requests, 2);
    assert.ok(service.status.last_snapshot_hash);
    assert.equal(service.status.pending_changes, false);
  } finally {
    globalThis.fetch = originalFetch;
    await service.stop();
  }
});

test("master resends the same snapshot after a child activates a proxy catalog", async () => {
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  service.config = structuredClone(config);
  service.client = new FakeCoreClient();
  service.status = createStatus("connected");
  service.discovery.resolve = async () => ({ url: "http://child.test:11081", hostname: "child.test" });

  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/capabilities")) return capabilitiesResponse();
      requests += 1;
      if (requests === 1) return new Response(JSON.stringify({ success: true, accepted: true, restart_required: true }), { status: 202, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ success: true, errors: [], warnings: [], counts: { proxy_entities_configured: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const result = await service.syncNow(true);
    assert.equal(result.success, true);
    assert.equal(requests, 2);
    assert.equal(result.peers[config.peers[0].peer_id].restarted, true);
  } finally {
    globalThis.fetch = originalFetch;
    await service.stop();
  }
});

test("child applies a changed proxy catalog without restarting", async () => {
  const saved = [];
  const service = new RemoteSyncService({ load: () => null, save: (value) => saved.push(structuredClone(value)) });
  service.config = {
    role: "child", node_id: "child", node_name: "Child", pairing: {}, peers: [],
    sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false, proxy_activation_timeout_ms: 200 }
  };
  const configured = new Set();
  service.client = {
    async listPaginated(path) { return path === "/entities" ? [...configured].map((entity_id) => ({ entity_id })) : []; },
    async configureEntitiesFromIntegration(integrationId, entityIds) {
      for (const entityId of entityIds) configured.add(`${integrationId}.${entityId}`);
      return { available: entityIds.map((entity_id) => ({ entity_id })), configured: entityIds };
    },
    async json() { return {}; }
  };
  service.proxyCatalog = { schema_version: 2, entities: [], mapping: {}, activation_hash: "old" };
  let storedCatalog = null;
  service.proxyStore = { save: (value) => { storedCatalog = structuredClone(value); }, load: () => service.proxyCatalog, clear: () => false };
  const manifest = {
    operation_id: randomUUID(), source_node_id: "master", source_name: "Master", content_hash: "hash",
    sections: ["entities"], resources: [],
    data: { entities: [{ entity_id: "hass.main.light.test", entity_type: "light", name: { en: "Test" } }] }
  };
  const report = await service.applyReceived(manifest, {}, {});
  assert.equal(report.success, true);
  assert.equal(report.restart_required, undefined);
  assert.equal(storedCatalog.entities.length, 1);
  assert.equal(configured.size, 1);
  assert.equal(service.status.state, "connected");
});


test("child applies master activity state with on/off commands and suppresses the relay loop", async () => {
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  service.config = {
    role: "child", node_id: "child", node_name: "Child", peers: [],
    pairing: { paired_master_id: "master", master_agent_url: "http://master.test:11081", master_command_token: "token" },
    sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false }
  };
  service.mappings = { get: (sourceNode, kind, sourceId) => sourceNode === "master" && kind === "activity" && sourceId === "uc.main.activity.source" ? "uc.main.activity.child" : null };
  const commands = [];
  service.client = {
    async getJson(path) {
      if (path === "/entities/uc.main.activity.child") return { entity_id: "uc.main.activity.child", entity_type: "activity", attributes: { state: "OFF" } };
      return null;
    },
    async executeEntityCommand(entityId, cmdId) { commands.push({ entityId, cmdId }); return {}; }
  };
  const result = await service.applyActivityState({ source_activity_id: "uc.main.activity.source", state: "ON" });
  assert.equal(result.success, true);
  assert.deepEqual(commands, [{ entityId: "uc.main.activity.child", cmdId: "activity.on" }]);
  const relayed = await service.forwardActivityCommand("uc.main.activity.source", "on");
  assert.equal(relayed.success, true);
  assert.equal(relayed.suppressed, true);
});


test("newer Primary activity state overrides an earlier Satellite relay", async () => {
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  service.config = {
    role: "child", node_id: "child", node_name: "Child", peers: [],
    pairing: { paired_master_id: "master", master_agent_url: "http://master.test:11081", master_command_token: "token" },
    sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false }
  };
  service.mappings = { get: (sourceNode, kind, sourceId) => sourceNode === "master" && kind === "activity" && sourceId === "uc.main.activity.source" ? "uc.main.activity.child" : null };
  let state = "ON";
  const commands = [];
  service.client = {
    async getJson(path) {
      if (path === "/entities/uc.main.activity.child") return { entity_id: "uc.main.activity.child", entity_type: "activity", attributes: { state } };
      return null;
    },
    async executeEntityCommand(entityId, cmdId) {
      commands.push({ entityId, cmdId });
      state = cmdId.endsWith(".off") ? "OFF" : "ON";
      return {};
    }
  };
  service.forwardProxyCommand = async (sourceEntityId, cmdId) => ({ success: true, status: 200, source_entity_id: sourceEntityId, cmd_id: cmdId });

  const forwarded = await service.forwardActivityCommand("uc.main.activity.source", "on");
  assert.equal(forwarded.success, true);

  const primaryOff = await service.applyActivityState({
    source_activity_id: "uc.main.activity.source",
    state: "OFF",
    source_epoch: "primary-epoch",
    revision: 2
  });
  assert.equal(primaryOff.success, true);
  assert.equal(primaryOff.changed, true);
  assert.deepEqual(commands, [{ entityId: "uc.main.activity.child", cmdId: "activity.off" }]);

  const olderOn = await service.applyActivityState({
    source_activity_id: "uc.main.activity.source",
    state: "ON",
    source_epoch: "primary-epoch",
    revision: 1
  });
  assert.equal(olderOn.success, true);
  assert.equal(olderOn.ignored_stale, true);
  assert.deepEqual(commands, [{ entityId: "uc.main.activity.child", cmdId: "activity.off" }]);
});
