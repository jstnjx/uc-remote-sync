import crypto from "node:crypto";
import * as uc from "../integration/api.js";
import { DEFAULT_AGENT_PORT, DEFAULT_SECTIONS, DEFAULT_SYNC_INTERVAL_SECONDS, SCHEMA_VERSION } from "../shared/constants.js";
import { CoreClient } from "../core/client.js";
import { normalizeConfig } from "../shared/models.js";
import { detectRemoteNetworkIdentity, normalizeMacAddress } from "../network/identity.js";
import { displayPairingIdentifier, normalizePairingIdentifier, RemoteSyncDiscovery } from "../pairing/mdns.js";
import { PeerAgentClient } from "../service/peer-agent-client.js";
import { reachableAgentUrl, secureToken, utcNow } from "../shared/util.js";
import { logger } from "../shared/logger.js";
import {
  approvalPrompt,
  networkIdentityText,
  networkOverrides,
  nodeId,
  parseRemoteAddress,
  physicalDockTokens,
  satelliteKey,
  setupErrorMessage,
  splitCsv
} from "./common.js";
import { dropdown, label, text } from "./forms.js";

const log = logger("setup-primary");

// -----------------------------------------------------------------------------
// Primary setup workflow
// -----------------------------------------------------------------------------

const Step = Object.freeze({ Details: 1, Approval: 2, Settings: 3, Satellites: 4 });

export class PrimarySetup {
  constructor(store, onConfigured, existing = null, { discovery = new RemoteSyncDiscovery({ timeoutMs: 3000 }) } = {}) {
    this.store = store;
    this.onConfigured = onConfigured;
    this.existing = existing?.role === "master" ? existing : null;
    this.discovery = discovery;
    this.step = Step.Details;
    this.draft = { details: {}, settings: {}, satellites: {}, prepared: null };
    this.satellites = [];
  }

  start() {
    this.step = Step.Details;
    return this.#detailsForm();
  }

  async handleData(values) {
    if (this.step === Step.Details) return this.#handleDetails(values);
    if (this.step === Step.Settings) return this.#handleSettings(values);
    if (this.step === Step.Satellites) return this.#handleSatellites(values);
    return new uc.SetupError();
  }

  async handleConfirmation(confirm) {
    if (!confirm || this.step !== Step.Approval || !this.draft.prepared) return new uc.SetupError();
    try {
      await new CoreClient(this.draft.prepared.remote).integrations();
      this.draft.prepared.active = true;
      this.step = Step.Settings;
      return this.#settingsForm();
    } catch (error) {
      return approvalPrompt(setupErrorMessage(error));
    }
  }

  // -------------------------------------------------------------------------
  // Step 1: Primary details
  // -------------------------------------------------------------------------

