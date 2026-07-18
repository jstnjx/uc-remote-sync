import test from "node:test";
import assert from "node:assert/strict";
import { SnapshotApplier } from "../src/apply/index.js";
import { buildProxyCatalog } from "../src/proxy/catalog.js";
import { virtualDockToken } from "../src/dock/proxy.js";

class FakeCache { get() { return null; } put() {} }
class FakeMappings { save() {} get() { return null; } set() {} items() { return {}; } remove() {} }

class FakeClient {
  constructor() { this.configured = []; this.configuredIds = new Set(); this.calls = []; }
  async getJson() { return null; }
  async listPaginated(path) {
    if (path === "/entities") return [...this.configuredIds].map((entity_id) => ({ entity_id }));
    return [];
  }
  async configureEntitiesFromIntegration(integrationId, entityIds) {
    this.configured.push({ integrationId, entityIds: [...entityIds] });
    for (const entityId of entityIds) this.configuredIds.add(`${integrationId}.${entityId}`);
    return { available: entityIds.map((entity_id) => ({ entity_id })), configured: [...entityIds] };
  }
  async json(method, path, options = {}) { this.calls.push({ method, path, json: options.json }); return {}; }
}

test("source entities become Remote Sync proxy entities without child integrations", async () => {
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000001",
    source_node_id: "master",
    source_name: "Master",
    content_hash: "hash",
    sections: ["entities"],
    required_integrations: ["missing.main"],
    resources: [],
    data: { entities: [{ entity_id: "missing.main.light.test", entity_type: "light", integration_id: "missing.main", name: { en: "Test" }, features: ["on_off"], attributes: { state: "ON" } }] }
  };
  const catalog = buildProxyCatalog(manifest);
  const client = new FakeClient();
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, catalog);
  assert.equal(report.success, true);
  assert.equal(report.counts.proxy_entities_configured, 1);
  assert.equal(client.configured[0].integrationId, "remote_sync.main");
  assert.match(client.configured[0].entityIds[0], /^proxy_[0-9a-f]{24}$/);
});

test("activities are rewritten to proxy entity identifiers", async () => {
  const calls = [];
  const configuredIds = new Set();
  const client = {
    async getJson() { return null; },
    async listPaginated(path) { return path === "/entities" ? [...configuredIds].map((entity_id) => ({ entity_id })) : []; },
    async configureEntitiesFromIntegration(integrationId, entityIds) {
      for (const entityId of entityIds) configuredIds.add(`${integrationId}.${entityId}`);
      return { available: entityIds.map((entity_id) => ({ entity_id })), configured: entityIds };
    },
    async json(method, path, options = {}) {
      calls.push({ method, path, json: options.json });
      if (method === "POST" && path === "/activities") return { entity_id: "uc.main.activity.child" };
      return {};
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000002",
    source_node_id: "master",
    source_name: "Master",
    content_hash: "hash2",
    sections: ["entities", "activities"],
    resources: [],
    data: {
      entities: [{ entity_id: "hass.main.light.test", entity_type: "light", name: { en: "Test" }, attributes: { state: "OFF" } }],
      activities: [{ source_id: "uc.main.activity.source", detail: { name: { en: "Watch TV" }, options: { on_sequence: [{ entity_id: "hass.main.light.test", cmd_id: "light.on" }] } } }]
    }
  };
  const catalog = buildProxyCatalog(manifest);
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, catalog);
  assert.equal(report.success, true);
  const patches = calls.filter((call) => call.method === "PATCH" && call.path === "/activities/uc.main.activity.child");
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0].json.options.entity_ids, ["remote_sync.main.activity_relay"]);
  assert.equal(patches[0].json.options.sequences, undefined);
  assert.equal(patches[1].json.options.on_sequence, undefined);
  assert.equal(patches[1].json.options.off_sequence, undefined);
  assert.equal(patches[1].json.options.sequences.on[0].command.entity_id, "remote_sync.main.activity_relay");
  assert.equal(patches[1].json.options.sequences.on[0].command.cmd_id, "button.push");
  assert.deepEqual(patches[1].json.options.sequences.on[0].command.params, { source_activity_id: "uc.main.activity.source", action: "on" });
  assert.deepEqual(patches[1].json.options.sequences.off[0].command.params, { source_activity_id: "uc.main.activity.source", action: "off" });
});


