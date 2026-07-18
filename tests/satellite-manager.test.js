import assert from "node:assert/strict";
import test from "node:test";
import { SatelliteManager } from "../src/service/satellite-manager.js";

function fixture() {
  const config = {
    role: "master",
    node_id: "primary",
    peers: [{
      peer_id: "rms-abcdefgh",
      identifier: "RMS-ABCD-EFGH",
      name: "Bedroom",
      enabled: true,
      url: "http://10.1.1.102:11081",
      token: "t".repeat(32),
      command_token: "c".repeat(32),
      mac: "fc:84:a7:66:ae:14",
      broadcasts: ["10.1.1.255"]
    }]
  };
  const saved = [];
  const syncCalls = [];
  const manager = new SatelliteManager({
    getConfig: () => config,
    store: { save: (value) => { saved.push(structuredClone(value)); return value; } },
    resolvePeer: async (peer) => ({ url: peer.url }),
    syncPeer: async (peer, force) => { syncCalls.push({ peer: peer.peer_id, force }); return { success: true }; },
    notify: () => {}
  });
  return { config, saved, syncCalls, manager };
}

test("Satellite management can synchronize and toggle one peer", async () => {
  const { config, saved, syncCalls, manager } = fixture();
  assert.deepEqual(await manager.action("rms-abcdefgh", "sync"), { success: true });
  assert.deepEqual(syncCalls, [{ peer: "rms-abcdefgh", force: true }]);
  assert.equal((await manager.action("rms-abcdefgh", "disable")).enabled, false);
  assert.equal(config.peers[0].enabled, false);
  assert.equal(saved.length, 1);
  assert.equal((await manager.action("rms-abcdefgh", "enable")).enabled, true);
});

test("Satellite runtime state is exposed without secrets", () => {
  const { manager } = fixture();
  manager.record("rms-abcdefgh", { online: true, version: "0.7.0", mirrored_entities: 42, dock_tunnels: 2 });
  const [satellite] = manager.list();
  assert.equal(satellite.online, true);
  assert.equal(satellite.version, "0.7.0");
  assert.equal(satellite.mirrored_entities, 42);
  assert.equal(satellite.dock_tunnels, 2);
  assert.equal(satellite.token, undefined);
  assert.equal(satellite.command_token, undefined);
});