  #detailsForm(error = null) {
    const values = this.draft.details;
    const value = (key, fallback = "") => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
    const settings = [];
    if (error) settings.push(label("error", "Setup error", error));
    settings.push(
      text("node_name", "Primary name", value("node_name", this.existing?.node_name || "Remote Sync Primary")),
      text(
        "remote_address",
        "Primary remote address",
        value("remote_address", this.existing?.remote?.host || "127.0.0.1"),
        "Use 127.0.0.1 when installed on the primary remote. Enter the remote IP when running externally."
      ),
      text(
        "pin",
        "Web-configurator PIN",
        "",
        this.existing ? "Leave empty to retain the existing API key." : "Used once to create a dedicated API key."
      ),
      text("agent_public_url", "Advanced primary agent URL override", value("agent_public_url", this.existing?.agent_public_url || "")),
      text(
        "physical_dock_tokens",
        "Physical Dock API token(s)",
        value("physical_dock_tokens", ""),
        this.existing?.physical_docks?.default_token || Object.keys(this.existing?.physical_docks?.tokens || {}).length
          ? "Leave empty to retain stored Dock tokens. Enter one token for all Docks, or comma-separated DOCK_ID=token overrides."
          : "Enter one token for all Docks, or comma-separated DOCK_ID=token overrides."
      ),
      text(
        "network_mac_override",
        "Advanced Primary MAC override",
        value("network_mac_override", this.existing?.network_overrides?.mac || ""),
        "Optional. Leave empty to use automatic detection."
      ),
      text(
        "network_broadcast_overrides",
        "Advanced Primary WoWLAN broadcast override(s)",
        value("network_broadcast_overrides", (this.existing?.network_overrides?.broadcasts || []).join(",")),
        "Optional comma-separated directed broadcast addresses."
      )
    );
    return new uc.RequestUserInput({ en: "Step 1 of 3 — Define primary details" }, settings);
  }

  async #handleDetails(values) {
    this.draft.details = { ...values };
    try {
      const address = parseRemoteAddress(values.remote_address || "");
      const pin = String(values.pin || "").trim();
      if (!pin && !this.existing?.remote?.api_key) return this.#detailsForm("Enter the primary remote's web-configurator PIN.");
      const overrides = networkOverrides(values);
      const docks = physicalDockTokens(values.physical_dock_tokens, this.existing?.physical_docks);
      let apiKey = this.existing?.remote?.api_key || null;
      let active = true;
      if (pin) {
        const provisioned = await CoreClient.provisionApiKey(address.host, pin, {
          name: `Remote Sync Primary ${crypto.randomBytes(5).toString("hex")}`,
          scheme: address.scheme,
          port: address.port
        });
        apiKey = provisioned.apiKey;
        active = provisioned.active;
      }
      const remote = {
        host: address.host,
        api_key: apiKey,
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
      if (active) await client.integrations();
      const network = await detectRemoteNetworkIdentity({
        host: address.host,
        fallbackMac: this.existing?.remote?.mac || null,
        fallbackBroadcasts: this.existing?.remote?.broadcasts || [],
        macOverride: overrides.mac || process.env.REMOTE_SYNC_PRIMARY_MAC || null,
        broadcastsOverride: overrides.broadcasts.length ? overrides.broadcasts : (process.env.REMOTE_SYNC_PRIMARY_BROADCASTS || []),
        preferWireless: true
      });
      Object.assign(remote, {
        mac: network.mac,
        broadcasts: network.broadcasts,
        interface: network.interface,
        network_source: network.source
      });
      this.draft.prepared = { address, remote, version, active, network, overrides, docks };
      if (!active) {
        this.step = Step.Approval;
        return approvalPrompt();
      }
      this.step = Step.Settings;
      return this.#settingsForm();
    } catch (error) {
      log.warn("Primary detail setup failed:", error);
      return this.#detailsForm(setupErrorMessage(error));
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Primary settings
  // -------------------------------------------------------------------------

  #settingsForm(error = null) {
    const values = this.draft.settings;
    const existingSync = this.existing?.sync || {};
    const syncSections = new Set(existingSync.sections || DEFAULT_SECTIONS);
    const value = (key, fallback = "") => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
    const settings = [];
    if (error) settings.push(label("error", "Setup error", error));
    settings.push(
      label("detected_network", "Detected Primary network identity", networkIdentityText(this.draft.prepared?.network)),
      label("requirements", "Required remote setting", 'Enable "Keep Wi-Fi connected during standby" on the primary and every satellite remote.'),
      dropdown("keep_wifi_confirmed", "Keep Wi-Fi connected during standby", value("keep_wifi_confirmed", "yes"), [["yes", "Enabled"], ["no", "Not enabled"]]),
      text("sync_interval", "Automatic sync interval in seconds", value("sync_interval", String(existingSync.interval_seconds || DEFAULT_SYNC_INTERVAL_SECONDS))),
      dropdown("auto_sync", "Automatic synchronization", value("auto_sync", existingSync.auto_sync === false ? "no" : "yes"), [["yes", "Enabled"], ["no", "Disabled"]]),
      dropdown("prune", "Remove deleted synchronized objects", value("prune", existingSync.prune ? "yes" : "no"), [["no", "Disabled"], ["yes", "Enabled"]]),
      dropdown("standby_inhibitor", "Use standby inhibitor for satellite updates", value("standby_inhibitor", existingSync.use_standby_inhibitor === false ? "no" : "yes"), [["yes", "Enabled"], ["no", "Disabled"]]),
      dropdown("verify_resource_hashes", "Verify existing satellite resource hashes", value("verify_resource_hashes", existingSync.verify_existing_resource_hashes ? "yes" : "no"), [["no", "Disabled"], ["yes", "Enabled"]])
    );
    for (const section of DEFAULT_SECTIONS) {
      settings.push(dropdown(
        `section_${section}`,
        `Synchronize ${section.replaceAll("_", " ")}`,
        value(`section_${section}`, syncSections.has(section) ? "yes" : "no"),
        [["yes", "Enabled"], ["no", "Disabled"]]
      ));
    }
    return new uc.RequestUserInput({ en: "Step 2 of 3 — Define primary settings" }, settings);
  }

  async #handleSettings(values) {
    this.draft.settings = { ...values };
    if (values.keep_wifi_confirmed !== "yes") return this.#settingsForm('Enable "Keep Wi-Fi connected during standby" before continuing.');
    const interval = Number(values.sync_interval || DEFAULT_SYNC_INTERVAL_SECONDS);
    if (!Number.isFinite(interval) || interval < 30 || interval > 86_400) return this.#settingsForm("The automatic sync interval must be between 30 and 86400 seconds.");
    const sections = DEFAULT_SECTIONS.filter((section) => values[`section_${section}`] !== "no");
    if (!sections.length) return this.#settingsForm("Enable at least one synchronization section.");
    const docks = this.draft.prepared?.docks || { default_token: "", tokens: {} };
    if (sections.includes("docks") && !docks.default_token && !Object.keys(docks.tokens || {}).length) {
      this.step = Step.Details;
      return this.#detailsForm("Dock synchronization is enabled. Enter a physical Dock API token, then continue through settings again.");
    }
    this.satellites = await this.#discoverSatellites();
    this.step = Step.Satellites;
    return this.#satellitesForm();
  }

  // -------------------------------------------------------------------------
  // Step 3: Satellite configuration
  // -------------------------------------------------------------------------

  #satellitesForm(error = null) {
    const values = this.draft.satellites;
    const value = (key, fallback = "") => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
    const settings = [];
    if (error) settings.push(label("error", "Setup error", error));
    settings.push(label("satellites_header", "Satellite remotes", "Discovered and previously paired satellites are shown below. Network values are automatic unless an advanced override is supplied."));
    if (!this.satellites.length) settings.push(label("no_satellites", "No satellites discovered", "The Primary can be completed without a Satellite. Reopen setup after configuring a Satellite."));
    for (const satellite of this.satellites) {
      const key = satelliteKey(satellite.identifier);
      const status = satellite.ready ? "Ready to pair" : "Previously paired";
      const endpoint = satellite.url || satellite.existing?.url || satellite.hostname || "address unavailable";
      const protocol = satellite.protocol
        ? `Remote Sync ${satellite.protocol.version || satellite.version || "unknown"}; protocol ${satellite.protocol.protocol_version}; snapshot ${satellite.protocol.snapshot_schema}`
        : `Remote Sync ${satellite.version || "unknown"}; legacy protocol`;
      settings.push(
        label(`satellite_info_${key}`, satellite.name || satellite.identifier, `${satellite.identifier} — ${status} — ${endpoint} — ${protocol}`),
        text(
          `satellite_token_${key}`,
          "Pairing token",
          "",
          satellite.existing ? "Leave empty to retain the saved token." : "Enter the token displayed by this Satellite."
        ),
        text(`satellite_name_${key}`, "Friendly name", value(`satellite_name_${key}`, satellite.existing?.name || satellite.name || satellite.identifier)),
        label(`satellite_network_${key}`, "Detected network identity", networkIdentityText({
          mac: satellite.mac || satellite.existing?.mac,
          broadcasts: satellite.broadcasts?.length ? satellite.broadcasts : satellite.existing?.broadcasts,
          address: satellite.address,
          interface: satellite.interface,
          source: satellite.network_source || satellite.discovery
        })),
        text(`satellite_${key}_mac_override`, "Advanced Satellite MAC override", "", "Optional. Leave empty to keep automatic discovery."),
        text(`satellite_${key}_broadcast_overrides`, "Advanced Satellite broadcast override(s)", "", "Optional comma-separated directed broadcast addresses.")
      );
    }
    return new uc.RequestUserInput({ en: "Step 3 of 3 — Configure satellite remotes" }, settings);
  }

  async #handleSatellites(values) {
    this.draft.satellites = { ...values };
    try {
      const config = this.#buildConfig();
      await this.#pairReadySatellites(config);
      const saved = this.store.save(config);
      await this.onConfigured(saved);
      return new uc.SetupComplete();
    } catch (error) {
      log.warn("Primary setup failed:", error);
      return this.#satellitesForm(setupErrorMessage(error));
    }
  }

  #buildConfig() {
    const details = this.draft.details;
    const settings = this.draft.settings;
    const prepared = this.draft.prepared;
    if (!prepared) throw new Error("Primary details have not been prepared.");
    const sections = DEFAULT_SECTIONS.filter((section) => settings[`section_${section}`] !== "no");
    const peers = this.#peersFromForm();
    return normalizeConfig({
      schema_version: SCHEMA_VERSION,
      role: "master",
      node_id: nodeId(prepared.version, prepared.address.host),
      node_name: String(details.node_name || "").trim() || prepared.version?.device_name || "Remote Sync Primary",
      pairing_identifier: null,
      pairing: { ready_to_pair: false, paired_master_id: null, paired_master_name: null, paired_at: null },
      remote: prepared.remote,
      network_overrides: prepared.overrides,
      agent_token: this.existing?.agent_token || secureToken(),
      agent_port: this.existing?.agent_port || DEFAULT_AGENT_PORT,
      agent_public_url: String(details.agent_public_url || "").trim() || null,
      physical_docks: prepared.docks,
      peers,
      sync: {
        sections,
        interval_seconds: Number(settings.sync_interval || DEFAULT_SYNC_INTERVAL_SECONDS),
        auto_sync: settings.auto_sync !== "no",
        prune: settings.prune === "yes",
        use_standby_inhibitor: settings.standby_inhibitor !== "no",
        verify_existing_resource_hashes: settings.verify_resource_hashes === "yes"
      }
    });
  }

  async #discoverSatellites() {
    let discovered = [];
    try { discovered = await this.discovery.discoverReady(); }
    catch (error) { log.warn("Satellite discovery failed:", error.message); }
    const existingByIdentifier = new Map((this.existing?.peers || [])
      .filter((peer) => peer.identifier)
      .map((peer) => [normalizePairingIdentifier(peer.identifier), peer]));
    const result = [];
    const seen = new Set();
    for (const item of discovered) {
      const normalized = normalizePairingIdentifier(item.identifier);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const saved = existingByIdentifier.get(normalized) || null;
      const network = await detectRemoteNetworkIdentity({
        host: item.address || item.hostname,
        fallbackMac: item.mac || saved?.mac || null,
        fallbackBroadcasts: item.broadcasts?.length ? item.broadcasts : (saved?.broadcasts || []),
        preferWireless: false
      });
      result.push({
        ...item,
        identifier: displayPairingIdentifier(item.identifier),
        ready: true,
        mac: item.mac || network.mac || saved?.mac || null,
        broadcasts: item.broadcasts?.length ? item.broadcasts : (network.broadcasts.length ? network.broadcasts : (saved?.broadcasts || [])),
        interface: network.interface,
        network_source: network.source,
        existing: saved
      });
    }
    for (const peer of this.existing?.peers || []) {
      const normalized = normalizePairingIdentifier(peer.identifier);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push({
        identifier: displayPairingIdentifier(peer.identifier),
        name: peer.name,
        url: peer.url,
        hostname: null,
        address: null,
        ready: false,
        mac: peer.mac || null,
        broadcasts: peer.broadcasts || [],
        protocol: peer.protocol || null,
        existing: peer
      });
    }
    return result.sort((a, b) => String(a.name || a.identifier).localeCompare(String(b.name || b.identifier)));
  }

  #peersFromForm() {
    const values = this.draft.satellites;
    return this.satellites.map((satellite) => {
      const key = satelliteKey(satellite.identifier);
      const enteredToken = String(values[`satellite_token_${key}`] || "").trim();
      const token = enteredToken || satellite.existing?.token || "";
      if (satellite.ready && token.length < 16) throw new Error(`Enter the pairing token for ${satellite.name || satellite.identifier}.`);
      if (!token) throw new Error(`No saved pairing token exists for ${satellite.name || satellite.identifier}.`);
      const macOverrideRaw = String(values[`satellite_${key}_mac_override`] || "").trim();
      const macOverride = macOverrideRaw ? normalizeMacAddress(macOverrideRaw) : null;
      if (macOverrideRaw && !macOverride) throw new Error(`Invalid MAC override for ${satellite.name || satellite.identifier}.`);
      const broadcastOverrides = splitCsv(values[`satellite_${key}_broadcast_overrides`] || "");
      return {
        peer_id: `rms-${normalizePairingIdentifier(satellite.identifier).toLowerCase()}`,
        identifier: displayPairingIdentifier(satellite.identifier),
        name: String(values[`satellite_name_${key}`] || "").trim() || satellite.name || satellite.identifier,
        url: satellite.existing?.identifier ? null : (satellite.url || satellite.existing?.url || null),
        token,
        mac: macOverride || satellite.mac || satellite.existing?.mac || null,
        broadcasts: broadcastOverrides.length ? broadcastOverrides : (satellite.broadcasts?.length ? satellite.broadcasts : (satellite.existing?.broadcasts || [])),
        enabled: satellite.existing?.enabled !== false,
        child_node_id: satellite.existing?.child_node_id || null,
        claimed_at: satellite.existing?.claimed_at || null,
        command_token: satellite.existing?.command_token || secureToken(),
        protocol: satellite.protocol || satellite.existing?.protocol || null
      };
    });
  }

  async #pairReadySatellites(config) {
    for (const satellite of this.satellites.filter((item) => item.ready)) {
      const peer = config.peers.find((item) => normalizePairingIdentifier(item.identifier) === normalizePairingIdentifier(satellite.identifier));
      const client = new PeerAgentClient(satellite.url, peer.token);
      const required = ["proxy_entities"];
      if (config.sync.sections.includes("docks")) required.push("dock_tunnel");
      const protocol = await client.capabilities({ requiredCapabilities: required });
      const details = await client.validatePairing({ master_id: config.node_id, master_name: config.node_name });
      peer.protocol = protocol;
      peer.child_node_id = details.node_id || null;
      this.#applyNetworkIdentity(peer, details, satellite);
      const claimed = await client.claim({
        master_id: config.node_id,
        master_name: config.node_name,
        master_agent_url: reachableAgentUrl(config),
        master_command_token: peer.command_token,
        master_mac: config.remote.mac || null,
        master_broadcasts: config.remote.broadcasts || []
      });
      peer.child_node_id = claimed.node_id || peer.child_node_id || null;
      peer.claimed_at = claimed.paired_at || utcNow();
      this.#applyNetworkIdentity(peer, claimed, satellite);
    }
  }

  #applyNetworkIdentity(peer, details, satellite) {
    peer.mac = normalizeMacAddress(details?.mac || satellite?.mac || peer.mac) || null;
    peer.broadcasts = [...new Set(
      (Array.isArray(details?.broadcasts) && details.broadcasts.length
        ? details.broadcasts
        : Array.isArray(satellite?.broadcasts) && satellite.broadcasts.length
          ? satellite.broadcasts
          : peer.broadcasts || [])
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean)
    )];
  }
}