test("profile pages are rewritten to proxy and child activity identifiers", async () => {
  const calls = [];
  const configuredIds = new Set();
  const profilePages = [];
  const client = {
    async getJson(path) {
      if (path === "/profiles/default") return { profile_id: "default" };
      return null;
    },
    async listPaginated(path) {
      if (path === "/entities") return [...configuredIds].map((entity_id) => ({ entity_id }));
      if (path === "/profiles/default/pages") return [...profilePages];
      if (path === "/profiles/default/groups") return [];
      return [];
    },
    async configureEntitiesFromIntegration(integrationId, entityIds) {
      for (const entityId of entityIds) configuredIds.add(`${integrationId}.${entityId}`);
      return { available: entityIds.map((entity_id) => ({ entity_id })), configured: entityIds };
    },
    async json(method, path, options = {}) {
      calls.push({ method, path, json: options.json });
      if (method === "POST" && path === "/activities") return { entity_id: "uc.main.activity.child" };
      if (method === "DELETE" && path === "/profiles/default/pages") { profilePages.length = 0; return {}; }
      if (method === "POST" && path.endsWith("/pages")) { const page = { page_id: "child-page", ...options.json }; profilePages.push(page); return page; }
      return {};
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const sourceEntity = "hass.main.light.test";
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000003",
    source_node_id: "master",
    source_name: "Master",
    content_hash: "hash3",
    sections: ["entities", "activities", "profiles"],
    resources: [],
    data: {
      entities: [{ entity_id: sourceEntity, entity_type: "light", name: { en: "Test" }, attributes: { state: "OFF" } }],
      activities: [{ source_id: "uc.main.activity.source", detail: { name: { en: "Scene" }, options: {} } }],
      profiles: {
        items: [{
          source_id: "default",
          detail: { profile_id: "default", name: { en: "Default" } },
          pages: [{ name: { en: "Main" }, items: [{ entity_id: sourceEntity }, { entity_id: "uc.main.activity.source" }] }],
          groups: []
        }],
        active: null
      }
    }
  };
  const catalog = buildProxyCatalog(manifest);
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, catalog);
  assert.equal(report.success, true);
  const page = calls.find((call) => call.method === "POST" && call.path === "/profiles/default/pages");
  assert.match(page.json.items[0].entity_id, /^remote_sync\.main\.proxy_/);
  assert.equal(page.json.items[1].entity_id, "uc.main.activity.child");
});


test("master-only Remote Sync controls are removed from child activity sequences", async () => {
  const calls = [];
  const configuredIds = new Set();
  const client = {
    async getJson() { return null; },
    async listPaginated(path) { return path === "/entities" ? [...configuredIds].map((entity_id) => ({ entity_id })) : []; },
    async configureEntitiesFromIntegration(integrationId, entityIds) {
      for (const entityId of entityIds) configuredIds.add(`${integrationId}.${entityId}`);
      return { available: entityIds.map((entity_id) => ({ entity_id })), configured: entityIds };
    },
    async json(method, path, options = {}) {
      calls.push({ method, path, json: options.json });
      if (method === "POST" && path === "/activities") return { entity_id: "uc.main.activity.child-control" };
      return {};
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000005", source_node_id: "master", source_name: "Master", content_hash: "hash5",
    sections: ["activities"], resources: [], data: { entities: [], activities: [{
      source_id: "uc.main.activity.control",
      detail: { name: { en: "Control" }, options: { on_sequence: [{ entity_id: "remote_sync.main.sync_now", cmd_id: "button.push" }] } }
    }] }
  };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, buildProxyCatalog(manifest));
  assert.equal(report.success, true);
  const patches = calls.filter((call) => call.method === "PATCH" && call.path === "/activities/uc.main.activity.child-control");
  assert.equal(patches.length, 2);
  assert.equal(patches[1].json.options.sequences.on[0].command.entity_id, "remote_sync.main.activity_relay");
  assert.deepEqual(patches[1].json.options.sequences.on[0].command.params, { source_activity_id: "uc.main.activity.control", action: "on" });
  assert.match(report.warnings.join(" "), /remote_sync\.main\.sync_now/);
});


