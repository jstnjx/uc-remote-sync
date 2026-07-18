import test from "node:test";
import assert from "node:assert/strict";
import { SnapshotBuilder, SnapshotReader } from "../src/protocol/snapshot.js";

class FakeClient {
  async version() { return { hostname: "master" }; }
  async integrations() { return [{ integration_id: "hass.main", state: "CONNECTED" }]; }
  async reloadAvailableEntities() { return [{ entity_id: "light.test", entity_type: "light", features: ["on_off"] }]; }
  async listPaginated(path) {
    if (path === "/entities") return [{ entity_id: "hass.main.light.test", integration_id: "hass.main" }];
    if (path === "/resources/Icon") return [{ id: "test.png", size: 3 }];
    return [];
  }
  async getJson(path) {
    if (path === "/resources") return [{ type: "Icon" }];
    if (path.startsWith("/entities/")) return { entity_id: "hass.main.light.test", integration_id: "hass.main", name: { en: "Test" } };
    if (path === "/profiles") return [];
    return null;
  }
  async bytes() { return Buffer.from("abc"); }
}

const config = {
  node_id: "master",
  node_name: "Master",
  sync: { sections: ["resources", "entities"], verify_existing_resource_hashes: false }
};

test("snapshot round-trip validates manifest and resources", async () => {
  const archive = await new SnapshotBuilder(new FakeClient(), config).build();
  const decoded = await SnapshotReader.read(archive.payload);
  assert.equal(decoded.manifest.source_node_id, "master");
  assert.equal(decoded.resources["resources/Icon/test.png"].toString(), "abc");
  assert.deepEqual(decoded.manifest.required_integrations, ["hass.main"]);
});

test("snapshot expands activity and profile page overviews to full page definitions", async () => {
  class PageClient {
    async version() { return { api: "0.17.6" }; }
    async integrations() { return []; }
    async listPaginated(path) {
      if (path === "/entities") return [];
      if (path === "/activities") return [{ entity_id: "uc.main.activity.test" }];
      return [];
    }
    async getJson(path) {
      const values = {
        "/activities/uc.main.activity.test": { entity_id: "uc.main.activity.test", name: { en: "Test" }, options: {} },
        "/activities/uc.main.activity.test/ui": { pages: [{ page_id: "activity-page", name: { en: "Main" } }] },
        "/activities/uc.main.activity.test/ui/pages/activity-page": { page_id: "activity-page", name: { en: "Main" }, image: "activity-bg.jpg", pos: 2, items: [{ entity_id: "hass.main.light.test" }] },
        "/activities/uc.main.activity.test/buttons": [],
        "/profiles": [{ profile_id: "default" }],
        "/profiles/default": { profile_id: "default", name: { en: "Default" } },
        "/profiles/default/pages": [{ page_id: "profile-page", name: { en: "Home" } }],
        "/profiles/default/pages/profile-page": { page_id: "profile-page", name: { en: "Home" }, image: "profile-bg.jpg", pos: 3, items: [{ entity_id: "hass.main.light.test" }] },
        "/profiles/default/groups": []
      };
      return values[path] ?? null;
    }
  }
  const archive = await new SnapshotBuilder(new PageClient(), {
    node_id: "master", node_name: "Master", sync: { sections: ["activities", "profiles"], verify_existing_resource_hashes: false }
  }).build();
  assert.equal(archive.manifest.data.activities[0].ui.pages[0].items[0].entity_id, "hass.main.light.test");
  assert.equal(archive.manifest.data.activities[0].ui.pages[0].image, "activity-bg.jpg");
  assert.equal(archive.manifest.data.activities[0].ui.pages[0].pos, 2);
  assert.equal(archive.manifest.data.profiles.items[0].pages[0].items[0].entity_id, "hass.main.light.test");
  assert.equal(archive.manifest.data.profiles.items[0].pages[0].image, "profile-bg.jpg");
  assert.equal(archive.manifest.data.profiles.items[0].pages[0].pos, 3);
});


test("snapshot discovers remote entities through hydrated configured entities", async () => {
  class RemoteClient {
    async version() { return { api: "0.17.6" }; }
    async integrations() { return []; }
    async listPaginated(path) {
      if (path === "/remotes") return [];
      if (path === "/entities") return [{ entity_id: "uc.main.8f5d-remote" }];
      return [];
    }
    async getJson(path) {
      if (path === "/entities/uc.main.8f5d-remote") return {
        entity_id: "uc.main.8f5d-remote",
        entity_type: "remote",
        name: { en: "Television remote" },
        features: ["send_cmd"],
        attributes: { state: "ON" },
        options: {
          simple_commands: ["HOME", "CURSOR_UP"],
          button_mapping: [{ button: "HOME", short_press: { cmd_id: "HOME" } }],
          user_interface: { pages: [{ page_id: "main", name: { en: "Main" }, items: [{ type: "text", text: "Home", command: { cmd_id: "HOME" } }] }] }
        }
      };
      return null;
    }
  }
  const archive = await new SnapshotBuilder(new RemoteClient(), {
    node_id: "master", node_name: "Master", sync: { sections: ["remotes"], verify_existing_resource_hashes: false }
  }).build();
  assert.equal(archive.manifest.data.remotes.length, 1);
  const remote = archive.manifest.data.remotes[0];
  assert.equal(remote.source_id, "uc.main.8f5d-remote");
  assert.deepEqual(remote.buttons, [{ button: "HOME", short_press: { cmd_id: "HOME" } }]);
  assert.equal(remote.ui.pages[0].items[0].command.cmd_id, "HOME");
});


