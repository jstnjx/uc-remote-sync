import assert from "node:assert/strict";
import test from "node:test";
import { buildApplyPreview } from "../src/apply/preview.js";

test("synchronization preview estimates create, update and prune operations", () => {
  const manifest = {
    operation_id: "preview-operation",
    source_node_id: "primary",
    source_name: "Primary",
    sections: ["entities", "activities"],
    data: {
      entities: [{ entity_id: "hass.main.light.new" }],
      activities: [{ source_id: "uc.main.activity.existing" }]
    }
  };
  const mappings = {
    get(source, kind, id) {
      return source === "primary" && kind === "activity" && id === "uc.main.activity.existing" ? "uc.main.activity.target" : null;
    },
    items(source, kind) {
      if (source !== "primary") return {};
      if (kind === "entity") return { "hass.main.light.old": "remote_sync.main.proxy_old" };
      if (kind === "activity") return { "uc.main.activity.existing": "uc.main.activity.target", "uc.main.activity.removed": "uc.main.activity.removed-target" };
      return {};
    }
  };
  const preview = buildApplyPreview(manifest, { sync: { prune: true } }, mappings, {
    entities: [{ source_entity_id: "hass.main.light.old" }]
  });
  assert.equal(preview.dry_run, true);
  assert.equal(preview.sections.entities.create, 1);
  assert.ok(preview.sections.entities.remove >= 1);
  assert.equal(preview.sections.activities.update, 1);
  assert.equal(preview.sections.activities.remove, 1);
  assert.match(preview.summary, /^Create \d+, update \d+, remove \d+$/);
});
