import test from "node:test";
import assert from "node:assert/strict";
import { SnapshotApplier } from "../src/apply/index.js";
import { CoreApiError } from "../src/core/client.js";

// A Satellite Core that keeps activity groups like the real one: GET /activity_groups returns an overview without
// members, the detail lists `activities`, PATCH/POST take `activity_ids`, and an activity may only be in one group.
function satelliteCore(groups) {
  const calls = [];
  const detail = (id) => ({ group_id: id, name: groups[id].name, options: {}, activities: groups[id].activity_ids.map((entity_id) => ({ entity_id, name: { en: entity_id } })) });
  return {
    groups, calls,
    async listPaginated(path) {
      if (path === "/activity_groups") return Object.keys(groups).map((id) => ({ group_id: id, name: groups[id].name, activity_count: groups[id].activity_ids.length }));
      return [];
    },
    async getJson(path) {
      const match = /^\/activity_groups\/(.+)$/.exec(path);
      if (match) { const id = decodeURIComponent(match[1]); return groups[id] ? detail(id) : null; }
      return null;
    },
    async json(method, path, { json } = {}) {
      calls.push({ method, path, json });
      if (method === "GET") return this.getJson(path);
      if (method === "POST" && path === "/activity_groups") {
        const id = `sat-group-${Object.keys(groups).length + 1}`;
        groups[id] = { name: json.name, activity_ids: [] };
        if (json.activity_ids?.length) this.assign(id, json.activity_ids);
        return detail(id);
      }
      const match = /^\/activity_groups\/(.+)$/.exec(path);
      if (method === "PATCH" && match) {
        const id = decodeURIComponent(match[1]);
        if (json.name) groups[id].name = json.name;
        if (json.activity_ids) this.assign(id, json.activity_ids);
        return detail(id);
      }
      throw new CoreApiError(404, method, path);
    },
    assign(id, activityIds) {
      for (const activityId of activityIds) {
        const other = Object.keys(groups).find((groupId) => groupId !== id && groups[groupId].activity_ids.includes(activityId));
        if (other) throw new CoreApiError(400, "PATCH", `/activity_groups/${id}`, { code: "BAD_REQUEST", message: `${activityId} is already in ${other}` });
      }
      groups[id].activity_ids = [...activityIds];
    }
  };
}

function mappings(initial) {
  const data = { ...initial };
  return {
    get: (node, kind, id) => data[`${node}|${kind}|${id}`] || null,
    set: (node, kind, id, target) => { data[`${node}|${kind}|${id}`] = target; },
    items: () => ({}),
    save() {}
  };
}

const primaryGroups = [
  { group_id: "src-wohn", name: { en: "Wohnzimmer" }, options: {}, activity_ids: ["src-appletv-wohn", "src-vinyl"] },
  { group_id: "src-schlaf", name: { en: "Schlafzimmer" }, options: {}, activity_ids: ["src-appletv-schlaf"] }
];

const activityMappings = {
  "primary|activity|src-appletv-wohn": "sat-appletv-wohn",
  "primary|activity|src-vinyl": "sat-vinyl",
  "primary|activity|src-appletv-schlaf": "sat-appletv-schlaf"
};

async function apply(core, store, groups = primaryGroups) {
  const applier = new SnapshotApplier(core, { sync: { use_standby_inhibitor: false, prune: false } }, { get: () => null, put() {} }, store);
  return applier.apply({ operation_id: `op-${Math.random()}`, source_node_id: "primary", sections: ["activity_groups"], data: { activity_groups: groups } }, [], { entities: [], mapping: {} });
}

test("two activities with the same name end up in their own groups, as on the Primary", async () => {
  const core = satelliteCore({});
  const report = await apply(core, mappings(activityMappings));
  assert.deepEqual(report.errors, []);
  const byName = Object.fromEntries(Object.values(core.groups).map((group) => [group.name.en, group.activity_ids]));
  assert.deepEqual(byName, { Wohnzimmer: ["sat-appletv-wohn", "sat-vinyl"], Schlafzimmer: ["sat-appletv-schlaf"] });
});

