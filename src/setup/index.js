import * as uc from "../integration/api.js";
import { CoreClient } from "../core/client.js";
import { DEFAULT_AGENT_PORT, DEFAULT_SECTIONS, DEFAULT_SYNC_INTERVAL_SECONDS, SCHEMA_VERSION } from "../shared/constants.js";
import { normalizeConfig } from "../shared/models.js";
import { detectRemoteNetworkIdentity } from "../network/identity.js";
import { reachableAgentUrl, secureToken } from "../shared/util.js";
import { logger } from "../shared/logger.js";
import { approvalPrompt, dashboardUrl, nodeId, parseRemoteAddress, setupErrorMessage } from "./common.js";
import { label, password } from "./forms.js";

const log = logger("setup");

// -----------------------------------------------------------------------------
// PIN-only integration setup
//
// The Remote's setup dialog only collects the Web Configurator PIN (it is part of driver.json's setup_data_schema,
// so a correct PIN finishes setup on the first page). Remote Sync then creates its API key, detects the network
// identity, enables Wake on WLAN and saves an "unassigned" configuration. The role (Primary or Satellite), Satellites
// and every other option are configured in the web dashboard, which the final page links to.
// -----------------------------------------------------------------------------

function remoteAddressCandidate(hint) {
  const configured = process.env.REMOTE_SYNC_REMOTE_ADDRESS
    || process.env.REMOTE_SYNC_SATELLITE_REMOTE_ADDRESS
    || process.env.REMOTE_SYNC_CHILD_REMOTE_ADDRESS;
  if (configured) return configured;
  // On the Remote the Core connects from loopback. An external instance (Docker / Node.js) is reached by the Remote
  // that runs this setup, so its address is the Core this instance belongs to.
  const value = String(hint || "").replace(/^::ffff:/, "").trim();
  if (!value || value === "::1" || value.startsWith("127.")) return "127.0.0.1";
  return value;
}

export class SetupFlow {
  constructor(store, onConfigured, {
    remoteHint = () => null,
    coreClientFactory = (endpoint) => new CoreClient(endpoint),
    provisionApiKey = CoreClient.provisionApiKey,
    detectNetwork = detectRemoteNetworkIdentity
  } = {}) {
    this.store = store;
    this.onConfigured = onConfigured;
    this.remoteHint = remoteHint;
    this.coreClientFactory = coreClientFactory;
    this.provisionApiKey = provisionApiKey;
    this.detectNetwork = detectNetwork;
    this.#reset();
  }

