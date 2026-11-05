import { APP_VERSION, DEFAULT_AGENT_PORT, DRIVER_ID } from "../shared/constants.js";
import { CoreApiError, CoreClient } from "../core/client.js";
import { PeerAgentClient } from "./peer-agent-client.js";
import { buildDriverArchive } from "../shared/package.js";
import { compareVersions, isTransportError, sleep } from "../shared/util.js";
import { messageText } from "../integration/api.js";
import { logger } from "../shared/logger.js";

const log = logger("satellite-provisioner");

// -----------------------------------------------------------------------------
// Satellite provisioning by address and Web Configurator PIN
//
// 1. Create an admin API key on the Satellite's Core with its PIN (kept as the Primary's management key).
// 2. Install or update Remote Sync on the Satellite with `POST /api/intg/install` using the Primary's own code.
// 3. If Remote Sync is installed but not configured, run its setup remotely through `/api/intg/setup`.
// 4. Pair through `POST /v1/pairing/pin`, authenticated with the management key instead of a copied token.
// 5. Enable Wake on WLAN on the Satellite when it is off.
// -----------------------------------------------------------------------------

export class SatelliteProvisioningError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message, { cause });
    this.name = "SatelliteProvisioningError";
    this.status = status;
  }
}

function parseCoreAddress(value, explicitPort = null) {
  const raw = String(value || "").trim();
  if (!raw) throw new SatelliteProvisioningError("Enter the Satellite address.");
  const parsed = new URL(raw.includes("://") ? raw : `http://${raw}`);
  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) throw new SatelliteProvisioningError("Invalid Satellite address.");
  const rawPort = String(explicitPort ?? "").trim();
  const port = rawPort ? Number(rawPort) : (parsed.port ? Number(parsed.port) : null);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new SatelliteProvisioningError("The Satellite HTTP port must be between 1 and 65535.");
  return { scheme: parsed.protocol.slice(0, -1), host: parsed.hostname, port };
}

function agentUrlFor(host, agentPort) {
  const hostForUrl = host.includes(":") ? `[${host}]` : host;
  return `http://${hostForUrl}:${agentPort || DEFAULT_AGENT_PORT}`;
}

// -----------------------------------------------------------------------------
// Remote driver setup through the Core REST API
// -----------------------------------------------------------------------------

function settingValue(setting, answers) {
  const id = String(setting?.id || "");
  if (Object.prototype.hasOwnProperty.call(answers, id)) return String(answers[id]);
  const field = setting?.field || {};
  if (field.label) return undefined;
  if (field.checkbox) return String(Boolean(field.checkbox.value));
  if (field.number) return String(field.number.value ?? "");
  if (field.dropdown) return String(field.dropdown.value ?? field.dropdown.items?.[0]?.id ?? "");
  if (field.text) return String(field.text.value ?? "");
  if (field.textarea) return String(field.textarea.value ?? "");
  if (field.password) return String(field.password.value ?? "");
  return undefined;
}

