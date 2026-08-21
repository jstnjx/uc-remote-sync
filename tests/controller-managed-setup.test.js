import assert from "node:assert/strict";
import test from "node:test";

import * as uc from "../src/integration/api.js";
import { SetupFlow } from "../src/setup/index.js";

function managedConfig(role = "child") {
  return {
    schema_version: 6,
    role,
    controller_bridge: { managed_by: "uc-advanced-web-configurator" },
  };
}

test("controller-managed setup completes through the normal setup handler", async () => {
  const config = managedConfig("child");
  const configured = [];
  const flow = new SetupFlow({ load: () => config }, async (value) => configured.push(value));

  const action = await flow.handler(new uc.DriverSetupRequest(false, {
    managed_by: "uc-advanced-web-configurator",
    role: "satellite",
  }));

  assert.ok(action instanceof uc.SetupComplete);
  assert.deepEqual(configured, [config]);
});

test("controller-managed setup rejects a role mismatch", async () => {
  const configured = [];
  const flow = new SetupFlow({ load: () => managedConfig("master") }, async (value) => configured.push(value));

  const action = await flow.handler(new uc.DriverSetupRequest(false, {
    managed_by: "uc-advanced-web-configurator",
    role: "satellite",
  }));

  assert.ok(action instanceof uc.SetupError);
  assert.equal(action.errorType, uc.IntegrationSetupError.Other);
  assert.deepEqual(configured, []);
});

test("controller-managed setup requires controller-owned configuration", async () => {
  const flow = new SetupFlow({ load: () => ({ schema_version: 6, role: "child" }) }, async () => {});
  const action = await flow.handler(new uc.DriverSetupRequest(false, {
    managed_by: "uc-advanced-web-configurator",
    role: "satellite",
  }));

  assert.ok(action instanceof uc.SetupError);
  assert.equal(action.errorType, uc.IntegrationSetupError.AuthorizationError);
});
