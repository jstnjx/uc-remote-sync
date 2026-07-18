import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { CoreClient } from "../src/core/client.js";
import { createWebSocketHttpServer } from "../src/transport/websocket.js";

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const endpoint = { host: "127.0.0.1", scheme: "http", port: 8080, api_key: "secret", mac: null, broadcasts: [] };

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

test("Core API 0.17 pagination omits page=1 on the first request", async () => {
  const urls = [];
  const client = new CoreClient(endpoint, {
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return jsonResponse([{ entity_id: "hass.main.light.test" }], {
        headers: { "Pagination-Count": "1", "Pagination-Limit": "100", "Pagination-Page": "1" }
      });
    }
  });
  const items = await client.listPaginated("/entities");
  assert.equal(items.length, 1);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get("limit"), "100");
  assert.equal(urls[0].searchParams.has("page"), false);
});

test("integration collection falls back from legacy to current route", async () => {
  const paths = [];
  const client = new CoreClient(endpoint, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      paths.push(parsed.pathname);
      if (parsed.pathname === "/api/intg") return jsonResponse({ error: "Not found" }, { status: 404 });
      return jsonResponse([{ integration_id: "hass.main" }], { headers: { "Pagination-Count": "1" } });
    }
  });
  assert.deepEqual(await client.integrations(), [{ integration_id: "hass.main" }]);
  assert.deepEqual(paths, ["/api/intg", "/api/intg/instances"]);
});

test("entity configuration falls back to the legacy integration route", async () => {
  const paths = [];
  const client = new CoreClient(endpoint, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      paths.push(parsed.pathname);
      if (parsed.pathname.includes("/intg/instances/")) return jsonResponse({ error: "Not found" }, { status: 404 });
      return jsonResponse({ entity_id: "hass.main.light.test" }, { status: 201 });
    }
  });
  const result = await client.configureEntity("hass.main", "hass.main.light.test", {});
  assert.equal(result.entity_id, "hass.main.light.test");
  assert.deepEqual(paths, [
    "/api/intg/instances/hass.main/entities/hass.main.light.test",
    "/api/intg/hass.main/entities/hass.main.light.test"
  ]);
});


test("proxy entities are force-refreshed and configured through Core WebSocket API", async () => {
  const port = await freePort();
  const requests = [];
  let apiKeyHeader = null;
  const server = createWebSocketHttpServer({ host: "127.0.0.1", port, onConnection(peer, request) {
    apiKeyHeader = request.headers["api-key"];
    peer.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      requests.push(msg);
      if (msg.msg === "get_available_entities") {
        peer.send(JSON.stringify({ kind: "resp", req_id: msg.id, msg: "available_entities", code: 200, msg_data: {
          filter: msg.msg_data.filter, paging: { count: 2, page: 1, limit: 100 },
          available_entities: [{ entity_id: "proxy_aaa" }, { entity_id: "proxy_bbb" }]
        } }));
        return;
      }
      peer.send(JSON.stringify({ kind: "resp", req_id: msg.id, msg: "result", code: 200, msg_data: {} }));
    });
  }});
  await server.listen();
  const client = new CoreClient({ ...endpoint, port });
  try {
    const result = await client.configureEntitiesFromIntegration("remote_sync.main", ["proxy_aaa", "proxy_bbb"]);
    assert.equal(apiKeyHeader, "secret");
    assert.deepEqual(result.configured, ["proxy_aaa", "proxy_bbb"]);
    assert.equal(requests[0].msg, "get_available_entities");
    assert.equal(requests[0].msg_data.force_reload, true);
    assert.equal(requests[0].msg_data.filter.integration_id, "remote_sync.main");
    assert.equal(requests[1].msg, "configure_entities_from_integration");
    assert.deepEqual(requests[1].msg_data, { integration_id: "remote_sync.main", entity_ids: ["proxy_aaa", "proxy_bbb"] });
  } finally { await server.close(); }
});

test("entity configuration falls back from batch to individual WebSocket requests", async () => {
  const port = await freePort();
  const requestNames = [];
  const server = createWebSocketHttpServer({ host: "127.0.0.1", port, onConnection(peer) {
    peer.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      requestNames.push(msg.msg);
      if (msg.msg === "get_available_entities") {
        peer.send(JSON.stringify({ kind: "resp", req_id: msg.id, msg: "available_entities", code: 200, msg_data: {
          available_entities: [{ entity_id: "proxy_aaa" }, { entity_id: "proxy_bbb" }]
        } }));
      } else if (msg.msg === "configure_entities_from_integration") {
        peer.send(JSON.stringify({ kind: "resp", req_id: msg.id, msg: "result", code: 404, msg_data: { code: "NOT_FOUND" } }));
      } else {
        peer.send(JSON.stringify({ kind: "resp", req_id: msg.id, msg: "result", code: 200, msg_data: {} }));
      }
    });
  }});
  await server.listen();
  const client = new CoreClient({ ...endpoint, port });
  try {
    await client.configureEntitiesFromIntegration("remote_sync.main", ["proxy_aaa", "proxy_bbb"]);
    assert.deepEqual(requestNames, [
      "get_available_entities", "configure_entities_from_integration",
      "configure_entity_from_integration", "configure_entity_from_integration"
    ]);
  } finally { await server.close(); }
});

test("available entity refresh merges compatibility response shapes until required proxies are present", async () => {
  const port = await freePort();
  const requests = [];
  let refreshCount = 0;
  const server = createWebSocketHttpServer({ host: "127.0.0.1", port, onConnection(peer) {
    peer.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      requests.push(msg);
      if (msg.msg === "get_available_entities") {
        refreshCount += 1;
        const available = refreshCount === 1
          ? [{ entity_id: "proxy_aaa" }]
          : [{ entity_id: "proxy_bbb" }];
        peer.send(JSON.stringify({ kind: "resp", req_id: msg.id, msg: "available_entities", code: 200, msg_data: {
          available_entities: available
        } }));
        return;
      }
      peer.send(JSON.stringify({ kind: "resp", req_id: msg.id, msg: "result", code: 200, msg_data: {} }));
    });
  }});
  await server.listen();
  const client = new CoreClient({ ...endpoint, port });
  try {
    const result = await client.configureEntitiesFromIntegration("remote_sync.main", ["proxy_aaa", "proxy_bbb"]);
    assert.deepEqual(result.available.map((item) => item.entity_id).sort(), ["proxy_aaa", "proxy_bbb"]);
    assert.equal(requests.filter((item) => item.msg === "get_available_entities").length, 2);
    assert.equal(requests.at(-1).msg, "configure_entities_from_integration");
  } finally { await server.close(); }
});