export async function runRemoteDriverSetup(core, {
  driverId = DRIVER_ID,
  setupData = {},
  answers = {},
  timeoutMs = 180_000,
  pollMs = 1000,
  onProgress = () => {}
} = {}) {
  const current = await core.integrationSetup(driverId);
  if (current && !["OK", "ERROR"].includes(String(current.state || ""))) await core.abortIntegrationSetup(driverId);

  let info;
  try {
    info = await core.startIntegrationSetup({ driverId, setupData });
  } catch (error) {
    // 422: already configured. Reconfigure keeps the existing installation and asks for the PIN again.
    if (!(error instanceof CoreApiError) || error.status !== 422) throw error;
    info = await core.startIntegrationSetup({ driverId, setupData, reconfigure: true });
  }

  const deadline = Date.now() + timeoutMs;
  const answered = new Set();
  let lastKeepAlive = 0;
  while (Date.now() < deadline) {
    const state = String(info?.state || "");
    if (state === "OK") return info;
    if (state === "ERROR") {
      const reason = messageText(info.error_message || "") || info.error || "unknown error";
      throw new SatelliteProvisioningError(`Satellite setup failed: ${reason}`);
    }
    if (state === "WAIT_USER_ACTION" && info.require_user_action) {
      const action = info.require_user_action;
      const signature = JSON.stringify(action);
      if (answered.has(signature)) {
        if (info.error) {
          throw new SatelliteProvisioningError(`Satellite rejected the setup input: ${messageText(info.error_message || "") || info.error}`);
        }
        const labels = (action.input?.settings || []).filter((item) => item.id === "error" && item.field?.label);
        if (labels.length) throw new SatelliteProvisioningError(`Satellite rejected the setup input: ${messageText(labels[0].field.label.value)}`);
      } else if (action.input) {
        answered.add(signature);
        const values = {};
        for (const setting of action.input.settings || []) {
          const value = settingValue(setting, answers);
          if (value !== undefined) values[setting.id] = value;
        }
        onProgress(`Answering Satellite setup page "${messageText(action.input.title || "")}"`);
        info = await core.integrationSetupUserData(driverId, { input_values: values });
        continue;
      } else if (action.confirmation) {
        answered.add(signature);
        onProgress(`Confirming Satellite setup page "${messageText(action.confirmation.title || "")}"`);
        info = await core.integrationSetupUserData(driverId, { confirm: true });
        continue;
      }
    }
    if (Date.now() - lastKeepAlive > 30_000) {
      lastKeepAlive = Date.now();
      try { await core.keepIntegrationSetupAlive(driverId); } catch (error) { log.debug("Setup keep-alive failed:", error.message); }
    }
    await sleep(pollMs);
    info = (await core.integrationSetup(driverId)) || { state: "OK" };
  }
  try { await core.abortIntegrationSetup(driverId); } catch {}
  throw new SatelliteProvisioningError("The Satellite setup did not finish in time.");
}

// -----------------------------------------------------------------------------
// Installation and update
// -----------------------------------------------------------------------------

export async function installOrUpdateDriver(core, {
  driverId = DRIVER_ID,
  targetVersion = APP_VERSION,
  packageBuilder = buildDriverArchive,
  allowInstall = true,
  waitMs = 90_000,
  pollMs = 2000,
  onProgress = () => {}
} = {}) {
  const driver = await core.integrationDriver(driverId);
  const installedVersion = driver?.version || null;
  if (driver && compareVersions(installedVersion, targetVersion) >= 0) return { action: "current", version: installedVersion };
  if (!allowInstall) {
    throw new SatelliteProvisioningError(driver
      ? `The Satellite runs Remote Sync ${installedVersion}; ${targetVersion} or newer is required.`
      : "Remote Sync is not installed on the Satellite.");
  }
  onProgress(driver ? `Updating Remote Sync ${installedVersion} → ${targetVersion} on the Satellite` : `Installing Remote Sync ${targetVersion} on the Satellite`);
  const archive = await packageBuilder();
  try {
    await core.installCustomIntegration(archive, { update: Boolean(driver), filename: `remote-sync-${targetVersion}.tar.gz` });
  } catch (error) {
    if (error instanceof CoreApiError) {
      const reasons = {
        409: "the firmware is not compatible or the maximum number of custom integrations is installed",
        413: "the archive is too large",
        422: "the driver ID is used by another integration",
        503: "another installation is running or the Satellite must be restarted",
        507: "the Satellite has insufficient storage"
      };
      throw new SatelliteProvisioningError(`Installation on the Satellite failed: ${reasons[error.status] || error.message}`, { status: error.status, cause: error });
    }
    throw error;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try {
      const next = await core.integrationDriver(driverId);
      if (next && compareVersions(next.version, targetVersion) >= 0) return { action: driver ? "updated" : "installed", version: next.version, previous: installedVersion };
    } catch (error) {
      if (!isTransportError(error)) throw error;
    }
  }
  throw new SatelliteProvisioningError("Remote Sync was uploaded to the Satellite but did not report the new version in time.");
}

