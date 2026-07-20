import test from "node:test";
import assert from "node:assert/strict";
import { ActivitySyncManager } from "../src/service/activity-sync.js";

function satelliteManager(initialState = "OFF") {
  let state = initialState;
  const commands = [];
  const manager = new ActivitySyncManager({
    getConfig: () => ({ role: "child", pairing: { paired_master_id: "primary-1" } }),
    getClient: () => ({
      getJson: async (path) => path.startsWith("/entities/") ? { entity_type: "activity", attributes: { state } } : null,
      executeEntityCommand: async (_id, command) => {
        commands.push(command);
        state = command.endsWith(".off") ? "OFF" : "ON";
        return {};
      }
    }),
    getMappings: () => ({ get: () => "uc.main.activity.satellite" }),
    resolvePeerUrl: async () => ({ url: "http://satellite:11081" }),
    forwardProxyCommand: async (_id, command) => ({ success: true, cmd_id: command })
  });
  return { manager, commands, state: () => state, setState: (value) => { state = value; } };
}

test("a Primary OFF update overrides an earlier Satellite ON relay", async () => {
  const fixture = satelliteManager("ON");
  const forwarded = await fixture.manager.forward("uc.main.activity.primary", "on");
  assert.equal(forwarded.success, true);

  const applied = await fixture.manager.apply({
    source_activity_id: "uc.main.activity.primary",
    state: "OFF",
    source_epoch: "primary-epoch",
    revision: 1
  });

  assert.equal(applied.success, true);
  assert.equal(applied.changed, true);
  assert.deepEqual(fixture.commands, ["activity.off"]);
  assert.equal(fixture.state(), "OFF");
});

test("STARTING and STOPPING are treated as matching in-progress states", async () => {
  const starting = satelliteManager("STARTING");
  const on = await starting.manager.apply({ source_activity_id: "a", state: "ON", source_epoch: "e", revision: 1 });
  assert.equal(on.changed, false);
  assert.deepEqual(starting.commands, []);

  const stopping = satelliteManager("STOPPING");
  const off = await stopping.manager.apply({ source_activity_id: "a", state: "OFF", source_epoch: "e", revision: 1 });
  assert.equal(off.changed, false);
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
  assert.deepEqual(fixture.commands, ["activity.off"]);
  assert.equal(fixture.state(), "OFF");
});

test("a new Primary epoch resets activity revision ordering", async () => {
  const fixture = satelliteManager("ON");
  await fixture.manager.apply({ source_activity_id: "a", state: "OFF", source_epoch: "old", revision: 10 });
  const result = await fixture.manager.apply({ source_activity_id: "a", state: "ON", source_epoch: "new", revision: 1 });

  assert.equal(result.changed, true);
  assert.deepEqual(fixture.commands, ["activity.off", "activity.on"]);
  assert.equal(fixture.state(), "ON");
});
