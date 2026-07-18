import test from "node:test";
import assert from "node:assert/strict";
import { endpointBaseUrl, endpointWsUrl, normalizeConfig, redactConfig } from "../src/shared/models.js";

test("endpoint URLs are generated correctly", () => {
  const endpoint = { host: "10.1.1.170", port: 8443, scheme: "https" };
  assert.equal(endpointBaseUrl(endpoint), "https://10.1.1.170:8443/api");
  assert.equal(endpointWsUrl(endpoint), "wss://10.1.1.170:8443/ws");
});

test("configuration redaction removes secrets", () => {
  const config = normalizeConfig({
    role: "master",
    node_id: "master",
    pairing_identifier: "RMS-MAST-ER23",
    remote: { host: "x", api_key: "secret-api-key" },
    agent_token: "a".repeat(32),
    physical_docks: { default_token: "dock-default", tokens: { "UCD3-ONE": "dock-one" } },
    peers: [{ identifier: "RMS-ABCD-EFGH", token: "p".repeat(32), command_token: "c".repeat(32) }],
    pairing: { master_command_token: "m".repeat(32) }
  });
  const redacted = redactConfig(config);
  assert.equal(redacted.remote.api_key, "***");
  assert.equal(redacted.agent_token, "***");
  assert.equal(redacted.physical_docks.default_token, "***");
  assert.equal(redacted.physical_docks.tokens["UCD3-ONE"], "***");
  assert.equal(redacted.peers[0].token, "***");
  assert.equal(redacted.peers[0].command_token, "***");
  assert.equal(redacted.pairing.master_command_token, "***");
  assert.equal(redacted.peers[0].identifier, "RMS-ABCD-EFGH");
});

test("physical Dock tokens are normalized", () => {
  const config = normalizeConfig({
    role: "master",
    node_id: "master",
    remote: { host: "127.0.0.1", api_key: "api-key-123" },
    agent_token: "a".repeat(32),
    physical_docks: {
      default_token: " default-token ",
      tokens: { " UCD3-ONE ": " one-token ", "UCD3-EMPTY": "" }
    }
  });
  assert.equal(config.physical_docks.default_token, "default-token");
  assert.deepEqual(config.physical_docks.tokens, { "UCD3-ONE": "one-token" });
});

test("configuration normalizes identifier-only child peers", () => {
  const config = normalizeConfig({
    role: "master",
    node_id: "master",
    pairing_identifier: "RMS-MAST-ER23",
    remote: { host: "127.0.0.1", api_key: "api-key-123" },
    agent_token: "a".repeat(32),
    peers: [{ identifier: "rms-abcd-efgh", name: "Bedroom", token: "token-value-1234567890123456" }]
  });
  assert.equal(config.schema_version, 6);
  assert.equal(config.peers[0].peer_id, "rms-abcdefgh");
  assert.equal(config.peers[0].identifier, "RMS-ABCD-EFGH");
  assert.equal(config.peers[0].url, null);
  assert.equal(config.pairing.ready_to_pair, false);
});

test("v0.4.4 configurations automatically enable the new docks section", () => {
  const config = normalizeConfig({
    schema_version: 4,
    role: "master",
    node_id: "master",
    remote: { host: "127.0.0.1", api_key: "api-key-123" },
    agent_token: "a".repeat(32),
    sync: { sections: ["entities", "activities", "profiles", "macros"] }
  });
  assert.ok(config.sync.sections.includes("docks"));
});