test("wrapped unsupported commands are removed without leaving invalid sequence shells", async () => {
  const calls = [];
  const configuredIds = new Set();
  const client = {
    async getJson() { return null; },
    async listPaginated(path) { return path === "/entities" ? [...configuredIds].map((entity_id) => ({ entity_id })) : []; },
    async configureEntitiesFromIntegration(integrationId, entityIds) {
      for (const entityId of entityIds) configuredIds.add(`${integrationId}.${entityId}`);
      return { available: entityIds.map((entity_id) => ({ entity_id })), configured: entityIds };
    },
    async json(method, path, options = {}) {
      calls.push({ method, path, json: options.json });
      if (method === "POST" && path === "/activities") return { entity_id: "uc.main.activity.child-wrapper" };
      return {};
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000006", source_node_id: "master", source_name: "Master", content_hash: "hash6",
    sections: ["activities"], resources: [], data: { entities: [], activities: [{
      source_id: "uc.main.activity.wrapper",
      detail: { name: { en: "Wrapper" }, options: { on_sequence: [{ type: "command", command: { entity_id: "remote_sync.main.sync_now", cmd_id: "button.push" } }] } }
    }] }
  };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, buildProxyCatalog(manifest));
  assert.equal(report.success, true);
  const patches = calls.filter((call) => call.method === "PATCH" && call.path === "/activities/uc.main.activity.child-wrapper");
  assert.equal(patches.length, 2);
  assert.equal(patches[1].json.options.sequences.on[0].command.entity_id, "remote_sync.main.activity_relay");
  assert.equal(JSON.stringify(patches[1].json).includes("remote_sync.main.sync_now"), false);
  assert.equal(patches[1].json.options.sequences.on.length, 1);
});

test("activity membership is committed before wrapped command sequences", async () => {
  const calls = [];
  const configuredIds = new Set();
  let membership = new Set();
  const client = {
    async getJson() { return null; },
    async listPaginated(path) { return path === "/entities" ? [...configuredIds].map((entity_id) => ({ entity_id })) : []; },
    async configureEntitiesFromIntegration(integrationId, entityIds) {
      for (const entityId of entityIds) configuredIds.add(`${integrationId}.${entityId}`);
      return { available: entityIds.map((entity_id) => ({ entity_id })), configured: entityIds };
    },
    async json(method, path, options = {}) {
      calls.push({ method, path, json: options.json });
      if (method === "POST" && path === "/activities") return { entity_id: "uc.main.activity.child-order" };
      if (method === "PATCH" && path === "/activities/uc.main.activity.child-order") {
        const optionsPayload = options.json?.options || {};
        if (Array.isArray(optionsPayload.entity_ids) && optionsPayload.sequences === undefined) membership = new Set(optionsPayload.entity_ids);
        if (Array.isArray(optionsPayload.sequences?.on)) {
          for (const entry of optionsPayload.sequences.on) {
            const entityId = entry?.command?.entity_id || entry?.entity_id;
            if (entityId && !membership.has(entityId)) throw new Error(`sequence validated before membership: ${entityId}`);
          }
        }
      }
      return {};
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const sourceEntity = "hass.main.media_player.test";
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000007", source_node_id: "master", source_name: "Master", content_hash: "hash7",
    sections: ["entities", "activities"], resources: [], data: {
      entities: [{ entity_id: sourceEntity, entity_type: "media_player", name: { en: "Player" } }],
      activities: [{ source_id: "uc.main.activity.order", detail: {
        name: { en: "Order" },
        options: { on_sequence: [{ type: "command", command: { entity_id: sourceEntity, cmd_id: "media_player.on" } }] }
      } }]
    }
  };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, buildProxyCatalog(manifest));
  assert.equal(report.success, true);
  const patches = calls.filter((call) => call.method === "PATCH" && call.path === "/activities/uc.main.activity.child-order");
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0].json.options.entity_ids, ["remote_sync.main.activity_relay"]);
  assert.equal(patches[1].json.options.sequences.on[0].command.entity_id, "remote_sync.main.activity_relay");
});

