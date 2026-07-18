import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore, ConfigurationError } from "../src/config/store.js";
import { validateConfig } from "../src/config/schema.js";
import { RemoteSyncService } from "../src/service/index.js";

function validConfig(overrides = {}) {
  return {
    schema_version: 6,
    role: "master",
    node_id: "primary-node",
    node_name: "Primary",
    pairing: {},
    remote: { host: "127.0.0.1", api_key: "api-key-123", scheme: "http" },
    network_overrides: {},
    agent_token: "a".repeat(32),
    agent_port: 11081,
    virtual_dock_port: 11083,
    physical_docks: { default_token: "", tokens: {} },
    peers: [],
    sync: { sections: ["entities"], interval_seconds: 300 },
    ...overrides
  };
}

test("configuration migration creates backups before writing schema 6", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remote-sync-config-"));
  const file = path.join(directory, "remote-sync.json");
  const legacy = validConfig({ schema_version: 4, physical_docks: undefined, network_overrides: undefined });
  fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`);
  const config = new ConfigStore(file).load();
  assert.equal(config.schema_version, 6);
  assert.ok(config.sync.sections.includes("docks"));
  assert.deepEqual(config.network_overrides, { mac: null, broadcasts: [] });
  assert.equal(fs.existsSync(`${file}.bak`), true);
  assert.ok(fs.readdirSync(directory).some((name) => name.includes("schema-4-to-6") && name.endsWith(".bak")));
});

test("invalid configuration reports every actionable field error", () => {
  assert.throws(
    () => validateConfig(validConfig({ node_id: "", agent_token: "short", remote: { host: "", api_key: "bad" } })),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.code, "CONFIGURATION_INVALID");
      assert.ok(error.errors.some((item) => item.includes("node_id")));
      assert.ok(error.errors.some((item) => item.includes("remote.host")));
      assert.ok(error.errors.some((item) => item.includes("remote.api_key")));
      assert.ok(error.errors.some((item) => item.includes("agent_token")));
      return true;
    }
  );
});

test("service exposes configuration_invalid instead of starting with bad data", async () => {
  const error = new ConfigurationError(["remote.host is required", "agent_token must contain at least 32 characters"]);
  const service = new RemoteSyncService({ load: () => { throw error; }, save: () => {} });
  await service.load();
  assert.equal(service.status.state, "configuration_invalid");
  assert.deepEqual(service.status.configuration_errors, error.errors);
  assert.equal(service.config, null);
});
