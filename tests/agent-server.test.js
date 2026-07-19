import assert from "node:assert/strict";
import net from "node:net";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { AgentServer } from "../src/agent/server.js";
import { canonicalJson, hmacSignature, sha256Bytes } from "../src/shared/util.js";
import { APP_VERSION } from "../src/shared/constants.js";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

test("child pairing endpoint validates token and changes ready state after claim", async () => {
  const port = await freePort();
  const oldAddress = process.env.UC_MDNS_ADDRESS;
  process.env.UC_MDNS_ADDRESS = "127.0.0.1";
  const config = {
    role: "child",
    node_id: "child-node",
    node_name: "Bedroom",
    pairing_identifier: "RMS-ABCD-EFGH",
    pairing: { ready_to_pair: true, paired_master_id: null, paired_master_name: null, paired_at: null },
    agent_token: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    agent_port: port
  };
  let claimed = null;
  const server = new AgentServer(config, {
    applyCallback: async () => ({ success: true }),
    statusCallback: () => ({}),
    syncCallback: async () => ({ success: true }),
    pairingCallback: async ({ master_id, master_name }) => {
      claimed = { master_id, master_name };
      return { ready_to_pair: false, paired_master_id: master_id, paired_master_name: master_name, paired_at: "2026-07-17T20:00:00.000Z" };
    }
  });
  await server.start();
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/pairing/validate`, { method: "POST", headers: { Authorization: "Bearer wrong" } });
    assert.equal(unauthorized.status, 401);

    const headers = { Authorization: `Bearer ${config.agent_token}`, "Content-Type": "application/json" };
    const validated = await fetch(`http://127.0.0.1:${port}/v1/pairing/validate`, { method: "POST", headers, body: "{}" });
    assert.equal(validated.status, 200);
    assert.equal((await validated.json()).ready_to_pair, true);

    const claimedResponse = await fetch(`http://127.0.0.1:${port}/v1/pairing/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({ master_id: "master-node", master_name: "Living room" })
    });
    assert.equal(claimedResponse.status, 200);
    const body = await claimedResponse.json();
    assert.equal(body.ready_to_pair, false);
    assert.deepEqual(claimed, { master_id: "master-node", master_name: "Living room" });

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.deepEqual(await health.json(), { status: "ok", version: APP_VERSION });

    const capabilities = await fetch(`http://127.0.0.1:${port}/v1/capabilities`);
    const capabilityBody = await capabilities.json();
    assert.equal(capabilityBody.ready_to_pair, false);
    assert.equal(capabilityBody.mac, undefined);
    assert.equal(capabilityBody.broadcasts, undefined);
  } finally {
    await server.stop();
    if (oldAddress === undefined) delete process.env.UC_MDNS_ADDRESS; else process.env.UC_MDNS_ADDRESS = oldAddress;
  }
});

test("master proxy command endpoint accepts only the paired child command token", async () => {
  const port = await freePort();
  const config = {
    role: "master",
    node_id: "master-node",
    node_name: "Living room",
    pairing: { ready_to_pair: false },
    pairing_identifier: null,
    agent_token: "master-management-token",
    agent_port: port,
    peers: [{ peer_id: "child", enabled: true, command_token: "child-command-token" }]
  };
  let command = null;
  const server = new AgentServer(config, {
    applyCallback: async () => ({ success: true }),
    statusCallback: () => ({}),
    syncCallback: async () => ({ success: true }),
    pairingCallback: async () => ({}),
    commandCallback: async (value) => { command = value; return { success: true, status: 200 }; }
  });
  await server.start();
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/v1/proxy/command`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ source_entity_id: "hass.main.light.test", cmd_id: "light.on" })
    });
    assert.equal(denied.status, 401);

    const accepted = await fetch(`http://127.0.0.1:${port}/v1/proxy/command`, {
      method: "POST",
      headers: { Authorization: "Bearer child-command-token", "Content-Type": "application/json" },
      body: JSON.stringify({ source_entity_id: "hass.main.light.test", cmd_id: "light.on", params: { brightness: 50 } })
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(command, { source_entity_id: "hass.main.light.test", cmd_id: "light.on", params: { brightness: 50 } });
  } finally { await server.stop(); }
});


