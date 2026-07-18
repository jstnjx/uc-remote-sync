import test from "node:test";
import assert from "node:assert/strict";
import { EntityManager } from "../src/integration/entities.js";
import { IntegrationAPI, StatusCodes } from "../src/integration/api.js";

class FakeService {
  constructor() {
    this.status = { state: "connected", last_sync_at: null, last_sync_result: "ok", pending_changes: false };
    this.config = { role: "child", pairing_identifier: "RMS-ABCD-EFGH", peers: [] };
    this.agentUrl = "http://child:11081";
    this.proxyCatalog = { entities: [] };
    this.commands = [];
  }
  addStatusListener(listener) { this.statusListener = listener; }
  addProxyListener(listener) { this.proxyListener = listener; }
  async syncNow() { return { success: false }; }
  async reconcile() { return { success: true }; }
  async forwardProxyCommand(sourceEntityId, cmdId, params) { this.commands.push({ sourceEntityId, cmdId, params }); return { success: true }; }
  async forwardActivityCommand(sourceActivityId, action) { this.activityCommand = { sourceActivityId, action }; return { success: true }; }
}

test("child proxy entity forwards commands to its source master entity", async () => {
  const api = new IntegrationAPI();
  const service = new FakeService();
  const manager = new EntityManager(api, service);
  manager.register();
  service.proxyListener({ entities: [{ local_id: "proxy_123", target_entity_id: "remote_sync.main.proxy_123", source_entity_id: "hass.main.light.test", entity_type: "light", name: { en: "Test" }, features: ["on_off"], attributes: { state: "OFF" } }] });
  const entity = api.getAvailableEntities().getEntity("proxy_123");
  assert.ok(entity);
  assert.equal(await entity.command("light.on", { brightness: 80 }), StatusCodes.Ok);
  assert.deepEqual(service.commands, [{ sourceEntityId: "hass.main.light.test", cmdId: "light.on", params: { brightness: 80 } }]);
});

test("persisted proxy catalog is exposed before Core requests available entities", () => {
  const api = new IntegrationAPI();
  const service = new FakeService();
  service.proxyCatalog = {
    entities: [{ local_id: "proxy_boot", target_entity_id: "remote_sync.main.proxy_boot", source_entity_id: "hass.main.sensor.boot", entity_type: "sensor", name: { en: "Boot sensor" }, attributes: { state: "ON", value: "ready" } }]
  };
  const manager = new EntityManager(api, service);
  manager.register();
  assert.ok(api.getAvailableEntities().getEntity("proxy_boot"));
});


test("activity relay entity forwards on and off commands to the master activity", async () => {
  const api = new IntegrationAPI();
  const service = new FakeService();
  const manager = new EntityManager(api, service);
  manager.register();
  const relay = api.getAvailableEntities().getEntity("activity_relay");
  assert.ok(relay);
  assert.equal(await relay.command("button.push", { source_activity_id: "uc.main.activity.source", action: "on" }), StatusCodes.Ok);
  assert.deepEqual(service.activityCommand, { sourceActivityId: "uc.main.activity.source", action: "on" });
});
