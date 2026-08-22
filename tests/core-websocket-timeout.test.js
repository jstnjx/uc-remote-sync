import assert from "node:assert/strict";
import test from "node:test";

import { coreWebSocketRequestTimeoutMs } from "../src/core/events.js";

test("ordinary Core WebSocket requests keep their requested timeout", () => {
  assert.equal(coreWebSocketRequestTimeoutMs("subscribe_events", {}, 10_000), 10_000);
  assert.equal(coreWebSocketRequestTimeoutMs("get_available_entities", {}, 30_000), 30_000);
});

test("bulk entity configuration gets an adaptive timeout", () => {
  assert.equal(
    coreWebSocketRequestTimeoutMs(
      "configure_entities_from_integration",
      { entity_ids: Array.from({ length: 119 }, (_, index) => `entity-${index}`) },
      60_000,
    ),
    357_500,
  );
});

test("bulk timeout remains bounded and never shortens a larger explicit timeout", () => {
  assert.equal(
    coreWebSocketRequestTimeoutMs(
      "configure_entities_from_integration",
      { entity_ids: [] },
      60_000,
    ),
    180_000,
  );
  assert.equal(
    coreWebSocketRequestTimeoutMs(
      "configure_entities_from_integration",
      { entity_ids: Array.from({ length: 500 }, (_, index) => `entity-${index}`) },
      60_000,
    ),
    600_000,
  );
  assert.equal(
    coreWebSocketRequestTimeoutMs(
      "configure_entities_from_integration",
      { entity_ids: ["one"] },
      420_000,
    ),
    420_000,
  );
});