test("snapshot replaces configured feature subsets with full available-entity capabilities", async () => {
  class CapabilityClient {
    async version() { return { api: "0.17.6" }; }
    async integrations() { return [{ integration_id: "receiver.main", state: "CONNECTED" }]; }
    async listPaginated(path) {
      if (path === "/entities") return [{ entity_id: "receiver.main.media_player.lounge", integration_id: "receiver.main" }];
      return [];
    }
    async getJson(path) {
      if (path.startsWith("/entities/")) return {
        entity_id: "receiver.main.media_player.lounge",
        integration_id: "receiver.main",
        entity_type: "media_player",
        name: { en: "Receiver" },
        features: ["select_source"],
        attributes: { state: "ON", source: "TV" }
      };
      return null;
    }
    async reloadAvailableEntities(integrationId, options) {
      assert.equal(integrationId, "receiver.main");
      assert.deepEqual(options.requiredEntityIds, ["media_player.lounge"]);
      return [{
        entity_id: "media_player.lounge",
        entity_type: "media_player",
        features: ["on_off", "previous", "next", "select_source"],
        options: { simple_commands: ["ZONE_2"] },
        device_class: "receiver"
      }];
    }
  }

  const archive = await new SnapshotBuilder(new CapabilityClient(), {
    node_id: "master", node_name: "Master", sync: { sections: ["entities"], verify_existing_resource_hashes: false }
  }).build();
  const entity = archive.manifest.data.entities[0];
  assert.equal(entity.entity_id, "receiver.main.media_player.lounge");
  assert.deepEqual(entity.features, ["on_off", "previous", "next", "select_source"]);
  assert.deepEqual(entity.options.simple_commands, ["ZONE_2"]);
  assert.equal(entity.device_class, "receiver");
  assert.deepEqual(entity.attributes, { state: "ON", source: "TV" });
});

test("snapshot discovers macros through configured entities when /macros is empty", async () => {
  class MacroClient {
    async version() { return { api: "0.17.6" }; }
    async integrations() { return []; }
    async listPaginated(path) {
      if (path === "/macros") return [];
      if (path === "/entities") return [{ entity_id: "uc.main.macro.test", name: { en: "Test macro" } }];
      return [];
    }
    async getJson(path) {
      if (path === "/entities/uc.main.macro.test") return {
        entity_id: "uc.main.macro.test",
        entity_type: "macro",
        name: { en: "Test macro" },
        options: { sequence: [] }
      };
      return null;
    }
  }
  const archive = await new SnapshotBuilder(new MacroClient(), {
    node_id: "master", node_name: "Master", sync: { sections: ["macros"], verify_existing_resource_hashes: false }
  }).build();
  assert.equal(archive.manifest.data.macros.length, 1);
  assert.equal(archive.manifest.data.macros[0].source_id, "uc.main.macro.test");
  assert.deepEqual(archive.manifest.data.macros[0].detail.options.sequence, []);
});

test("snapshot includes configured docks through Core WebSocket", async () => {
  class DockClient {
    async version() { return { api: "0.17.6" }; }
    async integrations() { return []; }
    async coreMessage(name, data) {
      if (name === "get_docks") return { docks: [{ dock_id: "uc-dock-1", name: "Living room" }] };
      if (name === "get_dock") {
        assert.equal(data.dock_id, "uc-dock-1");
        return { dock_id: "uc-dock-1", name: "Living room", model: "UCD3", active: true, custom_ws_url: "ws://dock.local:946" };
      }
      throw new Error(`Unexpected message ${name}`);
    }
  }
  const archive = await new SnapshotBuilder(new DockClient(), {
    node_id: "master", node_name: "Master", sync: { sections: ["docks"], verify_existing_resource_hashes: false }
  }).build();
  assert.equal(archive.manifest.data.docks.length, 1);
  assert.equal(archive.manifest.data.docks[0].detail.custom_ws_url, "ws://dock.local:946");
});

test("snapshot reader accepts v0.4.x schema 4 during rolling updates", async () => {
  const data = { entities: [] };
  const resources = [];
  const required_integrations = [];
  const { gzipSync } = await import("node:zlib");
  const { canonicalJson, sha256Bytes } = await import("../src/shared/util.js");
  const manifest = {
    schema_version: 4,
    operation_id: "00000000-0000-4000-8000-000000000030",
    source_node_id: "master",
    source_name: "Master",
    sections: ["entities"],
    data,
    resources,
    required_integrations,
    content_hash: sha256Bytes(canonicalJson({ data, resources, required_integrations }))
  };
  const payload = gzipSync(Buffer.from(JSON.stringify({ format: "uc-remote-sync-gzip-json-v1", manifest, resources: {} })));
  const decoded = await SnapshotReader.read(payload);
  assert.equal(decoded.manifest.schema_version, 4);
});
