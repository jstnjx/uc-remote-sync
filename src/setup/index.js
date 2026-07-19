import * as uc from "../integration/api.js";
import { PrimarySetup } from "./primary.js";
import { SatelliteSetup } from "./satellite.js";
import { RemoteSyncDiscovery } from "../pairing/mdns.js";
import { dropdown, label } from "./forms.js";

// -----------------------------------------------------------------------------
// Setup role routing
// -----------------------------------------------------------------------------

export class SetupFlow {
  constructor(store, onConfigured, {
    discovery = new RemoteSyncDiscovery({ timeoutMs: 3000 }),
    manualSatelliteInspector = undefined,
    peerClientFactory = undefined
  } = {}) {
    this.store = store;
    this.onConfigured = onConfigured;
    this.discovery = discovery;
    this.manualSatelliteInspector = manualSatelliteInspector;
    this.peerClientFactory = peerClientFactory;
    this.workflow = null;
    this.awaitingRole = true;
    this.loadError = null;
  }

  async handler(message) {
    if (message instanceof uc.DriverSetupRequest) return this.#start(message.reconfigure);
    if (message instanceof uc.AbortDriverSetup) {
      this.#reset();
      return new uc.SetupError();
    }
    if (this.awaitingRole && message instanceof uc.UserDataResponse) return this.#selectRole(message.inputValues);
    if (!this.workflow) return new uc.SetupError();
    if (message instanceof uc.UserDataResponse) return this.workflow.handleData(message.inputValues);
    if (message instanceof uc.UserConfirmationResponse) return this.workflow.handleConfirmation(message.confirm);
    return new uc.SetupError();
  }

  async #start(reconfigure) {
    this.#reset();
    let existing = null;
    if (reconfigure) {
      try { existing = this.store.load(); }
      catch (error) { this.loadError = error.message; }
    }
    if (existing?.role === "child") return this.#activateSatellite(existing);
    if (existing?.role === "master") return this.#activatePrimary(existing);
    return this.#roleForm();
  }

  #roleForm() {
    const settings = [];
    if (this.loadError) settings.push(label("configuration_error", "Existing configuration error", this.loadError));
    settings.push(dropdown("role", "Role", "satellite", [
      ["satellite", "Satellite remote"],
      ["primary", "Primary remote / external primary"]
    ]));
    return new uc.RequestUserInput({ en: "Choose this Remote Sync role" }, settings);
  }

  async #selectRole(values) {
    if (["satellite", "child"].includes(values.role)) return this.#activateSatellite(null);
    if (["primary", "master"].includes(values.role)) return this.#activatePrimary(null);
    return new uc.SetupError(uc.IntegrationSetupError.Other);
  }

  async #activateSatellite(existing) {
    this.awaitingRole = false;
    this.workflow = new SatelliteSetup(this.store, this.onConfigured, existing);
    return this.workflow.start();
  }

  async #activatePrimary(existing) {
    this.awaitingRole = false;
    this.workflow = new PrimarySetup(this.store, this.onConfigured, existing, {
      discovery: this.discovery,
      manualSatelliteInspector: this.manualSatelliteInspector,
      peerClientFactory: this.peerClientFactory
    });
    return this.workflow.start();
  }

  #reset() {
    this.workflow = null;
    this.awaitingRole = true;
    this.loadError = null;
  }
}
