import test from "node:test";
import assert from "node:assert/strict";
import { buildProxyCatalog, proxyEntityId, proxyLocalId } from "../src/proxy/catalog.js";

test("proxy identifiers are deterministic and belong to Remote Sync", () => {
  const first = proxyLocalId("hass.main.light.living_room");
  assert.equal(first, proxyLocalId("hass.main.light.living_room"));
  assert.match(first, /^proxy_[0-9a-f]{24}$/);
  assert.equal(proxyEntityId("hass.main.light.living_room"), `remote_sync.main.${first}`);
});

test("proxy catalog preserves entity metadata and remote UI options", () => {
  const catalog = buildProxyCatalog({
    source_node_id: "master",
    source_name: "Master",
    content_hash: "hash",
    data: {
      entities: [{ entity_id: "hass.main.light.test", entity_type: "light", name: { en: "Test light" }, features: ["on_off", "dim"], attributes: { state: "ON", brightness: 42 } }],
      remotes: [{ source_id: "uc.main.remote.tv", detail: { entity_type: "remote", name: { en: "TV" }, features: ["send_cmd"], simple_commands: ["HOME"] }, buttons: [{ button: "HOME" }], ui: { pages: [{ name: { en: "Main" } }] } }]
    }
  });
  assert.equal(catalog.entities.length, 2);
  const light = catalog.entities.find((item) => item.source_entity_id.includes("light"));
  assert.deepEqual(light.attributes, { state: "ON", brightness: 42 });
  const remote = catalog.entities.find((item) => item.entity_type === "remote");
  assert.deepEqual(remote.options.simple_commands, ["HOME"]);
  assert.equal(remote.options.button_mapping[0].button, "HOME");
  assert.equal(remote.options.user_interface.pages[0].name.en, "Main");
});

test("common Home Assistant helper types are represented by supported proxy types", () => {
  const catalog = buildProxyCatalog({
    source_node_id: "master",
    source_name: "Master",
    content_hash: "hash",
    data: {
      entities: [
        { entity_id: "hass.main.binary_sensor.door", entity_type: "binary_sensor", name: { en: "Door" } },
        { entity_id: "hass.main.input_select.mode", entity_type: "input_select", name: { en: "Mode" } },
        { entity_id: "hass.main.script.movie", entity_type: "script", name: { en: "Movie" } }
      ]
    }
  });
  assert.deepEqual(catalog.entities.map((item) => item.entity_type).sort(), ["button", "select", "sensor"]);
  assert.ok(catalog.activation_hash);
});


test("proxy identity is preserved for display-only changes and revised for capability changes", () => {
  const baseManifest = {
    source_node_id: "master", source_name: "Master", content_hash: "one",
    data: { entities: [{
      entity_id: "receiver.main.media_player.lounge", entity_type: "media_player",
      name: { en: "Receiver" }, features: ["select_source"]
    }] }
  };
  const first = buildProxyCatalog(baseManifest);
  const firstEntity = first.entities[0];

  const renamed = buildProxyCatalog({
    ...baseManifest, content_hash: "two",
    data: { entities: [{ ...baseManifest.data.entities[0], name: { en: "Living-room receiver" } }] }
  }, first);
  assert.equal(renamed.entities[0].local_id, firstEntity.local_id);

  const expanded = buildProxyCatalog({
    ...baseManifest, content_hash: "three",
    data: { entities: [{ ...baseManifest.data.entities[0], features: ["on_off", "previous", "select_source"] }] }
  }, renamed);
  assert.notEqual(expanded.entities[0].local_id, firstEntity.local_id);
  assert.match(expanded.entities[0].local_id, /^proxy_[0-9a-f]{24}_[0-9a-f]{8}$/);
  assert.equal(expanded.mapping[baseManifest.data.entities[0].entity_id], expanded.entities[0].target_entity_id);
});

test("activity commands augment proxy capabilities used for Core validation", () => {
  const sourceEntity = "receiver.main.media_player.lounge";
  const catalog = buildProxyCatalog({
    source_node_id: "master", source_name: "Master", content_hash: "commands",
    data: {
      entities: [{ entity_id: sourceEntity, entity_type: "media_player", name: { en: "Receiver" }, features: ["select_source"] }],
      activities: [{
        source_id: "uc.main.activity.music",
        detail: { name: { en: "Music" }, options: {} },
        buttons: [{ entity_id: sourceEntity, cmd_id: "media_player.previous" }]
      }]
    }
  });
  const proxy = catalog.entities[0];
  assert.deepEqual(new Set(proxy.features), new Set(["select_source", "previous"]));
});