// -----------------------------------------------------------------------------
// Satellite agent availability
// -----------------------------------------------------------------------------

async function agentRole(agentUrl, peerClientFactory) {
  try {
    const capabilities = await peerClientFactory(agentUrl, "").publicCapabilities();
    return capabilities?.service === "remote-sync" ? (capabilities.role || "unconfigured") : null;
  } catch (error) {
    if (isTransportError(error) || error.code === "ETIMEDOUT" || error.code === "ECONNREFUSED") return null;
    throw error;
  }
}

async function waitForAgentRole(agentUrl, peerClientFactory, roles, timeoutMs, pollMs = 2000) {
  const wanted = Array.isArray(roles) ? roles : [roles];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const role = await agentRole(agentUrl, peerClientFactory);
    if (wanted.includes(role)) return role;
    await sleep(pollMs);
  }
  return null;
}

// -----------------------------------------------------------------------------
// Full provisioning
// -----------------------------------------------------------------------------

export async function provisionSatelliteByPin({
  address,
  httpPort = null,
  agentPort = null,
  pin,
  install = true,
  primaryName = "Remote Sync Primary",
  existingCoreApiKey = null,
  coreClientFactory = (endpoint) => new CoreClient(endpoint, { requestTimeoutMs: 15_000 }),
  peerClientFactory = (baseUrl, token) => new PeerAgentClient(baseUrl, token, { timeoutMs: 15_000 }),
  provisionApiKey = CoreClient.provisionApiKey,
  packageBuilder = buildDriverArchive,
  pollMs = 2000,
  onProgress = (message) => log.info(message)
}) {
  const endpoint = parseCoreAddress(address, httpPort);
  const satellitePin = String(pin || "").trim();
  let apiKey = existingCoreApiKey || null;
  let keyName = null;
  if (!apiKey) {
    if (!satellitePin) throw new SatelliteProvisioningError("Enter the Satellite's Web Configurator PIN.");
    onProgress(`Creating a Remote Sync management key on ${endpoint.host}`);
    let provisioned;
    try {
      provisioned = await provisionApiKey(endpoint.host, satellitePin, {
        name: `Remote Sync ${String(primaryName).slice(0, 24)}`,
        description: "Used by the Remote Sync Primary to pair, install and update Remote Sync on this Satellite.",
        scheme: endpoint.scheme,
        port: endpoint.port
      });
    } catch (error) {
      if (error instanceof CoreApiError && [401, 403].includes(error.status)) throw new SatelliteProvisioningError("The Satellite rejected the PIN.", { status: error.status, cause: error });
      if (isTransportError(error)) throw new SatelliteProvisioningError(`The Satellite at ${endpoint.host} is not reachable.`, { cause: error });
      throw error;
    }
    if (!provisioned.active) throw new SatelliteProvisioningError("Approve the Remote Sync API-key request on the Satellite, then try again.");
    apiKey = provisioned.apiKey;
    keyName = provisioned.name || null;
  }

  const core = coreClientFactory({ host: endpoint.host, scheme: endpoint.scheme, port: endpoint.port, api_key: apiKey, verify_tls: endpoint.scheme === "https" });
  try {
    const version = await core.version().catch(() => null);
    const installation = await installOrUpdateDriver(core, { allowInstall: install, packageBuilder, pollMs, onProgress });

    const agentUrl = agentUrlFor(endpoint.host, agentPort);
    let role = await agentRole(agentUrl, peerClientFactory);
    if (role === "master") throw new SatelliteProvisioningError("Remote Sync on that remote is configured as a Primary.");
    if (!["child", "unassigned"].includes(role)) {
      if (!satellitePin) throw new SatelliteProvisioningError("Remote Sync on the Satellite is not set up yet; enter its PIN to set it up.");
      // The integration setup only asks for the PIN, so it is passed as setup data and normally finishes at once.
      onProgress("Setting up Remote Sync on the Satellite");
      await runRemoteDriverSetup(core, {
        setupData: { pin: satellitePin },
        answers: { pin: satellitePin },
        pollMs: Math.min(pollMs, 1000),
        onProgress
      });
      role = await waitForAgentRole(agentUrl, peerClientFactory, ["unassigned", "child"], 60_000, pollMs);
      if (!role) throw new SatelliteProvisioningError("Remote Sync was set up on the Satellite but its agent did not start.");
    } else if (installation.action !== "current") {
      role = (await waitForAgentRole(agentUrl, peerClientFactory, [role], 60_000, pollMs)) || role;
    }

    onProgress(role === "unassigned" ? "Pairing and making the remote a Satellite" : "Pairing with the Satellite");
    const pairing = await peerClientFactory(agentUrl, "").pinPair(apiKey, {});
    const token = String(pairing?.agent_token || "");
    if (token.length < 16) throw new SatelliteProvisioningError("The Satellite did not return a pairing token. Update Remote Sync on the Satellite.");
    if (role === "unassigned" || pairing?.assigned) {
      // The Satellite restarts its agent with the new role.
      if (!await waitForAgentRole(agentUrl, peerClientFactory, ["child"], 60_000, pollMs)) {
        throw new SatelliteProvisioningError("The remote accepted the pairing but did not restart as a Satellite.");
      }
    }

    let wakeOnWlan = null;
    try {
      wakeOnWlan = await core.wakeOnWlan();
      if (wakeOnWlan === false) {
        onProgress("Enabling Wake on WLAN on the Satellite");
        await core.setWakeOnWlan(true);
        wakeOnWlan = true;
      }
    } catch (error) { log.warn("Could not check Wake on WLAN on the Satellite:", error.message); }

    return {
      agentUrl,
      host: endpoint.host,
      scheme: endpoint.scheme,
      port: endpoint.port,
      token,
      coreApiKey: apiKey,
      coreKeyName: keyName,
      installation,
      wakeOnWlan,
      deviceName: version?.device_name || pairing?.node_name || null,
      pairing
    };
  } finally {
    await core.close?.();
  }
}

