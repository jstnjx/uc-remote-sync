import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { AgentServer } from "../src/agent/server.js";
import { bridgeMasterDockTunnel, physicalDockConnection, virtualDockToken, VirtualDockServer } from "../src/dock/proxy.js";
import { connectWebSocket, createWebSocketHttpServer } from "../src/transport/websocket.js";

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
  throw new Error(`Timed out waiting for Dock message: ${JSON.stringify(messages)}`);
}

test("child virtual Dock proxies the full WebSocket protocol through the master", async () => {
  const physicalPort = await freePort();
  const masterPort = await freePort();
  const virtualPort = await freePort();
  const sourceDockId = "uc-dock-3-test";
  const childAgentToken = "child-agent-token-abcdefghijklmnopqrstuvwxyz";
  const childCommandToken = "child-command-token";
  const physicalToken = "physical-dock-token";
  const virtualToken = virtualDockToken(childAgentToken, "master-node", sourceDockId);
  let receivedPhysicalToken = null;
  const physicalMessages = [];

  const physical = createWebSocketHttpServer({
    host: "127.0.0.1",
    port: physicalPort,
    onConnection(peer) {
      peer.send(JSON.stringify({ type: "auth_required", model: "UCD3", revision: "1", version: "1.0.0", features: 3 }));
      peer.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        physicalMessages.push(message);
        if (message.type === "auth") {
          receivedPhysicalToken = message.token;
          peer.send(JSON.stringify({ type: "authentication", req_id: message.id, code: message.token === physicalToken ? 200 : 401 }));
        } else if (message.command === "get_sysinfo") {
          peer.send(JSON.stringify({ type: "dock", req_id: message.id, msg: "get_sysinfo", code: 200, model: "UCD3", serial: sourceDockId }));
          peer.send(JSON.stringify({ type: "event", msg: "serial_data", port: 1, data: "READY\r" }));
        }
      });
    }
  });
  await physical.listen();

  const masterConfig = {
    role: "master",
    node_id: "master-node",
    node_name: "Master",
    pairing: { ready_to_pair: false },
    pairing_identifier: null,
    agent_token: "master-management-token",
    agent_port: masterPort,
    peers: [{
      peer_id: "child",
      name: "Child",
      enabled: true,
      token: childAgentToken,
      command_token: childCommandToken
    }]
  };
  const master = new AgentServer(masterConfig, {
    applyCallback: async () => ({ success: true }),
    statusCallback: () => ({}),
    syncCallback: async () => ({ success: true }),
    pairingCallback: async () => ({}),
    commandCallback: async () => ({ success: true }),
    dockTunnelCallback: ({ downstream, dock_id, child }) => {
      assert.equal(dock_id, sourceDockId);
      return bridgeMasterDockTunnel({
        downstream,
        physicalUrl: `ws://127.0.0.1:${physicalPort}`,
        physicalToken,
        virtualToken: virtualDockToken(child.token, masterConfig.node_id, dock_id)
      });
    }
  });
  await master.start();

  const childConfig = {
    role: "child",
    agent_token: childAgentToken,
    virtual_dock_port: virtualPort,
    pairing: {
      master_agent_url: `http://127.0.0.1:${masterPort}`,
      master_command_token: childCommandToken
    }
  };
  const child = new VirtualDockServer(childConfig);
  child.setDocks("master-node", [{ source_id: sourceDockId }]);
  await child.start();

  const core = await connectWebSocket(`ws://127.0.0.1:${virtualPort}/v1/docks/${sourceDockId}`);
  const messages = [];
  core.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  try {
    const required = await waitFor(messages, (message) => message.type === "auth_required");
    assert.equal(required.model, "UCD3");

    core.send(JSON.stringify({ type: "auth", id: 1, token: virtualToken }));
    const authenticated = await waitFor(messages, (message) => message.type === "authentication");
    assert.equal(authenticated.code, 200);
    assert.equal(receivedPhysicalToken, physicalToken);

    core.send(JSON.stringify({ type: "dock", id: 2, command: "get_sysinfo" }));
    const sysinfo = await waitFor(messages, (message) => message.req_id === 2);
    assert.equal(sysinfo.serial, sourceDockId);
    const serialEvent = await waitFor(messages, (message) => message.type === "event" && message.msg === "serial_data");
    assert.equal(serialEvent.data, "READY\r");
    assert.ok(physicalMessages.some((message) => message.command === "get_sysinfo"));
  } finally {
    core.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await child.stop();
    await master.stop();
    await physical.close();
  }
});

test("physical Dock connection accepts common Core field shapes", () => {
  assert.deepEqual(
    physicalDockConnection({ address: { host: "dock.local" }, credentials: { token: "secret" } }),
    { url: "ws://dock.local:946/", token: "secret" }
  );
  assert.deepEqual(
    physicalDockConnection({ custom_ws_url: "wss://dock.example/ws", token: "secret" }),
    { url: "wss://dock.example/ws", token: "secret" }
  );
  assert.deepEqual(
    physicalDockConnection({ resolved_ws_url: "10.1.1.50:946" }, { token: "configured" }),
    { url: "ws://10.1.1.50:946/", token: "configured" }
  );
  assert.deepEqual(
    physicalDockConnection({}, { dockId: "UCD3-0B8868", token: "configured" }),
    { url: "ws://ucd3-0b8868.local:946/", token: "configured" }
  );
});