test("profile graph is not modified after an activity content failure", async () => {
  const calls = [];
  const configuredIds = new Set();
  const client = {
    async getJson(path) { if (path === "/profiles/default") return { profile_id: "default" }; return null; },
    async listPaginated(path) { return path === "/entities" ? [...configuredIds].map((entity_id) => ({ entity_id })) : []; },
    async configureEntitiesFromIntegration(integrationId, entityIds) {
      for (const entityId of entityIds) configuredIds.add(`${integrationId}.${entityId}`);
      return { available: entityIds.map((entity_id) => ({ entity_id })), configured: entityIds };
    },
    async json(method, path, options = {}) {
      calls.push({ method, path, json: options.json });
      if (method === "POST" && path === "/activities") return { entity_id: "uc.main.activity.child-fail" };
      if (method === "PATCH" && path === "/activities/uc.main.activity.child-fail" && options.json?.options?.sequences) throw new Error("simulated sequence failure");
      return {};
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000008", source_node_id: "master", source_name: "Master", content_hash: "hash8",
    sections: ["activities", "profiles"], resources: [], data: {
      entities: [],
      activities: [{ source_id: "uc.main.activity.fail", detail: { name: { en: "Fail" }, options: { on_sequence: [] } } }],
      profiles: { items: [{ source_id: "default", detail: { profile_id: "default", name: { en: "Default" } }, pages: [{ name: { en: "Main" }, items: [] }], groups: [] }], active: null }
    }
  };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, buildProxyCatalog(manifest));
  assert.equal(report.success, false);
  assert.equal(calls.some((call) => call.path.startsWith("/profiles")), false);
  assert.match(report.warnings.join(" "), /Skipped activity groups and profiles/);
});


test("profile pages discard invalid nested entity wrappers", async () => {
  const calls = [];
  const configuredIds = new Set();
  const profilePages = [];
  const client = {
    async getJson(path) { if (path === "/profiles/default") return { profile_id: "default" }; return null; },
    async listPaginated(path) {
      if (path === "/entities") return [...configuredIds].map((entity_id) => ({ entity_id }));
      if (path === "/profiles/default/pages") return [...profilePages];
      if (path === "/profiles/default/groups") return [];
      return [];
    },
    async configureEntitiesFromIntegration(integrationId, entityIds) {
      for (const entityId of entityIds) configuredIds.add(`${integrationId}.${entityId}`);
      return { available: entityIds.map((entity_id) => ({ entity_id })), configured: entityIds };
    },
    async json(method, path, options = {}) {
      calls.push({ method, path, json: options.json });
      if (method === "DELETE" && path === "/profiles/default/pages") { profilePages.length = 0; return {}; }
      if (method === "POST" && path.endsWith("/pages")) { const page = { page_id: "child-page", ...options.json }; profilePages.push(page); return page; }
      return {};
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const sourceEntity = "hass.main.light.valid";
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000009", source_node_id: "master", source_name: "Master", content_hash: "hash9",
    sections: ["entities", "profiles"], resources: [], data: {
      entities: [{ entity_id: sourceEntity, entity_type: "light", name: { en: "Valid" } }],
      profiles: { items: [{ source_id: "default", detail: { profile_id: "default", name: { en: "Default" } }, pages: [{
        name: { en: "Main" }, items: [
          { type: "entity", entity: { entity_id: "missing.main.light.invalid" } },
          { type: "entity", entity: { entity_id: sourceEntity } }
        ]
      }], groups: [] }], active: null }
    }
  };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, buildProxyCatalog(manifest));
  assert.equal(report.success, true);
  const page = calls.find((call) => call.method === "POST" && call.path === "/profiles/default/pages");
  assert.equal(page.json.items.length, 1);
  assert.match(page.json.items[0].entity_id, /^remote_sync\.main\.proxy_/);
  assert.match(report.warnings.join(" "), /missing\.main\.light\.invalid/);
});