test("snapshot endpoint returns the completed apply result without restarting", async () => {
  const port = await freePort();
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const config = {
    role: "child", node_id: "child", node_name: "Child", pairing_identifier: "RMS-TEST-TEST",
    pairing: { ready_to_pair: false }, agent_token: token, agent_port: port
  };
  const data = { entities: [] };
  const manifest = {
    schema_version: 5, operation_id: "00000000-0000-4000-8000-000000000099", source_node_id: "master", source_name: "Master",
    sections: ["entities"], data, resources: [], required_integrations: [],
    content_hash: sha256Bytes(canonicalJson({ data, resources: [], required_integrations: [] }))
  };
  const payload = gzipSync(Buffer.from(JSON.stringify({ format: "uc-remote-sync-gzip-json-v1", manifest, resources: {} })));
  const server = new AgentServer(config, {
    applyCallback: async () => ({ success: true, counts: { proxy_entities_configured: 1 } }),
    statusCallback: () => ({}), syncCallback: async () => ({ success: true }), pairingCallback: async () => ({}),
    commandCallback: async () => ({ success: true })
  });
  await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/snapshots`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/gzip", "X-Remote-Sync-Signature": hmacSignature(token, payload) },
      body: payload
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.restart_required, undefined);
  } finally { await server.stop(); }
});

test("child activity-state endpoint applies authenticated master updates", async () => {
  const port = await freePort();
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const config = {
    role: "child", node_id: "child", node_name: "Child", pairing_identifier: "RMS-STATE-TEST",
    pairing: { ready_to_pair: false, paired_master_id: "master" }, agent_token: token, agent_port: port
  };
  let update = null;
  const server = new AgentServer(config, {
    applyCallback: async () => ({ success: true }), statusCallback: () => ({}), syncCallback: async () => ({ success: true }),
    pairingCallback: async () => ({}), commandCallback: async () => ({ success: true }),
    activityStateCallback: async (value) => { update = value; return { success: true, changed: true }; }
  });
  await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/activity/state`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ source_activity_id: "uc.main.activity.source", state: "ON" })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(update, { source_activity_id: "uc.main.activity.source", state: "ON" });
  } finally { await server.stop(); }
});

test("public health is minimal while detailed status requires authentication", async () => {
  const port = await freePort();
  const token = "s".repeat(32);
  const config = {
    role: "master",
    node_id: "primary-node",
    node_name: "Primary",
    pairing: {},
    agent_token: token,
    agent_port: port,
    peers: [],
    remote: { mac: "fc:84:a7:66:ae:14", broadcasts: ["10.1.1.255"] }
  };
  const server = new AgentServer(config, {
    applyCallback: async () => ({ success: true }),
    statusCallback: () => ({ status: { state: "connected" }, proxy_count: 7, config: { remote: { api_key: "***" } } }),
    syncCallback: async () => ({ success: true }),
    pairingCallback: async () => ({}),
    commandCallback: async () => ({ success: true })
  });
  await server.start();
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.deepEqual(health, { status: "ok", version: APP_VERSION });

    const capabilities = await (await fetch(`http://127.0.0.1:${port}/v1/capabilities`)).json();
    assert.equal(capabilities.node_id, "primary-node");
    assert.equal(capabilities.mac, undefined);
    assert.equal(capabilities.broadcasts, undefined);

    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/status`)).status, 401);
    const statusResponse = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.status.state, "connected");
    assert.equal(status.proxy_count, 7);
  } finally {
    await server.stop();
  }
});

test("snapshot preview validates protocol headers and never calls the apply callback", async () => {
  const port = await freePort();
  const token = "p".repeat(32);
  const config = {
    role: "child",
    node_id: "satellite-node",
    node_name: "Satellite",
    pairing_identifier: "RMS-PREV-IEW2",
    pairing: { ready_to_pair: false },
    agent_token: token,
    agent_port: port
  };
  const data = { entities: [] };
  const manifest = {
    schema_version: 6,
    operation_id: "00000000-0000-4000-8000-000000000199",
    source_node_id: "primary",
    source_name: "Primary",
    sections: ["entities"],
    data,
    resources: [],
    required_integrations: [],
    content_hash: sha256Bytes(canonicalJson({ data, resources: [], required_integrations: [] }))
  };
  const payload = gzipSync(Buffer.from(JSON.stringify({ format: "uc-remote-sync-gzip-json-v1", manifest, resources: {} })));
  let applied = false;
  let previewed = false;
  const server = new AgentServer(config, {
    applyCallback: async () => { applied = true; return { success: true }; },
    previewCallback: async () => { previewed = true; return { success: true, dry_run: true, summary: "Create 1, update 0, remove 0" }; },
    statusCallback: () => ({}),
    syncCallback: async () => ({ success: true }),
    pairingCallback: async () => ({}),
    commandCallback: async () => ({ success: true })
  });
  await server.start();
  try {
    const commonHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/gzip",
      "X-Remote-Sync-Signature": hmacSignature(token, payload),
      "X-Remote-Sync-Snapshot-Schema": "6"
    };
    const rejected = await fetch(`http://127.0.0.1:${port}/v1/snapshots/preview`, {
      method: "POST",
      headers: { ...commonHeaders, "X-Remote-Sync-Protocol": "99" },
      body: payload
    });
    assert.equal(rejected.status, 409);

    const accepted = await fetch(`http://127.0.0.1:${port}/v1/snapshots/preview`, {
      method: "POST",
      headers: { ...commonHeaders, "X-Remote-Sync-Protocol": "2" },
      body: payload
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).dry_run, true);
    assert.equal(previewed, true);
    assert.equal(applied, false);
  } finally {
    await server.stop();
  }
});
