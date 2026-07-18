import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { IntegrationAPI, Sensor, SensorStates, SensorAttributes, DriverSetupRequest, UserDataResponse, RequestUserInput, DeviceStates } from "../src/integration/api.js";
import { connectWebSocket } from "../src/transport/websocket.js";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function waitFor(messages, predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Message timeout: ${JSON.stringify(messages)}`);
}

test("dependency-free Integration API serves metadata, entities and setup", async () => {
  const port = await freePort();
  const oldPort = process.env.UC_INTEGRATION_HTTP_PORT;
  const oldMdns = process.env.UC_DISABLE_MDNS_PUBLISH;
  process.env.UC_INTEGRATION_HTTP_PORT = String(port);
  process.env.UC_DISABLE_MDNS_PUBLISH = "true";
  const api = new IntegrationAPI();
  api.addAvailableEntity(new Sensor("status", { en: "Status" }, { attributes: { [SensorAttributes.State]: SensorStates.On, [SensorAttributes.Value]: "ready" } }));
  await api.init({ driver_id: "test_driver", version: "1.2.3", min_core_api: "0.17.0", name: { en: "Test" }, developer: { name: "jstnjx" }, port }, async (message) => {
    assert.ok(message instanceof DriverSetupRequest);
    return new RequestUserInput({ en: "Configure" }, [{ id: "role", label: { en: "Role" }, field: { text: { value: "master" } } }]);
  });
  await api.setDeviceState(DeviceStates.Connected);
  const client = await connectWebSocket(`ws://127.0.0.1:${port}/`);
  const messages = [];
  client.on("message", (value) => messages.push(JSON.parse(value.toString())));
  try {
    assert.equal((await waitFor(messages, (item) => item.msg === "authentication")).code, 200);
    client.send(JSON.stringify({ kind: "req", id: 1, msg: "get_driver_metadata" }));
    const metadata = await waitFor(messages, (item) => item.req_id === 1);
    assert.equal(metadata.msg_data.developer.name, "jstnjx");
    client.send(JSON.stringify({ kind: "req", id: 2, msg: "get_available_entities" }));
    const entities = await waitFor(messages, (item) => item.req_id === 2);
    assert.equal(entities.msg_data.available_entities[0].entity_id, "status");
    client.send(JSON.stringify({ kind: "req", id: 3, msg: "setup_driver", msg_data: { setup_data: {}, reconfigure: false } }));
    const setup = await waitFor(messages, (item) => item.kind === "event" && item.msg === "driver_setup_change" && item.msg_data.state === "WAIT_USER_ACTION");
    assert.equal(setup.msg_data.require_user_action.input.settings[0].id, "role");
    const progressIndex = messages.findIndex((item) => item.kind === "event" && item.msg === "driver_setup_change" && item.msg_data.state === "SETUP");
    const inputIndex = messages.indexOf(setup);
    assert.ok(progressIndex >= 0 && progressIndex < inputIndex);
  } finally {
    client.close();
    await api.close();
    if (oldPort === undefined) delete process.env.UC_INTEGRATION_HTTP_PORT; else process.env.UC_INTEGRATION_HTTP_PORT = oldPort;
    if (oldMdns === undefined) delete process.env.UC_DISABLE_MDNS_PUBLISH; else process.env.UC_DISABLE_MDNS_PUBLISH = oldMdns;
  }
});


test("set_driver_user_data emits SETUP progress before the next WAIT_USER_ACTION form", async () => {
  const port = await freePort();
  const oldPort = process.env.UC_INTEGRATION_HTTP_PORT;
  const oldMdns = process.env.UC_DISABLE_MDNS_PUBLISH;
  process.env.UC_INTEGRATION_HTTP_PORT = String(port);
  process.env.UC_DISABLE_MDNS_PUBLISH = "true";
  const api = new IntegrationAPI();
  await api.init({ driver_id: "test_driver", version: "1.2.3", min_core_api: "0.17.0", name: { en: "Test" }, developer: { name: "jstnjx" }, port }, async (message) => {
    if (message instanceof DriverSetupRequest) {
      return new RequestUserInput({ en: "Choose role" }, [{ id: "role", label: { en: "Role" }, field: { text: { value: "child" } } }]);
    }
    assert.ok(message instanceof UserDataResponse);
    assert.equal(message.inputValues.role, "child");
    return new RequestUserInput({ en: "Set up child" }, [{ id: "pin", label: { en: "PIN" }, field: { text: { value: "" } } }]);
  });
  const client = await connectWebSocket(`ws://127.0.0.1:${port}/`);
  const messages = [];
  client.on("message", (value) => messages.push(JSON.parse(value.toString())));
  try {
    await waitFor(messages, (item) => item.msg === "authentication");
    client.send(JSON.stringify({ kind: "req", id: 1, msg: "setup_driver", msg_data: { setup_data: {}, reconfigure: false } }));
    await waitFor(messages, (item) => item.kind === "event" && item.msg === "driver_setup_change" && item.msg_data.state === "WAIT_USER_ACTION");
    const start = messages.length;
    client.send(JSON.stringify({ kind: "req", id: 2, msg: "set_driver_user_data", msg_data: { input_values: { role: "child" } } }));
    await waitFor(messages, (item) => item.kind === "resp" && item.req_id === 2 && item.msg === "result");
    const nextForm = await waitFor(messages, (item, index) => index >= start && item.kind === "event" && item.msg === "driver_setup_change" && item.msg_data.state === "WAIT_USER_ACTION" && item.msg_data.require_user_action?.input?.settings?.[0]?.id === "pin", 2500);
    const afterSubmit = messages.slice(start);
    const progressIndex = afterSubmit.findIndex((item) => item.kind === "event" && item.msg === "driver_setup_change" && item.msg_data.state === "SETUP");
    const formIndex = afterSubmit.indexOf(nextForm);
    assert.ok(progressIndex >= 0, JSON.stringify(afterSubmit));
    assert.ok(formIndex > progressIndex, JSON.stringify(afterSubmit));
  } finally {
    client.close();
    await api.close();
    if (oldPort === undefined) delete process.env.UC_INTEGRATION_HTTP_PORT; else process.env.UC_INTEGRATION_HTTP_PORT = oldPort;
    if (oldMdns === undefined) delete process.env.UC_DISABLE_MDNS_PUBLISH; else process.env.UC_DISABLE_MDNS_PUBLISH = oldMdns;
  }
});
