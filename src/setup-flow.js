import crypto from "node:crypto";
import * as uc from "./integration-api.js";
import { DEFAULT_AGENT_PORT, DEFAULT_SECTIONS, DEFAULT_SYNC_INTERVAL_SECONDS, SCHEMA_VERSION } from "./constants.js";
import { CoreApiError, CoreClient } from "./core-client.js";
import { normalizeConfig } from "./models.js";
import { isPairingIdentifier } from "./pairing-config.js";
import { displayPairingIdentifier, generatePairingIdentifier, normalizePairingIdentifier, RemoteSyncDiscovery } from "./pairing-mdns.js";
import { reachableAgentUrl, secureToken, utcNow } from "./util.js";
import { logger } from "./logger.js";

const log = logger("setup");
const Step = Object.freeze({ Role: 1, ChildPin: 2, MasterSettings: 3, ApproveKey: 4, ChildPairing: 5 });

export class SetupFlow {
  constructor(store, onConfigured, { discovery = new RemoteSyncDiscovery({ timeoutMs: 3000 }) } = {}) {
    this.store = store;
    this.onConfigured = onConfigured;
    this.discovery = discovery;
    this.step = Step.Role;
    this.pending = null;
    this.masterChildren = [];
  }

  async handler(message) {
    if (message instanceof uc.DriverSetupRequest) {
      this.pending = null;
      const existing = message.reconfigure ? this.store.load() : null;
      if (existing?.role === "child") {
        this.step = Step.ChildPin;
        return this.#childPinForm();
      }
      if (existing?.role === "master") {
        this.step = Step.MasterSettings;
        return this.#masterForm(existing);
      }
      this.step = Step.Role;
      return this.#roleForm();
    }

    if (message instanceof uc.UserDataResponse) {
      if (this.step === Step.Role) return this.#handleRole(message.inputValues);
      if (this.step === Step.ChildPin) return this.#handleChildPin(message.inputValues);
      if (this.step === Step.MasterSettings) return this.#handleMasterSettings(message.inputValues);
      return new uc.SetupError();
    }

    if (message instanceof uc.UserConfirmationResponse) {
      if (!message.confirm) return new uc.SetupError();
      if (this.step === Step.ApproveKey) return this.#handleApproval();
      if (this.step === Step.ChildPairing) {
        this.step = Step.Role;
        this.pending = null;
        return new uc.SetupComplete();
      }
    }

    if (message instanceof uc.AbortDriverSetup) {
      this.pending = null;
      this.masterChildren = [];
      this.step = Step.Role;
      return new uc.SetupError();
    }
    return new uc.SetupError();
  }

