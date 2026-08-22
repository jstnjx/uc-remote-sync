import test from "node:test";
import assert from "node:assert/strict";
import { ActivitySyncManager } from "../src/service/activity-sync.js";

function satelliteManager(initialState = "OFF", { passiveUpdateFails = false } = {}) {
  let state = initialState;
  const commands = [];
  const passiveUpdates = [];
  const forwarded = [];
  const manager = new ActivitySyncManager({
    getConfig: () => ({ role: "child", pairing: { paired_master_id: "primary-1" } }),
    getClient: () => ({
      getJson: async (path) => path.startsWith("/entities/") || path.startsWith("/activities/")
        ? { entity_type: "activity", state, attributes: { state } }
        : null,
      json: async (method, path, options = {}) => {
        assert.equal(method, "PATCH");
        assert.match(path, /^\/activities\//);
        if (passiveUpdateFails) throw Object.assign(new Error("passive state update unsupported"), { status: 422 });
        const next = String(options.json?.attributes?.state || "");
        passiveUpdates.push(next);
        state = next;
        return { entity_type: "activity", state, attributes: { state } };
      },
      executeEntityCommand: async (_id, command) => {
        commands.push(command);
        throw new Error("activity commands must never be used for state reconciliation");
      }
    }),
    getMappings: () => ({ get: () => "uc.main.activity.satellite" }),
    resolvePeerUrl: async () => ({ url: "http://satellite:11081" }),
    forwardProxyCommand: async (_id, command) => {
      forwarded.push(command);
      return { success: true, cmd_id: command };
    }
  });
  return {
    manager,
    commands,
    passiveUpdates,
    forwarded,
    state: () => state,
    setState: (value) => { state = value; }
  };
}

test("a Primary OFF update passively overrides stale Satellite ON state", async () => {
  const fixture = satelliteManager("ON");
  const applied = await fixture.manager.apply({
    source_activity_id: "uc.main.activity.primary",
    state: "OFF",
    source_epoch: "primary-epoch",
    revision: 1
  });

  assert.equal(applied.success, true);
  assert.equal(applied.changed, true);
  assert.equal(applied.passive, true);
  assert.deepEqual(fixture.passiveUpdates, ["OFF"]);
  assert.deepEqual(fixture.commands, []);
  assert.deepEqual(fixture.forwarded, []);
  assert.equal(fixture.state(), "OFF");
});

test("opposite Spotify and Apple TV states converge to Primary without executing either activity", async () => {
  const spotify = satelliteManager("OFF");
  const appleTv = satelliteManager("ON");

  const [spotifyResult, appleResult] = await Promise.all([
    spotify.manager.apply({ source_activity_id: "spotify", state: "ON", source_epoch: "primary", revision: 1 }),
    appleTv.manager.apply({ source_activity_id: "apple-tv", state: "OFF", source_epoch: "primary", revision: 1 })
  ]);

  assert.equal(spotifyResult.success, true);
  assert.equal(appleResult.success, true);
  assert.equal(spotify.state(), "ON");
  assert.equal(appleTv.state(), "OFF");
  assert.deepEqual(spotify.passiveUpdates, ["ON"]);
  assert.deepEqual(appleTv.passiveUpdates, ["OFF"]);
  assert.deepEqual([...spotify.commands, ...appleTv.commands], []);
  assert.deepEqual([...spotify.forwarded, ...appleTv.forwarded], []);
});

test("STARTING and STOPPING are treated as matching in-progress states", async () => {
  const starting = satelliteManager("STARTING");
  const on = await starting.manager.apply({ source_activity_id: "a", state: "ON", source_epoch: "e", revision: 1 });
  assert.equal(on.changed, false);
  assert.deepEqual(starting.passiveUpdates, []);
  assert.deepEqual(starting.commands, []);

  const stopping = satelliteManager("STOPPING");
  const off = await stopping.manager.apply({ source_activity_id: "a", state: "OFF", source_epoch: "e", revision: 1 });
  assert.equal(off.changed, false);
  assert.deepEqual(stopping.passiveUpdates, []);
  assert.deepEqual(stopping.commands, []);
});

test("older activity state revisions cannot overwrite newer Primary state", async () => {
  const fixture = satelliteManager("ON");
  const newer = await fixture.manager.apply({
    source_activity_id: "a",
    state: "OFF",
    source_epoch: "epoch-1",
    revision: 2
  });
  const older = await fixture.manager.apply({
    source_activity_id: "a",
    state: "ON",
    source_epoch: "epoch-1",
    revision: 1
  });

  assert.equal(newer.changed, true);
  assert.equal(older.ignored_stale, true);
  assert.deepEqual(fixture.passiveUpdates, ["OFF"]);
  assert.deepEqual(fixture.commands, []);
  assert.equal(fixture.state(), "OFF");
});

test("a new Primary epoch resets activity revision ordering", async () => {
  const fixture = satelliteManager("ON");
  await fixture.manager.apply({ source_activity_id: "a", state: "OFF", source_epoch: "old", revision: 10 });
  const result = await fixture.manager.apply({ source_activity_id: "a", state: "ON", source_epoch: "new", revision: 1 });

  assert.equal(result.changed, true);
  assert.deepEqual(fixture.passiveUpdates, ["OFF", "ON"]);
  assert.deepEqual(fixture.commands, []);
  assert.equal(fixture.state(), "ON");
});

test("passive state failure is safe and never falls back to activity execution", async () => {
  const fixture = satelliteManager("ON", { passiveUpdateFails: true });
  const result = await fixture.manager.apply({
    source_activity_id: "a",
    state: "OFF",
    source_epoch: "primary",
    revision: 1
  });

  assert.equal(result.success, false);
  assert.equal(result.safe_failure, true);
  assert.equal(result.status, 422);
  assert.match(result.error, /Refusing to execute activity\.off/);
  assert.deepEqual(fixture.commands, []);
  assert.deepEqual(fixture.forwarded, []);
  assert.equal(fixture.state(), "ON");
});
