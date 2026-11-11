import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RemoteSyncService } from "../src/service/index.js";
import { SyncCoordinator } from "../src/service/sync-coordinator.js";
import { DriftGuard } from "../src/service/drift-guard.js";

function childService({ appliedChange, intact }) {
  const service = new RemoteSyncService({ load: () => null, save: () => {} });
  service.config = { role: "child", node_id: "child", node_name: "Child", pairing: {}, peers: [], sync: { use_standby_inhibitor: false, prune: false } };
  const writes = [];
  service.client = { async json(method, path) { writes.push(`${method} ${path}`); return {}; }, async listPaginated() { return []; }, async getJson() { return null; } };
  service.proxyCatalog = { schema_version: 2, entities: [], mapping: {}, activation_hash: "a", applied_change_hash: appliedChange };
  service.proxyStore = { save: () => {}, load: () => service.proxyCatalog, clear: () => false };
  service.hardwareProfile = { model: "UCR3" };
  service.driftGuard = { intact: async () => intact, beginApply() {}, endApply() {}, setAppliedSettings() {}, captureFingerprints: async () => ({}) };
  return { service, writes };
}

const manifest = (change) => ({ operation_id: randomUUID(), source_node_id: "master", source_name: "Master", content_hash: randomUUID(), change_hash: change, sections: ["entities"], resources: [], data: { entities: [] } });

test("an automatic push of the configuration a Satellite already holds rewrites nothing", async () => {
  const { service, writes } = childService({ appliedChange: "same", intact: true });
  const report = await service.applyReceived(manifest("same"), {}, { apply_mode: "changes" });
  assert.equal(report.success, true);
  assert.equal(report.unchanged, true);
  assert.deepEqual(writes, []);
});

test("the same configuration is applied again when it was edited locally, when it changed, or when asked to", async () => {
  for (const [appliedChange, intact, mode] of [["same", false, "changes"], ["old", true, "changes"], ["same", true, "full"]]) {
    const { service } = childService({ appliedChange, intact });
    const report = await service.applyReceived(manifest("same"), {}, { apply_mode: mode });
    assert.notEqual(report.unchanged, true, `${appliedChange}/${intact}/${mode}`);
  }
});

test("the drift guard only calls a configuration intact when every fingerprint still matches", async () => {
  const details = { "/activities/a1": { name: "Apple TV" } };
  const guard = new DriftGuard({ getClient: () => ({ getJson: async (p) => structuredClone(details[p] ?? null), listPaginated: async () => [] }), getMappings: () => ({ kinds: () => ({ activity: { s: "a1" } }) }), getSourceNode: () => "m", report: async () => true });
  assert.equal(await guard.intact(), false, "no fingerprints yet");
  await guard.captureFingerprints();
  assert.equal(await guard.intact(), true);
  details["/activities/a1"].name = "Edited";
  assert.equal(await guard.intact(), false);
});

test("an automatic synchronization never wakes a sleeping Satellite", async () => {
  const coordinator = new SyncCoordinator({ getConfig: () => ({ remote: {}, peers: [] }), getClient: () => null, getStatus: () => ({}), discovery: { clear() {}, resolve: async () => { throw new Error("not found"); } }, setDockCatalog: () => {}, initializeActivityStates: async () => {} });
  let posts = 0;
  coordinator.postSnapshot = async () => { posts += 1; throw Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" }); };
  const result = await coordinator.pushSnapshot({ peer_id: "p", name: "Sat", mac: "aa:bb:cc:dd:ee:ff", url: "http://10.0.0.2:11081" }, Buffer.from("x"), { wake: false });
  assert.equal(result.success, false);
  assert.equal(result.asleep, true);
  assert.equal(result.wowlan_sent, false);
  assert.equal(posts, 1);
});