  #reset() {
    this.existing = null;
    this.pending = null;
    this.state = "pin";
  }

  async handler(message) {
    if (message instanceof uc.DriverSetupRequest) {
      this.#reset();
      try { this.existing = this.store.load(); }
      catch (error) { log.warn("Existing configuration is invalid and will be replaced:", error.message); this.existing = null; }
      const pin = String(message.setupData?.pin || "").trim();
      return pin ? this.#apply(pin) : this.#pinForm();
    }
    if (message instanceof uc.AbortDriverSetup) {
      this.#reset();
      return new uc.SetupError();
    }
    if (message instanceof uc.UserDataResponse) {
      if (this.state !== "pin") return new uc.SetupError();
      return this.#apply(String(message.inputValues?.pin || "").trim());
    }
    if (message instanceof uc.UserConfirmationResponse) {
      if (this.state === "done") return new uc.SetupComplete();
      if (this.state === "approval" && message.confirm) return this.#afterApproval();
      return new uc.SetupError();
    }
    return new uc.SetupError();
  }

  #pinForm(errorMessage = null) {
    this.state = "pin";
    const settings = [];
    if (this.existing?.role && this.existing.role !== "unassigned") {
      settings.push(label("reconfigure_info", { en: "Reconfigure", de: "Neu einrichten" }, {
        en: "Enter the PIN to renew Remote Sync's API key. The role, Satellites and settings are kept; change them in the dashboard.",
        de: "Gib die PIN ein, um den API-Schlüssel von Remote Sync zu erneuern. Rolle, Satelliten und Einstellungen bleiben erhalten; ändere sie im Dashboard."
      }));
    }
    settings.push(password("pin", { en: "Web Configurator PIN", de: "Web-Konfigurator-PIN" }));
    return new uc.RequestUserInput({ en: "Remote Sync setup", de: "Remote Sync einrichten" }, settings, { errorMessage });
  }

  #endpoint() {
    if (this.existing?.remote?.host) {
      const remote = this.existing.remote;
      return { host: remote.host, scheme: remote.scheme || "http", port: remote.port || null };
    }
    return parseRemoteAddress(remoteAddressCandidate(this.remoteHint?.()), process.env.REMOTE_SYNC_REMOTE_PORT || null);
  }

  async #apply(pin) {
    if (!pin) return this.#pinForm({ en: "Enter the Web Configurator PIN.", de: "Gib die Web-Konfigurator-PIN ein." });
    try {
      const endpoint = this.#endpoint();
      const provisioned = await this.provisionApiKey(endpoint.host, pin, {
        name: "Remote Sync",
        description: "Created by the Remote Sync integration setup.",
        scheme: endpoint.scheme,
        port: endpoint.port
      });
      this.pending = { endpoint, apiKey: provisioned.apiKey, keyName: provisioned.name || null };
      if (!provisioned.active) {
        this.state = "approval";
        return approvalPrompt();
      }
      return await this.#finish();
    } catch (error) {
      log.warn("Setup failed:", error.message);
      return this.#pinForm(setupErrorMessage(error));
    }
  }

  async #afterApproval() {
    try { return await this.#finish(); }
    catch (error) { return approvalPrompt(setupErrorMessage(error)); }
  }

  async #finish() {
    const { endpoint, apiKey, keyName } = this.pending;
    const existing = this.existing;
    const remote = {
      host: endpoint.host,
      scheme: endpoint.scheme,
      port: endpoint.port,
      api_key: apiKey,
      api_key_name: keyName,
      mac: existing?.remote?.mac || null,
      broadcasts: existing?.remote?.broadcasts || [],
      interface: existing?.remote?.interface || null,
      network_source: existing?.remote?.network_source || null,
      verify_tls: endpoint.scheme === "https"
    };
    const client = this.coreClientFactory(remote);
    try {
      const version = await client.version();
      await client.integrations();
      const overrides = existing?.network_overrides || { mac: null, broadcasts: [] };
      const network = await this.detectNetwork({
        host: endpoint.host,
        fallbackMac: remote.mac,
        fallbackBroadcasts: remote.broadcasts,
        macOverride: overrides.mac || process.env.REMOTE_SYNC_PRIMARY_MAC || process.env.REMOTE_SYNC_SATELLITE_MAC || null,
        broadcastsOverride: overrides.broadcasts?.length ? overrides.broadcasts : (process.env.REMOTE_SYNC_PRIMARY_BROADCASTS || process.env.REMOTE_SYNC_SATELLITE_BROADCASTS || []),
        preferWireless: true
      });
      Object.assign(remote, { mac: network.mac, broadcasts: network.broadcasts, interface: network.interface, network_source: network.source });
      let wakeOnWlan = null;
      try {
        wakeOnWlan = await client.wakeOnWlan();
        if (wakeOnWlan === false) { await client.setWakeOnWlan(true); wakeOnWlan = true; }
      } catch (error) { log.warn("Wake on WLAN could not be checked:", error.message); }

      const config = existing
        ? normalizeConfig({ ...existing, remote })
        : normalizeConfig({
          schema_version: SCHEMA_VERSION,
          role: "unassigned",
          node_id: nodeId(version, endpoint.host),
          node_name: version?.device_name || version?.hostname || "Remote Sync",
          pairing_identifier: null,
          pairing: { ready_to_pair: false },
          remote,
          network_overrides: { mac: null, broadcasts: [] },
          agent_token: secureToken(),
          agent_port: Number(process.env.REMOTE_SYNC_AGENT_PORT) || DEFAULT_AGENT_PORT,
          agent_public_url: null,
          physical_docks: { default_token: "", tokens: {} },
          peers: [],
          sync: { sections: DEFAULT_SECTIONS.filter((section) => section !== "docks"), interval_seconds: DEFAULT_SYNC_INTERVAL_SECONDS, auto_sync: true }
        });
      const saved = this.store.save(config);
      // Renewing the key on reconfigure: revoke the key the previous setup created so keys do not pile up.
      const previousName = existing?.remote?.api_key_name;
      if (previousName && previousName !== keyName) {
        try { await client.deleteApiKeysNamed(previousName); }
        catch (error) { log.warn("Could not revoke the previous API key:", error.message); }
      }
      await this.onConfigured(saved);
      this.state = "done";
      return this.#donePage(saved, wakeOnWlan);
    } finally {
      await client.close?.();
    }
  }

  #donePage(config, wakeOnWlan) {
    const url = dashboardUrl(config, reachableAgentUrl(config));
    const link = url ? `\n\n[${url}](${url})` : "";
    const assigned = config.role !== "unassigned";
    const wake = wakeOnWlan === true ? { en: "Wake on WLAN is enabled.", de: "Wake on WLAN ist aktiviert." }
      : { en: "Enable \"Keep Wi-Fi connected during standby\" on this remote.", de: "Aktiviere \"WLAN im Standby verbunden lassen\" auf dieser Fernbedienung." };
    return new uc.RequestUserConfirmation(
      { en: "Open the Remote Sync dashboard", de: "Remote-Sync-Dashboard öffnen" },
      assigned
        ? { en: `The API key was renewed. Manage Remote Sync in the dashboard:${link}`, de: `Der API-Schlüssel wurde erneuert. Verwalte Remote Sync im Dashboard:${link}` }
        : { en: `Choose whether this remote is the Primary or a Satellite in the dashboard:${link}`, de: `Lege im Dashboard fest, ob diese Fernbedienung Primary oder Satellit ist:${link}` },
      undefined,
      { en: `Sign in with this remote's Web Configurator PIN. ${wake.en}`, de: `Melde dich mit der Web-Konfigurator-PIN dieser Fernbedienung an. ${wake.de}` }
    );
  }
}