test("a Satellite where everything landed in one group is repaired, even though an activity may only be in one group", async () => {
  // The state from the report: all activities in Wohnzimmer, Schlafzimmer empty.
  const core = satelliteCore({
    "sat-wohn": { name: { en: "Wohnzimmer" }, activity_ids: ["sat-appletv-wohn", "sat-vinyl", "sat-appletv-schlaf"] },
    "sat-schlaf": { name: { en: "Schlafzimmer" }, activity_ids: [] }
  });
  const store = mappings({ ...activityMappings, "primary|activity_group|src-wohn": "sat-wohn", "primary|activity_group|src-schlaf": "sat-schlaf" });
  const report = await apply(core, store);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(core.groups["sat-wohn"].activity_ids, ["sat-appletv-wohn", "sat-vinyl"]);
  assert.deepEqual(core.groups["sat-schlaf"].activity_ids, ["sat-appletv-schlaf"]);
  assert.equal(report.counts.activity_group_members_moved, 1);
});

test("synchronized activities are taken out of groups that only exist on the Satellite; its own activities stay there", async () => {
  const core = satelliteCore({
    "sat-local": { name: { en: "Kinderzimmer" }, activity_ids: ["sat-appletv-schlaf", "sat-local-only"] }
  });
  await apply(core, mappings(activityMappings));
  assert.deepEqual(core.groups["sat-local"].activity_ids, ["sat-local-only"]);
  const schlaf = Object.values(core.groups).find((group) => group.name.en === "Schlafzimmer");
  assert.deepEqual(schlaf.activity_ids, ["sat-appletv-schlaf"]);
});

test("membership is never sent in the read-only display format", async () => {
  const core = satelliteCore({});
  await apply(core, mappings(activityMappings), [{ group_id: "src-schlaf", name: { en: "Schlafzimmer" }, options: {}, activities: [{ entity_id: "src-appletv-schlaf", name: { en: "Apple TV" }, state: "OFF" }] }]);
  assert.equal(core.calls.some((call) => call.json && "activities" in call.json), false);
  const schlaf = Object.values(core.groups).find((group) => group.name.en === "Schlafzimmer");
  assert.deepEqual(schlaf.activity_ids, ["sat-appletv-schlaf"]);
});

test("when the Primary's membership is unknown (older Primary), the Satellite's membership is left as it is", async () => {
  const core = satelliteCore({ "sat-wohn": { name: { en: "Wohnzimmer" }, activity_ids: ["sat-vinyl"] } });
  const store = mappings({ ...activityMappings, "primary|activity_group|src-wohn": "sat-wohn" });
  const report = await apply(core, store, [{ group_id: "src-wohn", name: { en: "Wohnzimmer" }, activity_count: 2 }]);
  assert.deepEqual(core.groups["sat-wohn"].activity_ids, ["sat-vinyl"]);
  assert.ok(report.warnings.some((item) => /membership unknown/.test(item)));
});

test("activities that are not synchronized are left out of a group and reported", async () => {
  const core = satelliteCore({});
  const report = await apply(core, mappings({ "primary|activity|src-vinyl": "sat-vinyl" }), [{ group_id: "src-wohn", name: { en: "Wohnzimmer" }, options: {}, activity_ids: ["src-vinyl", "src-unknown"] }]);
  const wohn = Object.values(core.groups).find((group) => group.name.en === "Wohnzimmer");
  assert.deepEqual(wohn.activity_ids, ["sat-vinyl"]);
  assert.ok(report.warnings.some((item) => /not synchronized/.test(item)));
});

test("the Primary's snapshot carries each group's members, read from the group details", async () => {
  const { SnapshotBuilder } = await import("../src/protocol/snapshot.js");
  const client = {
    async version() { return { api: "0.21.0", model: "UCR3" }; },
    async integrations() { return []; },
    async listPaginated(path) { return path === "/activity_groups" ? [{ group_id: "g1", name: { en: "Wohnzimmer" }, activity_count: 1 }, { group_id: "g2", name: { en: "Schlafzimmer" }, activity_count: 1 }] : []; },
    async getJson(path) {
      if (path === "/activity_groups/g1") return { group_id: "g1", name: { en: "Wohnzimmer" }, options: {}, activities: [{ entity_id: "uc.main.appletv-1", name: { en: "Apple TV" }, state: "ON" }] };
      if (path === "/activity_groups/g2") return { group_id: "g2", name: { en: "Schlafzimmer" }, options: {}, activities: [{ entity_id: "uc.main.appletv-2", name: { en: "Apple TV" }, state: "OFF" }] };
      return null;
    }
  };
  const { manifest } = await new SnapshotBuilder(client, { node_id: "m", node_name: "M", sync: { sections: ["activity_groups"] } }).build();
  assert.deepEqual(manifest.data.activity_groups.map((group) => [group.name.en, group.activity_ids]), [["Wohnzimmer", ["uc.main.appletv-1"]], ["Schlafzimmer", ["uc.main.appletv-2"]]]);
});