test("activities are not staged when Core has not loaded proxy entities", async () => {
  const calls = [];
  const client = {
    async getJson() { return null; },
    async listPaginated() { return []; },
    async configureEntitiesFromIntegration(_integrationId, entityIds) { return { available: entityIds.map((entity_id) => ({ entity_id })), configured: entityIds }; },
    async json(method, path, options = {}) { calls.push({ method, path, json: options.json }); return {}; }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false, proxy_activation_timeout_ms: 100 } };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000004",
    source_node_id: "master",
    source_name: "Master",
    content_hash: "hash4",
    sections: ["entities", "activities"],
    resources: [],
    data: {
      entities: [{ entity_id: "hass.main.light.test", entity_type: "light", name: { en: "Test" } }],
      activities: [{ source_id: "uc.main.activity.source", detail: { name: { en: "Scene" } } }]
    }
  };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, buildProxyCatalog(manifest));
  assert.equal(report.success, false);
  assert.equal(calls.some((call) => call.path === "/activities"), false);
  assert.match(report.errors.join(" "), /activities and pages were not modified|proxy catalog|Core did not configure/i);
});

test("superseded capability proxies are pruned only after dependent activities succeed", async () => {
  const sourceEntity = "receiver.main.media_player.lounge";
  const baseManifest = {
    operation_id: "00000000-0000-4000-8000-000000000010",
    source_node_id: "master", source_name: "Master", content_hash: "old",
    sections: ["entities", "activities"], resources: [],
    data: {
      entities: [{ entity_id: sourceEntity, entity_type: "media_player", name: { en: "Receiver" }, features: ["select_source"] }],
      activities: [{ source_id: "uc.main.activity.music", detail: { name: { en: "Music" }, options: {} }, buttons: [] }]
    }
  };
  const previousCatalog = buildProxyCatalog(baseManifest);
  const manifest = structuredClone(baseManifest);
  manifest.operation_id = "00000000-0000-4000-8000-000000000011";
  manifest.content_hash = "new";
  manifest.data.activities[0].buttons = [{ entity_id: sourceEntity, cmd_id: "media_player.previous" }];
  const catalog = buildProxyCatalog(manifest, previousCatalog);
  assert.notEqual(catalog.entities[0].target_entity_id, previousCatalog.entities[0].target_entity_id);

  const calls = [];
  const configuredIds = new Set([previousCatalog.entities[0].target_entity_id]);
  const client = {
    async getJson() { return null; },
    async listPaginated(path) { return path === "/entities" ? [...configuredIds].map((entity_id) => ({ entity_id })) : []; },
    async configureEntitiesFromIntegration(integrationId, entityIds) {
      for (const entityId of entityIds) configuredIds.add(`${integrationId}.${entityId}`);
      return { available: entityIds.map((entity_id) => ({ entity_id })), configured: entityIds };
    },
    async json(method, path, options = {}) {
      calls.push({ method, path, json: options.json });
      if (method === "POST" && path === "/activities") return { entity_id: "uc.main.activity.child-prune" };
      return {};
    },
    async requestFirst(attempts) {
      const attempt = attempts[0];
      return this.json(attempt.method, attempt.path, attempt.options);
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: true, verify_existing_resource_hashes: false } };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, catalog, previousCatalog);
  assert.equal(report.success, true);
  const oldId = previousCatalog.entities[0].target_entity_id;
  const deleteIndex = calls.findIndex((call) => call.method === "DELETE" && call.path === `/entities/${encodeURIComponent(oldId)}`);
  const activityIndex = calls.findIndex((call) => call.method === "PATCH" && call.path === "/activities/uc.main.activity.child-prune");
  assert.ok(activityIndex >= 0);
  assert.ok(deleteIndex > activityIndex);
});

test("macros are updated directly without activity membership staging", async () => {
  const calls = [];
  const client = {
    async getJson() { return null; },
    async listPaginated() { return []; },
    async configureEntitiesFromIntegration() { return { available: [], configured: [] }; },
    async json(method, path, options = {}) {
      calls.push({ method, path, json: options.json });
      if (method === "POST" && path === "/macros") return { entity_id: "uc.main.macro.child" };
      return {};
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000020", source_node_id: "master", source_name: "Master", content_hash: "macro",
    sections: ["macros"], resources: [], data: { entities: [], macros: [{
      source_id: "uc.main.macro.source",
      detail: { name: { en: "Macro" }, options: { sequence: [] } }
    }] }
  };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, buildProxyCatalog(manifest));
  assert.equal(report.success, true);
  const patches = calls.filter((call) => call.method === "PATCH" && call.path === "/macros/uc.main.macro.child");
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].json.options.sequence, []);
  assert.equal(patches[0].json.options.entity_ids, undefined);
});

