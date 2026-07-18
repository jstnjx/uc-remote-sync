import assert from "node:assert/strict";
import test from "node:test";
import { assertProtocolCompatibility, protocolDescriptor, ProtocolCompatibilityError } from "../src/protocol/index.js";
import { PeerAgentClient } from "../src/service/peer-agent-client.js";

test("protocol descriptor advertises stabilization capabilities", () => {
  const value = protocolDescriptor();
  assert.equal(value.protocol_version, 2);
  assert.equal(value.snapshot_schema, 6);
  for (const capability of ["proxy_entities", "automatic_network_identity", "satellite_management", "credential_rotation", "sync_preview"]) {
    assert.ok(value.capabilities.includes(capability));
  }
});

test("protocol negotiation rejects unsupported versions and missing capabilities", () => {
  assert.throws(
    () => assertProtocolCompatibility({ ...protocolDescriptor(), protocol_version: 99 }),
    ProtocolCompatibilityError
  );
  assert.throws(
    () => assertProtocolCompatibility({ ...protocolDescriptor(), capabilities: [] }, { requiredCapabilities: ["sync_preview"] }),
    /missing required capabilities: sync_preview/
  );
});

test("legacy agents with generic unknown-route responses are negotiated as protocol 1", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Unknown operation" }), {
      status: 422,
      headers: { "Content-Type": "application/json" }
    });
    const protocol = await new PeerAgentClient("http://legacy.test", "x".repeat(32)).capabilities();
    assert.equal(protocol.version, "legacy");
    assert.equal(protocol.protocol_version, 1);
    assert.equal(protocol.snapshot_schema, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