  #roleForm() {
    return new uc.RequestUserInput({ en: "Choose this Remote Sync role" }, [
      this.#dropdown("role", "Role", "child", [["child", "Child remote"], ["master", "Master remote / external master"]])
    ]);
  }

  async #handleRole(values) {
    const role = values.role;
    if (role === "child") {
      this.step = Step.ChildPin;
      return this.#childPinForm();
    }
    if (role === "master") {
      this.step = Step.MasterSettings;
      return this.#masterForm(null);
    }
    return new uc.SetupError(uc.IntegrationSetupError.Other);
  }

  #childPinForm(error = null) {
    const settings = [];
    if (error) settings.push(this.#label("error", "Setup error", error));
    settings.push(this.#text("pin", "Web-configurator PIN", "", 'Remote Sync creates a dedicated API key. Enable "Keep Wi-Fi connected during standby" before continuing.'));
    return new uc.RequestUserInput({ en: "Set up child remote" }, settings);
  }

  async #masterForm(existing, { values = null, error = null, reuseChildren = false } = {}) {
    if (!reuseChildren) this.masterChildren = await this.#discoverMasterChildren(existing);
    const previous = values || {};
    const syncSections = new Set(existing?.sync?.sections || DEFAULT_SECTIONS);
    const value = (key, fallback = "") => Object.prototype.hasOwnProperty.call(previous, key) ? previous[key] : fallback;
    const settings = [];

    if (error) settings.push(this.#label("error", "Setup error", error));
    settings.push(
      this.#label("requirements", "Required remote setting", 'Enable "Keep Wi-Fi connected during standby" on the master and every child remote. Remote Sync still uses WoWLAN after a transport failure.'),
      this.#text("node_name", "Master name", value("node_name", existing?.node_name || "Remote Sync Master")),
      this.#text("remote_address", "Master remote address", value("remote_address", existing?.remote?.host || "127.0.0.1"), "Use 127.0.0.1 when installed on the master remote. Enter the remote IP when running externally."),
      this.#text("pin", "Web-configurator PIN", "", existing ? "Leave empty to retain the existing API key." : "Used once to create a dedicated API key."),
      this.#dropdown("keep_wifi_confirmed", "Keep Wi-Fi connected during standby", value("keep_wifi_confirmed", "yes"), [["yes", "Enabled"], ["no", "Not enabled"]]),
      this.#text("mac", "Master Wi-Fi MAC", value("mac", existing?.remote?.mac || ""), "Optional WoWLAN fallback for the master Core connection."),
      this.#text("broadcasts", "Master WoWLAN broadcast addresses", value("broadcasts", (existing?.remote?.broadcasts || []).join(","))),
      this.#text("agent_public_url", "Advanced master agent URL override", value("agent_public_url", existing?.agent_public_url || "")),
      this.#text(
        "physical_dock_tokens",
        "Physical Dock API token(s)",
        "",
        existing?.physical_docks?.default_token || Object.keys(existing?.physical_docks?.tokens || {}).length
          ? "Leave empty to retain stored Dock tokens. Enter one token for all Docks, or comma-separated DOCK_ID=token overrides."
          : "Required for Dock proxying because Core does not return stored Dock tokens. Enter one token for all Docks, or comma-separated DOCK_ID=token overrides."
      ),
      this.#text("sync_interval", "Automatic sync interval in seconds", value("sync_interval", String(existing?.sync?.interval_seconds || DEFAULT_SYNC_INTERVAL_SECONDS))),
      this.#dropdown("auto_sync", "Automatic synchronization", value("auto_sync", existing?.sync?.auto_sync === false ? "no" : "yes"), [["yes", "Enabled"], ["no", "Disabled"]]),
      this.#dropdown("prune", "Remove deleted synchronized objects", value("prune", existing?.sync?.prune ? "yes" : "no"), [["no", "Disabled"], ["yes", "Enabled"]]),
      this.#dropdown("standby_inhibitor", "Use standby inhibitor for child updates", value("standby_inhibitor", existing?.sync?.use_standby_inhibitor === false ? "no" : "yes"), [["yes", "Enabled"], ["no", "Disabled"]]),
      this.#dropdown("verify_resource_hashes", "Verify existing child resource hashes", value("verify_resource_hashes", existing?.sync?.verify_existing_resource_hashes ? "yes" : "no"), [["no", "Disabled"], ["yes", "Enabled"]])
    );

    for (const section of DEFAULT_SECTIONS) {
      settings.push(this.#dropdown(`section_${section}`, `Synchronize ${section.replaceAll("_", " ")}`, value(`section_${section}`, syncSections.has(section) ? "yes" : "no"), [["yes", "Enabled"], ["no", "Disabled"]]));
    }

    settings.push(this.#label("children_header", "Child remotes", "All child remotes currently advertising that they are ready to pair are shown below. Enter the displayed pairing token for every ready child."));
    if (!this.masterChildren.length) {
      settings.push(this.#label("no_children", "No children discovered", "Complete child setup first, keep the child awake, then restart or re-open master setup."));
    }

    for (const child of this.masterChildren) {
      const key = this.#childKey(child.identifier);
      const status = child.ready ? "Ready to pair" : "Previously paired; not currently in pairing mode";
      const endpoint = child.url || child.existing?.url || child.hostname || "address unavailable";
      settings.push(
        this.#label(`child_info_${key}`, child.name || child.identifier, `${child.identifier} — ${status} — ${endpoint}`),
        this.#text(`child_token_${key}`, "Pairing token", "", child.existing ? "Leave empty to retain the saved token. A token is required when the child is ready to pair." : "Enter the token displayed by this child remote."),
        this.#text(`child_name_${key}`, "Friendly name", value(`child_name_${key}`, child.existing?.name || child.name || child.identifier)),
        this.#text(`child_mac_${key}`, "Child Wi-Fi MAC", value(`child_mac_${key}`, child.existing?.mac || ""), "Optional WoWLAN fallback."),
        this.#text(`child_broadcasts_${key}`, "Child WoWLAN broadcast addresses", value(`child_broadcasts_${key}`, (child.existing?.broadcasts || []).join(",")))
      );
    }
    return new uc.RequestUserInput({ en: "Configure Remote Sync master" }, settings);
  }

  async #discoverMasterChildren(existing) {
    let discovered = [];
    try { discovered = await this.discovery.discoverReady(); }
    catch (error) { log.warn("Child discovery failed:", error.message); }
    const existingByIdentifier = new Map((existing?.peers || []).filter((peer) => peer.identifier).map((peer) => [normalizePairingIdentifier(peer.identifier), peer]));
    const children = [];
    const seen = new Set();
    for (const item of discovered) {
      const normalized = normalizePairingIdentifier(item.identifier);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      children.push({ ...item, identifier: displayPairingIdentifier(item.identifier), ready: true, existing: existingByIdentifier.get(normalized) || null });
    }
    for (const peer of existing?.peers || []) {
      const normalized = normalizePairingIdentifier(peer.identifier);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      children.push({
        identifier: displayPairingIdentifier(peer.identifier),
        name: peer.name,
        url: peer.url,
        hostname: null,
        address: null,
        port: null,
        ready: false,
        existing: peer
      });
    }
    return children.sort((a, b) => String(a.name || a.identifier).localeCompare(String(b.name || b.identifier)));
  }

  async #handleChildPin(values) {
    const pin = String(values.pin || "").trim();
    if (!pin) return this.#childPinForm("Enter the child remote's web-configurator PIN.");
    try {
      const address = this.#parseRemoteAddress(process.env.REMOTE_SYNC_CHILD_REMOTE_ADDRESS || "127.0.0.1");
      const provisioned = await CoreClient.provisionApiKey(address.host, pin, { name: `Remote Sync Child ${crypto.randomBytes(5).toString("hex")}`, scheme: address.scheme, port: address.port });
      const existing = this.store.load();
      const remote = {
        host: address.host,
        api_key: provisioned.apiKey,
        scheme: address.scheme,
        port: address.port,
        mac: existing?.role === "child" ? existing.remote.mac : null,
        broadcasts: existing?.role === "child" ? existing.remote.broadcasts : [],
        verify_tls: address.scheme === "https"
      };
      const client = new CoreClient(remote);
      const version = await client.version();
      if (provisioned.active) await client.integrations();
      const pairingIdentifier = isPairingIdentifier(existing?.pairing_identifier) ? existing.pairing_identifier : generatePairingIdentifier();
      const config = normalizeConfig({
        schema_version: SCHEMA_VERSION,
        role: "child",
        node_id: this.#nodeId(version, address.host),
        node_name: version?.device_name || version?.hostname || existing?.node_name || "Remote Sync Child",
        pairing_identifier: pairingIdentifier,
        pairing: { ready_to_pair: true, paired_master_id: null, paired_master_name: null, paired_at: null },
        remote,
        agent_token: secureToken(),
        agent_port: DEFAULT_AGENT_PORT,
        agent_public_url: null,
        peers: [],
        sync: this.#defaultSync()
      });
      this.pending = { role: "child", config };
      if (!provisioned.active) {
        this.step = Step.ApproveKey;
        return this.#approvalPrompt();
      }
      return this.#finishChild(config);
    } catch (error) {
      log.warn("Child setup failed:", error);
      return this.#childPinForm(this.#setupErrorMessage(error));
    }
  }

  async #handleMasterSettings(values) {
    const existing = this.store.load()?.role === "master" ? this.store.load() : null;
    if (values.keep_wifi_confirmed !== "yes") return this.#masterForm(existing, { values, error: 'Enable "Keep Wi-Fi connected during standby" before continuing.', reuseChildren: true });
    if (!this.masterChildren.length && !existing?.peers?.length) return this.#masterForm(existing, { values, error: "No child remotes are advertising that they are ready to pair.", reuseChildren: true });

    try {
      const address = this.#parseRemoteAddress(values.remote_address || "");
      const pin = String(values.pin || "").trim();
      let apiKey;
      let active = true;
      if (pin) {
        const result = await CoreClient.provisionApiKey(address.host, pin, { name: `Remote Sync Master ${crypto.randomBytes(5).toString("hex")}`, scheme: address.scheme, port: address.port });
        apiKey = result.apiKey;
        active = result.active;
      } else if (existing) apiKey = existing.remote.api_key;
      else return this.#masterForm(existing, { values, error: "Enter the master remote's web-configurator PIN.", reuseChildren: true });

      const remote = {
        host: address.host,
        api_key: apiKey,
        scheme: address.scheme,
        port: address.port,
        mac: String(values.mac || "").trim() || null,
        broadcasts: this.#splitCsv(values.broadcasts || ""),
        verify_tls: address.scheme === "https"
      };
      const client = new CoreClient(remote);
      const version = await client.version();
      if (active) await client.integrations();
      const peers = this.#peersFromMasterForm(values);
      const sections = DEFAULT_SECTIONS.filter((section) => values[`section_${section}`] !== "no");
      const physicalDocks = this.#physicalDockTokens(values.physical_dock_tokens, existing?.physical_docks);
      if (sections.includes("docks") && !physicalDocks.default_token && !Object.keys(physicalDocks.tokens || {}).length) {
        return this.#masterForm(existing, {
          values,
          error: "Enter the physical Dock API token, provide per-Dock token mappings, or disable Dock synchronization.",
          reuseChildren: true
        });
      }
      const config = normalizeConfig({
        schema_version: SCHEMA_VERSION,
        role: "master",
        node_id: this.#nodeId(version, address.host),
        node_name: String(values.node_name || "").trim() || version?.device_name || "Remote Sync Master",
        pairing_identifier: null,
        pairing: { ready_to_pair: false, paired_master_id: null, paired_master_name: null, paired_at: null },
        remote,
        agent_token: existing?.agent_token || secureToken(),
        agent_port: DEFAULT_AGENT_PORT,
        agent_public_url: String(values.agent_public_url || "").trim() || null,
        physical_docks: physicalDocks,
        peers,
        sync: {
          sections,
          interval_seconds: Math.max(30, Number(values.sync_interval || DEFAULT_SYNC_INTERVAL_SECONDS)),
          auto_sync: values.auto_sync !== "no",
          prune: values.prune === "yes",
          use_standby_inhibitor: values.standby_inhibitor !== "no",
          verify_existing_resource_hashes: values.verify_resource_hashes === "yes"
        }
      });
      this.pending = { role: "master", config, values, existing };
      if (!active) {
        this.step = Step.ApproveKey;
        return this.#approvalPrompt();
      }
      return this.#finishMaster(config, values, existing);
    } catch (error) {
      log.warn("Master setup failed:", error);
      return this.#masterForm(existing, { values, error: this.#setupErrorMessage(error), reuseChildren: true });
    }
  }

  #peersFromMasterForm(values) {
    return this.masterChildren.map((child) => {
      const key = this.#childKey(child.identifier);
      const enteredToken = String(values[`child_token_${key}`] || "").trim();
      const token = enteredToken || child.existing?.token || "";
      if (child.ready && token.length < 16) throw new Error(`Enter the pairing token for ${child.name || child.identifier}.`);
      if (!token) throw new Error(`No saved pairing token exists for ${child.name || child.identifier}.`);
      return {
        peer_id: `rms-${normalizePairingIdentifier(child.identifier).toLowerCase()}`,
        identifier: displayPairingIdentifier(child.identifier),
        name: String(values[`child_name_${key}`] || "").trim() || child.name || child.identifier,
        url: child.existing?.identifier ? null : (child.existing?.url || null),
        token,
        mac: String(values[`child_mac_${key}`] || "").trim() || null,
        broadcasts: this.#splitCsv(values[`child_broadcasts_${key}`] || ""),
        enabled: true,
        child_node_id: child.existing?.child_node_id || null,
        claimed_at: child.existing?.claimed_at || null,
        command_token: child.existing?.command_token || secureToken()
      };
    });
  }

  #physicalDockTokens(value, existing = null) {
    const raw = String(value || "").trim();
    if (!raw) {
      return existing && typeof existing === "object"
        ? structuredClone(existing)
        : { default_token: "", tokens: {} };
    }
    if (!raw.includes("=")) return { default_token: raw, tokens: {} };

    const tokens = {};
    for (const entry of raw.split(/[;,\n]+/)) {
      const separator = entry.indexOf("=");
      if (separator < 1) continue;
      const dockId = entry.slice(0, separator).trim();
      const token = entry.slice(separator + 1).trim();
      if (dockId && token) tokens[dockId] = token;
    }
    if (!Object.keys(tokens).length) throw new Error("Invalid Dock token mapping. Use DOCK_ID=token separated by commas.");
    return { default_token: "", tokens };
  }

  async #finishMaster(config, values, existing) {
    try {
      const readyChildren = this.masterChildren.filter((child) => child.ready);
      for (const child of readyChildren) {
        const peer = config.peers.find((item) => normalizePairingIdentifier(item.identifier) === normalizePairingIdentifier(child.identifier));
        const details = await this.#pairingRequest(child.url, peer.token, "validate", { master_id: config.node_id, master_name: config.node_name });
        peer.child_node_id = details.node_id || null;
      }
      for (const child of readyChildren) {
        const peer = config.peers.find((item) => normalizePairingIdentifier(item.identifier) === normalizePairingIdentifier(child.identifier));
        const details = await this.#pairingRequest(child.url, peer.token, "claim", {
          master_id: config.node_id,
          master_name: config.node_name,
          master_agent_url: reachableAgentUrl(config),
          master_command_token: peer.command_token,
          master_mac: config.remote.mac || null,
          master_broadcasts: config.remote.broadcasts || []
        });
        peer.child_node_id = details.node_id || peer.child_node_id || null;
        peer.claimed_at = details.paired_at || utcNow();
      }
      this.store.save(config);
      await this.onConfigured(config);
      this.pending = null;
      this.step = Step.Role;
      return new uc.SetupComplete();
    } catch (error) {
      log.warn("Child pairing failed:", error);
      this.step = Step.MasterSettings;
      return this.#masterForm(existing, { values, error: error.message, reuseChildren: true });
    }
  }

  async #pairingRequest(baseUrl, token, action, body) {
    if (!baseUrl) throw new Error("A discovered child has no reachable pairing URL.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/pairing/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      let result = {};
      try { result = text ? JSON.parse(text) : {}; } catch { result = { error: text }; }
      if (!response.ok) {
        if (response.status === 401) throw new Error(`Invalid pairing token for ${result.identifier || "child remote"}.`);
        throw new Error(result.error || `Child pairing failed with HTTP ${response.status}.`);
      }
      return result;
    } catch (error) {
      if (error.name === "AbortError") throw new Error(`Timed out while pairing ${baseUrl}.`);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async #handleApproval() {
    if (!this.pending?.config) return new uc.SetupError();
    try { await new CoreClient(this.pending.config.remote).integrations(); }
    catch (error) {
      if (error instanceof CoreApiError && [401, 403].includes(error.status)) return this.#approvalPrompt("The API key is still waiting for approval.");
      return new uc.SetupError(this.#setupErrorType(error));
    }
    if (this.pending.role === "child") return this.#finishChild(this.pending.config);
    return this.#finishMaster(this.pending.config, this.pending.values, this.pending.existing);
  }

  async #finishChild(config) {
    this.store.save(config);
    await this.onConfigured(config);
    this.step = Step.ChildPairing;
    return new uc.RequestUserConfirmation(
      { en: "Child is ready to pair" },
      { en: `Pairing token:\n${config.agent_token}` },
      undefined,
      { en: `This child is now advertising ${config.pairing_identifier} as ready to pair. Open setup on the master and enter this token in the field for ${config.node_name}.` }
    );
  }

  #approvalPrompt(message = "Approve the Remote Sync API-key request on the remote, then continue.") {
    return new uc.RequestUserConfirmation({ en: "Approve API access" }, { en: message }, undefined, { en: "Continue after approval." });
  }

  #defaultSync() {
    return {
      sections: [...DEFAULT_SECTIONS],
      interval_seconds: DEFAULT_SYNC_INTERVAL_SECONDS,
      auto_sync: false,
      prune: false,
      use_standby_inhibitor: true,
      verify_existing_resource_hashes: false
    };
  }

  #parseRemoteAddress(value) {
    const normalized = String(value || "").includes("://") ? String(value).trim() : `http://${String(value).trim()}`;
    const parsed = new URL(normalized);
    if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid remote address.");
    return { scheme: parsed.protocol.slice(0, -1), host: parsed.hostname, port: parsed.port ? Number(parsed.port) : null };
  }

  #nodeId(version, host) {
    return String(version?.address || version?.hostname || host).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || crypto.randomUUID();
  }

  #childKey(identifier) { return normalizePairingIdentifier(identifier).toLowerCase(); }
  #splitCsv(value) { return String(value || "").split(",").map((item) => item.trim()).filter(Boolean); }
  #setupErrorType(error) {
    if (error instanceof CoreApiError && [401, 403].includes(error.status)) return uc.IntegrationSetupError.AuthorizationError;
    if (error.name === "AbortError") return uc.IntegrationSetupError.Timeout;
    return uc.IntegrationSetupError.Other;
  }
  #setupErrorMessage(error) {
    if (error instanceof CoreApiError && [401, 403].includes(error.status)) return "The PIN or API authorization was rejected.";
    if (error.name === "AbortError") return "The remote did not respond before the setup timeout.";
    return error.message || "Setup failed.";
  }
  #label(id, label, value) { return { id, label: { en: label }, field: { label: { value: { en: value } } } }; }
  #text(id, label, value, description = undefined) { const item = { id, label: { en: label }, field: { text: { value } } }; if (description) item.description = { en: description }; return item; }
  #dropdown(id, label, value, items) { return { id, label: { en: label }, field: { dropdown: { value, items: items.map(([itemId, itemLabel]) => ({ id: itemId, label: { en: itemLabel } })) } } }; }
}