test("profiles, pages and groups use Core WebSocket operations and are verified", async () => {
  const calls = [];
  const profiles = new Map([["default", { profile_id: "default", name: { en: "Default" } }]]);
  const pages = [];
  const groups = [];
  const client = {
    async getJson() { return null; },
    async listPaginated() { return []; },
    async configureEntitiesFromIntegration() { return { available: [], configured: [] }; },
    async json() { return {}; },
    async coreMessage(name, data) {
      calls.push({ name, data });
      if (name === "get_profile") {
        if (!profiles.has(data.profile_id)) { const error = new Error("missing"); error.name = "CoreWebSocketError"; error.code = 404; throw error; }
        return profiles.get(data.profile_id);
      }
      if (name === "update_profile") { profiles.set(data.profile_id, { ...data }); return { ...data }; }
      if (name === "delete_pages_in_profile") { pages.length = 0; return {}; }
      if (name === "add_page") { const page = { ...data, page_id: `page-${pages.length + 1}` }; pages.push(page); return page; }
      if (name === "update_page") {
        const index = pages.findIndex((page) => page.page_id === data.page_id);
        pages[index] = { ...pages[index], ...data };
        return pages[index];
      }
      if (name === "get_pages") return { pages: [...pages] };
      if (name === "delete_groups_in_profile") { groups.length = 0; return {}; }
      if (name === "add_group") { const group = { ...data, group_id: `group-${groups.length + 1}` }; groups.push(group); return group; }
      if (name === "get_groups") return { groups: [...groups] };
      if (name === "switch_profile") return {};
      throw new Error(`Unexpected ${name}`);
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000021", source_node_id: "master", source_name: "Master", content_hash: "profiles",
    sections: ["profiles"], resources: [], data: { entities: [], profiles: { items: [{
      source_id: "default",
      detail: { profile_id: "default", name: { en: "Default" } },
      pages: [{ page_id: "source-page", name: { en: "Main" }, image: "profile-bg.jpg", pos: 4, items: [] }],
      groups: [{ group_id: "source-group", name: { en: "Favorites" }, entities: [] }]
    }], active: { profile_id: "default" } } }
  };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, buildProxyCatalog(manifest));
  assert.equal(report.success, true);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].image, "profile-bg.jpg");
  assert.equal(pages[0].pos, 4);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].entities, []);
  assert.ok(calls.findIndex((call) => call.name === "add_group") < calls.findIndex((call) => call.name === "add_page"));
  assert.ok(calls.some((call) => call.name === "switch_profile"));
});

