#!/usr/bin/env node
import net from "node:net";
import * as uc from "./integration-api.js";
import { ConfigStore } from "./config-store.js";
import { DEFAULT_INTEGRATION_PORT } from "./constants.js";
import { driverJsonPath } from "./paths.js";
import { RemoteSyncService } from "./service.js";
import { SetupFlow } from "./setup-flow.js";
import { EntityManager } from "./entities.js";
import { logger } from "./logger.js";

const log = logger("driver");

async function assertPortAvailable(host, port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => server.close(resolve));
  });
}

export class Driver {
  constructor() {
    this.api = new uc.IntegrationAPI();
    this.store = new ConfigStore();
    this.service = new RemoteSyncService(this.store);
    this.entities = new EntityManager(this.api, this.service);

    this.setup = new SetupFlow(this.store, (config) => this.service.configure(config));
    this.#events();
  }
  #events() {
    this.api.on(uc.Events.Connect, async () => this.api.setDeviceState(this.service.config ? uc.DeviceStates.Connected : uc.DeviceStates.Disconnected));
    this.api.on(uc.Events.Disconnect, () => log.debug("Remote integration client disconnected"));
    this.api.on(uc.Events.EnterStandby, () => log.debug("Host remote entered standby"));
    this.api.on(uc.Events.ExitStandby, () => { log.debug("Host remote exited standby; reconciling Core state"); this.service.reconcile(); });
    this.api.on(uc.Events.SubscribeEntities, (entityIds) => this.entities.refreshSubscribed(entityIds));
  }
  async start() {
    const port = Number(process.env.UC_INTEGRATION_HTTP_PORT || DEFAULT_INTEGRATION_PORT);
    const host = process.env.UC_INTEGRATION_INTERFACE || "0.0.0.0";
    await assertPortAvailable(host, port);
    this.entities.register();
    await this.api.init(driverJsonPath(), (message) => this.setup.handler(message));
    log.info(`Integration API initialized on ${host}:${port}`);
    await this.service.load();
    await this.api.setDeviceState(this.service.config ? uc.DeviceStates.Connected : uc.DeviceStates.Disconnected);
  }
  async stop() { await this.service.stop(); await this.api.close(); }
}

const driver = new Driver();
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`Received ${signal}; shutting down`);
  try { await driver.stop(); } finally { process.exit(0); }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => { log.error("Unhandled rejection:", error); process.exitCode = 1; });
process.on("uncaughtException", (error) => { log.error("Uncaught exception:", error); process.exit(1); });

try { await driver.start(); }
catch (error) { log.error("Startup failed:", error); process.exit(1); }
