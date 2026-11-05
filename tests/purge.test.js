import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SatellitePurger } from "../src/apply/purge.js";
import { MappingStore } from "../src/storage/mappings.js";
import { SatelliteManager } from "../src/service/satellite-manager.js";
import { CoreApiError } from "../src/core/client.js";

function tempMappings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-purge-"));
  return new MappingStore(path.join(dir, "id-mappings.json"));
}

function fakeClient({ active = "p-target", profiles = ["p-target", "own-profile"], failing = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    json: async (method, endpoint) => {
      calls.push([method, endpoint]);
      if (failing.has(endpoint)) throw new CoreApiError(409, method, endpoint, {});
      return null;
    },
    getJson: async (endpoint) => (endpoint === "/profiles/active" ? { profile_id: active } : null),
    listPaginated: async () => profiles.map((id) => ({ profile_id: id })),
    coreMessage: async (name, data) => { calls.push([name, data]); return {}; },
    deleteResource: async (type, id) => { calls.push(["DELETE resource", `${type}/${id}`]); return null; }
  };
}

test("purge removes every synchronized object in dependency order and clears the mappings", async () => {
  const mappings = tempMappings();
  mappings.set("primary", "profile", "p-source", "p-target");
  mappings.set("primary", "profile_page:p-source", "page-1", "page-9");
  mappings.set("primary", "activity_group", "g1", "g1-target");
  mappings.set("primary", "activity", "a1", "a1-target");
  mappings.set("primary", "macro", "m1", "m1-target");
  mappings.set("primary", "dock", "dock-1", "dock-1");
  mappings.set("primary", "resource:icon", "tv.png", "tv.png");
  mappings.set("other-primary", "activity", "x", "x-target");
  const client = fakeClient();
  const report = await new SatellitePurger(client, mappings).purge("primary", {
    proxyCatalog: { entities: [{ target_entity_id: "remote_sync.main.proxy_abc" }] },
    resources: [{ type: "background", id: "wall.jpg" }]
  });

  const order = client.calls.map(([method, target]) => `${method} ${typeof target === "string" ? target : JSON.stringify(target)}`);
  assert.deepEqual(order, [
    'switch_profile {"profile_id":"own-profile"}',
    "DELETE /profiles/p-target",
    "DELETE /activity_groups/g1-target",
    "DELETE /activities/a1-target",
    "DELETE /macros/m1-target",
    'delete_dock {"dock_id":"dock-1"}',
    "DELETE /entities/remote_sync.main.proxy_abc",
    "DELETE /entities/remote_sync.main.activity_relay",
    "DELETE resource icon/tv.png",
    "DELETE resource background/wall.jpg"
  ]);
  assert.equal(report.success, true);
  assert.equal(report.remaining, 0);
  assert.equal(report.counts.activities_removed, 1);
  assert.equal(report.counts.resources_removed, 2);
  assert.deepEqual(mappings.kinds("primary"), {});
  assert.deepEqual(mappings.kinds("other-primary"), { activity: { x: "x-target" } }, "objects of another Primary are untouched");
});

test("objects that cannot be deleted stay tracked so removal can be retried", async () => {
  const mappings = tempMappings();
  mappings.set("primary", "activity", "a1", "a1-target");
  mappings.set("primary", "activity", "a2", "a2-target");
  const report = await new SatellitePurger(fakeClient({ failing: new Set(["/activities/a2-target"]) }), mappings).purge("primary");
  assert.equal(report.remaining, 1);
  assert.deepEqual(mappings.items("primary", "activity"), { a2: "a2-target" });
  assert.ok(report.warnings.some((item) => /a2-target/.test(item)));
});

function managerFixture(clientFactory) {
  const previous = process.env.STATE_DIRECTORY;
  process.env.STATE_DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), "rs-manager-"));
  const config = {
    role: "master",
    node_id: "primary",
    sync: {},
    peers: [{ peer_id: "rms-a", name: "Bedroom", enabled: true, token: "t".repeat(32), url: "http://10.0.0.2:11081" }]
  };
  const manager = new SatelliteManager({
    getConfig: () => config,
    store: { save: (value) => value },
    resolvePeer: async (peer) => ({ url: peer.url }),
    syncPeer: async () => ({ success: true }),
    notify: () => {},
    syncedResources: () => [{ type: "icon", id: "tv.png" }],
    clientFactory
  });
  if (previous === undefined) delete process.env.STATE_DIRECTORY; else process.env.STATE_DIRECTORY = previous;
  return { config, manager };
}

test("removing a Satellite deletes its synchronized configuration before unpairing", async () => {
  const calls = [];
  const { config, manager } = managerFixture(() => ({
    capabilities: async () => ({ version: "0.9.0", capabilities: ["purge_on_remove"] }),
    purge: async (payload) => { calls.push(["purge", payload]); return { success: true, removed: 7, remaining: 0 }; },
    unpair: async (payload) => { calls.push(["unpair", payload]); return {}; }
  }));
  const result = await manager.action("rms-a", "remove");
  assert.deepEqual(calls, [
    ["purge", { master_id: "primary", resources: [{ type: "icon", id: "tv.png" }] }],
    ["unpair", { master_id: "primary" }]
  ]);
  assert.equal(result.removed, true);
  assert.equal(result.purge.removed, 7);
  assert.equal(result.warning, null);
  assert.equal(config.peers.length, 0);
});

test("unpairing keeps the synchronized configuration", async () => {
  const calls = [];
  const { manager } = managerFixture(() => ({
    capabilities: async () => ({ version: "0.9.0", capabilities: ["purge_on_remove"] }),
    purge: async () => { calls.push("purge"); return {}; },
    unpair: async () => { calls.push("unpair"); return {}; }
  }));
  await manager.action("rms-a", "unpair");
  assert.deepEqual(calls, ["unpair"]);
});

test("removing an older or unreachable Satellite still removes it and reports what was left", async () => {
  const legacy = managerFixture(() => ({
    capabilities: async () => ({ version: "0.8.0", capabilities: [] }),
    purge: async () => { throw new Error("should not be called"); },
    unpair: async () => ({})
  }));
  const legacyResult = await legacy.manager.action("rms-a", "remove");
  assert.equal(legacy.config.peers.length, 0);
  assert.match(legacyResult.warning, /0\.8\.0/);

  const offline = managerFixture(() => ({
    capabilities: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
    purge: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
    unpair: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }
  }));
  const offlineResult = await offline.manager.action("rms-a", "remove");
  assert.equal(offline.config.peers.length, 0);
  assert.match(offlineResult.warning, /not removed|not reachable/);
});