test("invalid profile page entities are reduced without blocking groups", async () => {
  const sourceEntity = "hass.main.light.valid";
  const profiles = new Map([["default", { profile_id: "default", name: { en: "Default" } }]]);
  const pages = [];
  const groups = [];
  let targetEntity = null;
  const client = {
    async getJson() { return null; },
    async listPaginated(path) {
      if (path === "/entities") return targetEntity ? [{ entity_id: targetEntity }] : [];
      return [];
    },
    async configureEntitiesFromIntegration() { return { available: [], configured: [] }; },
    async json() { return {}; },
    async coreMessage(name, data) {
      if (name === "get_profile") return profiles.get(data.profile_id);
      if (name === "update_profile") { profiles.set(data.profile_id, { ...data }); return { ...data }; }
      if (name === "delete_pages_in_profile") { pages.length = 0; return {}; }
      if (name === "add_page") {
        const page = { ...data, page_id: `page-${pages.length + 1}` }; pages.push(page); return page;
      }
      if (name === "update_page") {
        const refs = (data.items || []).map((item) => item.entity_id).filter(Boolean);
        if (refs.includes("uc.main.missing")) {
          const error = new Error('Core WebSocket update_page failed: 400 {"message":"Invalid page entities"}');
          error.name = "CoreWebSocketError";
          error.code = 400;
          throw error;
        }
        const index = pages.findIndex((page) => page.page_id === data.page_id);
        pages[index] = { ...pages[index], ...data };
        return pages[index];
      }
      if (name === "get_pages") return { pages: [...pages] };
      if (name === "delete_groups_in_profile") { groups.length = 0; return {}; }
      if (name === "add_group") { const group = { ...data, group_id: `group-${groups.length + 1}` }; groups.push(group); return group; }
      if (name === "get_groups") return { groups: [...groups] };
      if (name === "switch_profile") return {};
      throw new Error(`Unexpected ${name}`);
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000023", source_node_id: "master", source_name: "Master", content_hash: "profile-fallback",
    sections: ["profiles"], resources: [], data: { entities: [], profiles: { items: [{
      source_id: "default", detail: { profile_id: "default", name: { en: "Default" } },
      pages: [{ page_id: "source-page", name: { en: "Main" }, items: [
        { entity_id: sourceEntity },
        { entity_id: "uc.main.missing" }
      ] }],
      groups: [{ group_id: "source-group", name: { en: "Favorites" }, page_ids: ["source-page"] }]
    }], active: { profile_id: "default" } } }
  };
  manifest.data.entities = [{ entity_id: sourceEntity, entity_type: "light", name: { en: "Valid" }, features: ["on_off"] }];
  const catalog = buildProxyCatalog(manifest);
  targetEntity = catalog.mapping[sourceEntity];
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, catalog);
  assert.equal(report.success, true);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].items.map((item) => item.entity_id), [targetEntity]);
  assert.deepEqual(pages[0].items.map((item) => item.pos), [1]);
  assert.equal(groups.length, 1);
  assert.ok(report.warnings.some((warning) => warning.includes("uc.main.missing")));
});

test("configured docks are activated against the child virtual Dock proxy", async () => {
  const calls = [];
  const docks = new Map();
  const client = {
    async getJson() { return null; },
    async listPaginated() { return []; },
    async configureEntitiesFromIntegration() { return { available: [], configured: [] }; },
    async json() { return {}; },
    async coreMessage(name, data) {
      calls.push({ name, data });
      if (name === "get_docks") return { docks: [...docks.values()] };
      if (name === "create_dock") { docks.set(data.dock_id, { ...data }); return { ...data }; }
      if (name === "get_dock") return docks.get(data.dock_id) || null;
      if (name === "dock_connection_command") return {};
      throw new Error(`Unexpected ${name}`);
    }
  };
  const config = {
    agent_token: "child-agent-token",
    virtual_dock_port: 12083,
    sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false }
  };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000022", source_node_id: "master", source_name: "Master", content_hash: "docks",
    sections: ["docks"], resources: [], data: { entities: [], docks: [{
      source_id: "uc-dock-1", detail: { dock_id: "uc-dock-1", name: "Dock", model: "UCD3", active: true, custom_ws_url: "ws://dock.local:946", state: "CONNECTED" }
    }] }
  };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, buildProxyCatalog(manifest));
  assert.equal(report.success, true);
  assert.equal(docks.get("uc-dock-1").state, undefined);
  assert.equal(docks.get("uc-dock-1").active, true);
  assert.equal(docks.get("uc-dock-1").custom_ws_url, "ws://127.0.0.1:12083/v1/docks/uc-dock-1");
  assert.equal(docks.get("uc-dock-1").token, virtualDockToken("child-agent-token", "master", "uc-dock-1"));
  const dockQueries = calls.filter((call) => call.name === "get_docks");
  assert.deepEqual(dockQueries.map((call) => call.data.filter.active), [true, false]);
  assert.ok(calls.some((call) => call.name === "dock_connection_command" && call.data.cmd === "CONNECT"));
  assert.equal(report.counts.dock_connections_requested, 1);
  assert.equal(report.counts.docks_proxied, 1);
});


