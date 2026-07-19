import crypto from "node:crypto";
import * as uc from "../integration/api.js";
import { DEFAULT_AGENT_PORT, DEFAULT_SECTIONS, DEFAULT_SYNC_INTERVAL_SECONDS, SCHEMA_VERSION } from "../shared/constants.js";
import { CoreClient } from "../core/client.js";
import { normalizeConfig } from "../shared/models.js";
import { detectRemoteNetworkIdentity } from "../network/identity.js";
import { isPairingIdentifier } from "../pairing/config.js";
import { generatePairingIdentifier } from "../pairing/mdns.js";
import { secureToken } from "../shared/util.js";
import { logger } from "../shared/logger.js";
import { approvalPrompt, networkIdentityText, networkOverrides, nodeId, parseRemoteAddress, setupErrorMessage } from "./common.js";
import { label, text } from "./forms.js";

const log = logger("setup-satellite");

// -----------------------------------------------------------------------------
// Satellite setup workflow
// -----------------------------------------------------------------------------

const Step = Object.freeze({ Pin: 1, Approval: 2, Pairing: 3 });

export class SatelliteSetup {
  constructor(store, onConfigured, existing = null) {
    this.store = store;
    this.onConfigured = onConfigured;
    this.existing = existing?.role === "child" ? existing : null;
    this.step = Step.Pin;
    this.pending = null;
    this.detectedNetwork = null;
    this.values = {};
  }

  async start() {
    this.detectedNetwork = await this.#detect({});
    return this.#form();
  }

  async handleData(values) {
    if (this.step !== Step.Pin) return new uc.SetupError();
    return this.#handlePin(values);
  }

  async handleConfirmation(confirm) {
    if (!confirm) return new uc.SetupError();
    if (this.step === Step.Approval) return this.#handleApproval();
    if (this.step === Step.Pairing) return new uc.SetupComplete();
    return new uc.SetupError();
  }

  #form(error = null) {
    const settings = [];
    const value = (key, fallback = "") => Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : fallback;
    if (error) settings.push(label("error", "Setup error", error));
    settings.push(
      label("detected_network", "Detected satellite network identity", networkIdentityText(this.detectedNetwork)),
      text(
        "remote_http_port",
        "Satellite remote HTTP port",
        value("remote_http_port", this.existing?.remote?.port ? String(this.existing.remote.port) : ""),
        "Optional. Leave empty for the standard HTTP/HTTPS port or the port included in the configured Satellite address."
      ),
      text(
        "pin",
        "Web-configurator PIN",
        value("pin", ""),
        'Remote Sync creates a dedicated API key. Enable "Keep Wi-Fi connected during standby" before continuing.'
      ),
      text(
        "network_mac_override",
        "Advanced MAC override",
        value("network_mac_override", this.existing?.network_overrides?.mac || ""),
        "Optional. Leave empty to use automatic detection."
      ),
      text(
        "network_broadcast_overrides",
        "Advanced WoWLAN broadcast override(s)",
        value("network_broadcast_overrides", (this.existing?.network_overrides?.broadcasts || []).join(",")),
        "Optional comma-separated directed broadcast addresses."
      )
    );
    return new uc.RequestUserInput({ en: "Set up satellite remote" }, settings);
  }

  async #handlePin(values) {
    this.values = { ...values };
    const pin = String(values.pin || "").trim();
    if (!pin) return this.#form("Enter the satellite remote's web-configurator PIN.");
    try {
      const overrides = networkOverrides(values);
      const address = parseRemoteAddress(
        process.env.REMOTE_SYNC_SATELLITE_REMOTE_ADDRESS
        || process.env.REMOTE_SYNC_CHILD_REMOTE_ADDRESS
        || "127.0.0.1",
        values.remote_http_port
      );
      const provisioned = await CoreClient.provisionApiKey(address.host, pin, {
        name: `Remote Sync Satellite ${crypto.randomBytes(5).toString("hex")}`,
        scheme: address.scheme,
        port: address.port
      });
      const remote = {
        host: address.host,
        api_key: provisioned.apiKey,
        scheme: address.scheme,
        port: address.port,
        mac: this.existing?.remote?.mac || null,
        broadcasts: this.existing?.remote?.broadcasts || [],
        interface: this.existing?.remote?.interface || null,
        network_source: this.existing?.remote?.network_source || null,
        verify_tls: address.scheme === "https"
      };
      const client = new CoreClient(remote);
      const version = await client.version();
      if (provisioned.active) await client.integrations();
      const network = await this.#detect(overrides, address.host);
      Object.assign(remote, {
        mac: network.mac,
        broadcasts: network.broadcasts,
        interface: network.interface,
        network_source: network.source
      });
      this.detectedNetwork = network;
      const pairingIdentifier = isPairingIdentifier(this.existing?.pairing_identifier)
        ? this.existing.pairing_identifier
        : generatePairingIdentifier();
      const config = normalizeConfig({
        schema_version: SCHEMA_VERSION,
        role: "child",
        node_id: nodeId(version, address.host),
        node_name: version?.device_name || version?.hostname || this.existing?.node_name || "Remote Sync Satellite",
        pairing_identifier: pairingIdentifier,
        pairing: {
          ready_to_pair: true,
          paired_master_id: null,
          paired_master_name: null,
          paired_at: null,
          master_agent_url: null,
          master_command_token: null,
          master_mac: null,
          master_broadcasts: []
        },
        remote,
        network_overrides: overrides,
        agent_token: this.existing?.agent_token || secureToken(),
        agent_port: this.existing?.agent_port || DEFAULT_AGENT_PORT,
        agent_public_url: null,
        peers: [],
        sync: {
          sections: [...DEFAULT_SECTIONS],
          interval_seconds: DEFAULT_SYNC_INTERVAL_SECONDS,
          auto_sync: false,
          prune: false,
          use_standby_inhibitor: true,
          verify_existing_resource_hashes: false
        }
      });
      this.pending = config;
      if (!provisioned.active) {
        this.step = Step.Approval;
        return approvalPrompt();
      }
      return this.#finish(config);
    } catch (error) {
      log.warn("Satellite setup failed:", error);
      return this.#form(setupErrorMessage(error));
    }
  }

  async #handleApproval() {
    if (!this.pending) return new uc.SetupError();
    try {
      await new CoreClient(this.pending.remote).integrations();
      return this.#finish(this.pending);
    } catch (error) {
      return approvalPrompt(setupErrorMessage(error));
    }
  }

  async #finish(config) {
    const saved = this.store.save(config);
    await this.onConfigured(saved);
    this.step = Step.Pairing;
    return new uc.RequestUserConfirmation(
      { en: "Satellite is ready to pair" },
      { en: `Pairing token:\n${saved.agent_token}` },
      undefined,
      { en: `This satellite is advertising ${saved.pairing_identifier}. Open setup on the primary and enter this token for ${saved.node_name}.` }
    );
  }

  async #detect(overrides = {}, host = "127.0.0.1") {
    const envMac = process.env.REMOTE_SYNC_SATELLITE_MAC || null;
    const envBroadcasts = process.env.REMOTE_SYNC_SATELLITE_BROADCASTS || [];
    return detectRemoteNetworkIdentity({
      host,
      fallbackMac: this.existing?.remote?.mac || null,
      fallbackBroadcasts: this.existing?.remote?.broadcasts || [],
      macOverride: overrides.mac || envMac,
      broadcastsOverride: overrides.broadcasts?.length ? overrides.broadcasts : envBroadcasts,
      preferWireless: true
    });
  }
}
