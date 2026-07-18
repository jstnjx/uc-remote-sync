import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { CoreEventWatcher, CoreWebSocket, CoreWebSocketError } from "../src/core/events.js";
import { createWebSocketHttpServer } from "../src/transport/websocket.js";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

test("Core WebSocket sends API-KEY and handles request responses", async () => {
  const port = await freePort();
  let apiKeyHeader;
  const server = createWebSocketHttpServer({ host: "127.0.0.1", port, onConnection(peer, request) {
    apiKeyHeader = request.headers["api-key"];
    peer.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      peer.send(JSON.stringify({ kind: "resp", req_id: msg.id, msg: "result", code: 200, msg_data: { accepted: msg.msg } }));
    });
  }});
  await server.listen();
  const client = new CoreWebSocket({ host: "127.0.0.1", port, scheme: "http", api_key: "secret", verify_tls: false });
  try {
    const result = await client.request("subscribe_events", { channels: ["all"] });
    assert.equal(apiKeyHeader, "secret");
    assert.equal(result.msg_data.accepted, "subscribe_events");
  } finally {
    await client.close();
    await server.close();
  }
});


test("Core WebSocket exposes structured response errors", async () => {
  const port = await freePort();
  const server = createWebSocketHttpServer({ host: "127.0.0.1", port, onConnection(peer) {
    peer.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      peer.send(JSON.stringify({ kind: "resp", req_id: msg.id, msg: "result", code: 404, msg_data: { code: "NOT_FOUND" } }));
    });
  }});
  await server.listen();
  const client = new CoreWebSocket({ host: "127.0.0.1", port, scheme: "http", api_key: "secret", verify_tls: false });
  try {
    await assert.rejects(client.request("missing_operation"), (error) => {
      assert.ok(error instanceof CoreWebSocketError);
      assert.equal(error.code, 404);
      assert.equal(error.messageName, "missing_operation");
      assert.deepEqual(error.data, { code: "NOT_FOUND" });
      return true;
    });
  } finally { await client.close(); await server.close(); }
});


test("Core event watcher emits internal activity state changes without scheduling a snapshot", async () => {
  const port = await freePort();
  let sent = false;
  const server = createWebSocketHttpServer({ host: "127.0.0.1", port, onConnection(peer) {
    peer.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      peer.send(JSON.stringify({ kind: "resp", req_id: msg.id, msg: "result", code: 200, msg_data: {} }));
      if (!sent && msg.msg === "subscribe_events") {
        sent = true;
        setTimeout(() => peer.send(JSON.stringify({
          kind: "event", msg: "entity_change", msg_data: {
            entity_id: "uc.main.62d0878d-activity", event_type: "UPDATE", attributes: { state: "ON" }
          }
        })), 5);
      }
    });
  }});
  await server.listen();
  let configurationCallbacks = 0;
  let resolveState;
  const stateReceived = new Promise((resolve) => { resolveState = resolve; });
  const watcher = new CoreEventWatcher(
    { host: "127.0.0.1", port, scheme: "http", api_key: "secret", verify_tls: false },
    async () => { configurationCallbacks += 1; },
    { debounceMs: 20, activityStateCallback: (event) => resolveState(event) }
  );
  const run = watcher.run();
  try {
    const event = await Promise.race([stateReceived, new Promise((_, reject) => setTimeout(() => reject(new Error("state timeout")), 1000))]);
    assert.equal(event.source_activity_id, "uc.main.62d0878d-activity");
    assert.equal(event.state, "ON");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(configurationCallbacks, 0);
  } finally {
    watcher.stop();
    await server.close();
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 100))]);
  }
});