test("inactive virtual docks are updated and reconnected instead of recreated", async () => {
  const calls = [];
  const dock = {
    dock_id: "uc-dock-1",
    name: "Old proxy",
    active: false,
    custom_ws_url: "ws://127.0.0.1:11083/v1/docks/uc-dock-1",
    token: "old-token"
  };
  const client = {
    async getJson() { return null; },
    async listPaginated() { return []; },
    async configureEntitiesFromIntegration() { return { available: [], configured: [] }; },
    async json() { return {}; },
    async coreMessage(name, data) {
      calls.push({ name, data });
      if (name === "get_docks") return { docks: data.filter.active ? [] : [dock] };
      if (name === "update_dock") { Object.assign(dock, data); return { ...dock }; }
      if (name === "dock_connection_command") return {};
      if (name === "get_dock") return { ...dock };
      if (name === "create_dock") throw new Error("inactive dock must not be recreated");
      throw new Error(`Unexpected ${name}`);
    }
  };
  const config = {
    agent_token: "child-agent-token",
    virtual_dock_port: 12083,
    sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false }
  };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000025", source_node_id: "master", source_name: "Master", content_hash: "inactive-dock",
    sections: ["docks"], resources: [], data: { entities: [], docks: [{
      source_id: "uc-dock-1", detail: { dock_id: "uc-dock-1", name: "Dock", model: "UCD3", active: true }
    }] }
  };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, buildProxyCatalog(manifest));
  assert.equal(report.success, true);
  assert.equal(calls.filter((call) => call.name === "create_dock").length, 0);
  assert.deepEqual(calls.filter((call) => call.name === "dock_connection_command").map((call) => call.data.cmd), ["DISCONNECT", "CONNECT"]);
  assert.equal(dock.active, true);
  assert.equal(dock.custom_ws_url, "ws://127.0.0.1:12083/v1/docks/uc-dock-1");
  assert.equal(report.counts.docks_updated, 1);
});


test("activity UI replacement removes Core generated blank first pages and preserves page image order", async () => {
  const calls = [];
  const configuredIds = new Set();
  let uiPages = [{ page_id: "old-page", name: { en: "Old" }, items: [{ type: "text", text: "Old" }] }];
  const client = {
    async getJson(path) {
      if (path === "/activities/uc.main.activity.child-ui/ui") return { pages: structuredClone(uiPages) };
      return null;
    },
    async listPaginated(path) { return path === "/entities" ? [...configuredIds].map((entity_id) => ({ entity_id })) : []; },
    async configureEntitiesFromIntegration(integrationId, entityIds) {
      for (const entityId of entityIds) configuredIds.add(`${integrationId}.${entityId}`);
      return { available: entityIds.map((entity_id) => ({ entity_id })), configured: entityIds };
    },
    async json(method, path, options = {}) {
      calls.push({ method, path, json: options.json });
      if (method === "POST" && path === "/activities") return { entity_id: "uc.main.activity.child-ui" };
      if (method === "DELETE" && path === "/activities/uc.main.activity.child-ui/ui/pages/old-page") {
        // Core 0.17.x recreates a default page after deleting the final page.
        uiPages = [{ page_id: "generated-page", name: { en: "New page" }, items: [] }];
        return {};
      }
      if (method === "POST" && path === "/activities/uc.main.activity.child-ui/ui/pages") {
        const page = { page_id: "mirrored-page", ...structuredClone(options.json) };
        uiPages.push(page);
        return page;
      }
      if (method === "DELETE" && path === "/activities/uc.main.activity.child-ui/ui/pages/generated-page") {
        uiPages = uiPages.filter((page) => page.page_id !== "generated-page");
        return {};
      }
      return {};
    }
  };
  const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
  const manifest = {
    operation_id: "00000000-0000-4000-8000-000000000024", source_node_id: "master", source_name: "Master", content_hash: "activity-ui",
    sections: ["activities"], resources: [], data: { entities: [], activities: [{
      source_id: "uc.main.activity.source-ui",
      detail: { name: { en: "UI" }, options: {} },
      ui: { pages: [{ page_id: "source-page", name: { en: "Controls" }, image: "activity-bg.jpg", pos: 1, items: [] }] }
    }] }
  };
  const report = await new SnapshotApplier(client, config, new FakeCache(), new FakeMappings()).apply(manifest, {}, buildProxyCatalog(manifest));
  assert.equal(report.success, true);
  assert.deepEqual(uiPages.map((page) => page.page_id), ["mirrored-page"]);
  assert.equal(uiPages[0].image, "activity-bg.jpg");
  assert.equal(uiPages[0].pos, 1);
  assert.equal(report.counts.activities_blank_pages_removed, 1);
});
