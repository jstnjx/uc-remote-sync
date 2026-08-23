import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLiveProxyState,
  liveProxyUpdateFromCoreEvent,
  sanitizeLiveAttributes,
} from "../src/service/live-proxy-state-compatibility.js";

test("media-player entity_change events preserve live metadata", () => {
  const update = liveProxyUpdateFromCoreEvent({
    kind: "event",
    msg: "entity_change",
    msg_data: {
      event_type: "UPDATE",
      entity_id: "spotify.main.media_player.spotify.player",
      entity_type: "media_player",
      state: "PLAYING",
      attributes: {
        media_title: "Test Track",
        media_artist: "Test Artist",
        media_album: "Test Album",
        media_image_url: "https://example.invalid/artwork.jpg",
        media_duration: 241,
        media_position: 17,
        source: "Office",
      },
    },
  });

  assert.deepEqual(update, {
    source_entity_id: "spotify.main.media_player.spotify.player",
    entity_type: "media_player",
    attributes: {
      media_title: "Test Track",
      media_artist: "Test Artist",
      media_album: "Test Album",
      media_image_url: "https://example.invalid/artwork.jpg",
      media_duration: 241,
      media_position: 17,
      source: "Office",
      state: "PLAYING",
    },
  });
});

test("live state extraction ignores Remote Sync feedback and activity state", () => {
  assert.equal(liveProxyUpdateFromCoreEvent({ msg: "entity_change", msg_data: { entity_id: "remote_sync.main.proxy_123", entity_type: "media_player", attributes: { state: "PLAYING" } } }), null);
  assert.equal(liveProxyUpdateFromCoreEvent({ msg: "entity_change", msg_data: { entity_id: "uc.main.activity.spotify", entity_type: "activity", attributes: { state: "ON" } } }), null);
});

test("satellite live state merges metadata into the existing proxy and notifies listeners", () => {
  const saves = [];
  const notifications = [];
  const descriptor = {
    source_entity_id: "spotify.main.media_player.spotify.player",
    target_entity_id: "remote_sync.main.proxy_spotify",
    attributes: { state: "PLAYING", media_title: "Old title", volume: 20 },
  };
  const service = {
    config: { role: "child" },
    proxyCatalog: { entities: [descriptor], updated_at: "old" },
    proxyStore: { save: (catalog) => saves.push(structuredClone(catalog)) },
    proxyListeners: [(catalog) => notifications.push(structuredClone(catalog))],
  };

  const update = {
    source_entity_id: descriptor.source_entity_id,
    source_epoch: "primary-epoch",
    revision: 8,
    attributes: {
      state: "PLAYING",
      media_title: "New title",
      media_artist: "Artist",
      media_image_url: "https://example.invalid/new.jpg",
    },
  };
  const result = applyLiveProxyState(service, update);

  assert.equal(result.success, true);
  assert.equal(result.changed, true);
  assert.equal(descriptor.attributes.media_title, "New title");
  assert.equal(descriptor.attributes.media_artist, "Artist");
  assert.equal(descriptor.attributes.media_image_url, "https://example.invalid/new.jpg");
  assert.equal(descriptor.attributes.volume, 20);
  assert.equal(saves.length, 1);
  assert.equal(notifications.length, 1);

  const stale = applyLiveProxyState(service, { ...update, revision: 7, attributes: { media_title: "Stale title" } });
  assert.equal(stale.ignored_stale, true);
  assert.equal(descriptor.attributes.media_title, "New title");
  assert.equal(saves.length, 1);
});

test("live attribute sanitizer retains bounded nested metadata", () => {
  assert.deepEqual(sanitizeLiveAttributes({
    media_title: "Title",
    numeric: [1, 2, 3],
    nested: { source: { id: "abc", active: true } },
    ignored: undefined,
  }), {
    media_title: "Title",
    numeric: [1, 2, 3],
    nested: { source: { id: "abc", active: true } },
  });
});