// Update an already paired Satellite with the stored management key.
export async function updateSatellite(peer, { resolvedUrl = null, coreClientFactory = null, packageBuilder = buildDriverArchive, onProgress = (message) => log.info(message) } = {}) {
  if (!peer?.core_api_key) throw new SatelliteProvisioningError(`No management key is stored for ${peer?.name || "this Satellite"}; add it again by address and PIN.`);
  const host = peer.core_host || new URL(resolvedUrl || peer.url).hostname;
  const factory = coreClientFactory || ((endpoint) => new CoreClient(endpoint, { requestTimeoutMs: 15_000 }));
  const core = factory({ host, scheme: peer.core_scheme || "http", port: peer.core_port || null, api_key: peer.core_api_key, verify_tls: peer.core_scheme === "https", mac: peer.mac, broadcasts: peer.broadcasts || [] });
  try {
    return await installOrUpdateDriver(core, { packageBuilder, onProgress });
  } finally {
    await core.close?.();
  }
}

// Revoke the Primary's management key on a Satellite that is being removed.
export async function revokeManagementKey(peer, { resolvedUrl = null, coreClientFactory = null } = {}) {
  if (!peer?.core_api_key || !peer?.core_key_name) return false;
  const host = peer.core_host || new URL(resolvedUrl || peer.url).hostname;
  const factory = coreClientFactory || ((endpoint) => new CoreClient(endpoint, { requestTimeoutMs: 10_000 }));
  const core = factory({ host, scheme: peer.core_scheme || "http", port: peer.core_port || null, api_key: peer.core_api_key, verify_tls: peer.core_scheme === "https" });
  try { return (await core.deleteApiKeysNamed(peer.core_key_name)) > 0; }
  finally { await core.close?.(); }
}
