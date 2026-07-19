import { DEFAULT_AGENT_PORT } from "../shared/constants.js";
import { detectRemoteNetworkIdentity, normalizeMacAddress } from "../network/identity.js";
import { displayPairingIdentifier, normalizePairingIdentifier } from "../pairing/mdns.js";
import { PeerAgentClient } from "../service/peer-agent-client.js";

// -----------------------------------------------------------------------------
// Manual Satellite endpoint parsing
// -----------------------------------------------------------------------------

export function parseSatelliteAgentAddress(value, explicitPort = null) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Enter the Satellite agent address.");
  const normalized = raw.includes("://") ? raw : `http://${raw}`;
  const parsed = new URL(normalized);
  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("The Satellite agent address must be a valid HTTP or HTTPS address.");
  }

  const rawPort = String(explicitPort ?? "").trim();
  const selectedPort = rawPort ? Number(rawPort) : (parsed.port ? Number(parsed.port) : DEFAULT_AGENT_PORT);
  if (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) {
    throw new Error("The Satellite agent port must be an integer between 1 and 65535.");
  }

  const hostForUrl = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
  return {
    scheme: parsed.protocol.slice(0, -1),
    host: parsed.hostname,
    port: selectedPort,
    url: `${parsed.protocol}//${hostForUrl}:${selectedPort}`
  };
}

export function hasManualSatelliteInput(values = {}) {
  return [
    values.manual_satellite_address,
    values.manual_satellite_agent_port,
    values.manual_satellite_token,
    values.manual_satellite_name
  ].some((value) => String(value || "").trim());
}

// -----------------------------------------------------------------------------
// Manual Satellite inspection
// -----------------------------------------------------------------------------

export async function inspectManualSatellite({
  address,
  port = null,
  token,
  name = null,
  masterId,
  masterName,
  requiredCapabilities = ["proxy_entities"],
  existingPeers = [],
  clientFactory = (baseUrl, pairingToken) => new PeerAgentClient(baseUrl, pairingToken),
  detectNetwork = detectRemoteNetworkIdentity
}) {
  const endpoint = parseSatelliteAgentAddress(address, port);
  const pairingToken = String(token || "").trim();
  if (pairingToken.length < 16) throw new Error("Enter the Satellite pairing token.");

  const client = clientFactory(endpoint.url, pairingToken);
  const protocol = await client.capabilities({ requiredCapabilities });
  const details = await client.validatePairing({ master_id: masterId, master_name: masterName });
  const normalizedIdentifier = normalizePairingIdentifier(details?.identifier || details?.pairing_identifier);
  if (normalizedIdentifier.length < 8) throw new Error("The endpoint did not return a valid Remote Sync Satellite identifier.");
  if (details?.role && details.role !== "child") throw new Error("The entered endpoint is not configured as a Satellite.");
  if (details?.paired_master_id && details.paired_master_id !== masterId && details.ready_to_pair === false) {
    throw new Error("This Satellite is already paired with a different Primary.");
  }

  const identifier = displayPairingIdentifier(normalizedIdentifier);
  const existing = existingPeers.find((peer) => normalizePairingIdentifier(peer?.identifier) === normalizedIdentifier) || null;
  const network = await detectNetwork({
    host: endpoint.host,
    fallbackMac: details?.mac || existing?.mac || null,
    fallbackBroadcasts: Array.isArray(details?.broadcasts) && details.broadcasts.length
      ? details.broadcasts
      : (existing?.broadcasts || []),
    preferWireless: false
  });

  return {
    identifier,
    name: String(name || "").trim() || details?.node_name || existing?.name || identifier,
    address: endpoint.host,
    hostname: null,
    port: endpoint.port,
    url: endpoint.url,
    version: details?.version || protocol.version || null,
    node_id: details?.node_id || existing?.child_node_id || null,
    ready: true,
    mac: normalizeMacAddress(details?.mac || network.mac || existing?.mac) || null,
    broadcasts: Array.isArray(details?.broadcasts) && details.broadcasts.length
      ? [...new Set(details.broadcasts.map(String))]
      : (network.broadcasts.length ? network.broadcasts : (existing?.broadcasts || [])),
    interface: details?.network_interface || network.interface || null,
    network_source: details?.network_source || network.source || "manual",
    protocol,
    discovery: "manual",
    existing,
    manual: true,
    manualToken: pairingToken
  };
}
