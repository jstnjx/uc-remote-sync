import { DEFAULT_AGENT_PORT, DEFAULT_SECTIONS, DEFAULT_SYNC_INTERVAL_SECONDS, DEFAULT_VIRTUAL_DOCK_PORT, SCHEMA_VERSION } from "./constants.js";
import { displayPairingIdentifier, normalizePairingIdentifier } from "./pairing-mdns.js";
import { utcNow } from "./util.js";

export function endpointBaseUrl(endpoint) {
  const netloc = endpoint.port ? `${endpoint.host}:${endpoint.port}` : endpoint.host;
  return `${endpoint.scheme || "http"}://${netloc}/api`;
}

export function endpointWsUrl(endpoint) {
  const netloc = endpoint.port ? `${endpoint.host}:${endpoint.port}` : endpoint.host;
  return `${endpoint.scheme === "https" ? "wss" : "ws"}://${netloc}/ws`;
}

function normalizePeer(item, index) {
  const explicitIdentifier = item.identifier || item.pairing_identifier || (String(item.peer_id || "").startsWith("rms-") ? item.peer_id : null);
  const normalized = normalizePairingIdentifier(explicitIdentifier);
  const identifier = normalized.length >= 8 ? displayPairingIdentifier(normalized) : null;
  const fallbackPeerId = String(item.peer_id || item.name || `child-${index + 1}`).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return {
    peer_id: normalized ? `rms-${normalized.toLowerCase()}` : fallbackPeerId,
    identifier: identifier || null,
    name: String(item.name || identifier || item.peer_id || `Child ${index + 1}`),
    url: item.url ? String(item.url).replace(/\/$/, "") : null,
    token: String(item.token || ""),
    mac: item.mac ? String(item.mac) : null,
    broadcasts: Array.isArray(item.broadcasts) ? item.broadcasts.map(String) : [],
    enabled: item.enabled !== false,
    child_node_id: item.child_node_id ? String(item.child_node_id) : null,
    claimed_at: item.claimed_at ? String(item.claimed_at) : null,
    command_token: item.command_token ? String(item.command_token) : null
  };
}

export function normalizeConfig(data) {
  const remote = data.remote || {};
  const sync = data.sync || {};
  const sourceSchemaVersion = Number(data.schema_version || 0);
  const normalizedSections = Array.isArray(sync.sections)
    ? sync.sections.map(String).filter((item) => DEFAULT_SECTIONS.includes(item))
    : [...DEFAULT_SECTIONS];
  if (sourceSchemaVersion > 0 && sourceSchemaVersion < 5 && !normalizedSections.includes("docks")) normalizedSections.push("docks");
  const role = data.role === "child" ? "child" : "master";
  const normalizedPairingIdentifier = normalizePairingIdentifier(data.pairing_identifier);
  const pairingIdentifier = normalizedPairingIdentifier.length >= 8 ? displayPairingIdentifier(normalizedPairingIdentifier) : null;
  const pairing = data.pairing || {};
  const physicalDocks = data.physical_docks && typeof data.physical_docks === "object" ? data.physical_docks : {};
  const dockTokens = physicalDocks.tokens && typeof physicalDocks.tokens === "object" && !Array.isArray(physicalDocks.tokens)
    ? Object.fromEntries(Object.entries(physicalDocks.tokens)
      .map(([dockId, token]) => [String(dockId).trim(), String(token || "").trim()])
      .filter(([dockId, token]) => dockId && token))
    : {};
  const pairedMasterId = pairing.paired_master_id ? String(pairing.paired_master_id) : null;
  return {
    schema_version: SCHEMA_VERSION,
    role,
    node_id: String(data.node_id),
    node_name: String(data.node_name || data.node_id),
    pairing_identifier: pairingIdentifier || null,
    pairing: {
      ready_to_pair: role === "child" ? (pairing.ready_to_pair !== false && !pairedMasterId) : false,
      paired_master_id: pairedMasterId,
      paired_master_name: pairing.paired_master_name ? String(pairing.paired_master_name) : null,
      paired_at: pairing.paired_at ? String(pairing.paired_at) : null,
      master_agent_url: pairing.master_agent_url ? String(pairing.master_agent_url).replace(/\/$/, "") : null,
      master_command_token: pairing.master_command_token ? String(pairing.master_command_token) : null,
      master_mac: pairing.master_mac ? String(pairing.master_mac) : null,
      master_broadcasts: Array.isArray(pairing.master_broadcasts) ? pairing.master_broadcasts.map(String) : []
    },
    remote: {
      host: String(remote.host),
      api_key: String(remote.api_key),
      scheme: String(remote.scheme || "http"),
      port: remote.port ? Number(remote.port) : null,
      mac: remote.mac ? String(remote.mac) : null,
      broadcasts: Array.isArray(remote.broadcasts) ? remote.broadcasts.map(String) : [],
      verify_tls: remote.verify_tls !== false
    },
    agent_token: String(data.agent_token),
    agent_port: Number(data.agent_port || DEFAULT_AGENT_PORT),
    agent_public_url: data.agent_public_url ? String(data.agent_public_url).replace(/\/$/, "") : null,
    virtual_dock_port: Number(data.virtual_dock_port || DEFAULT_VIRTUAL_DOCK_PORT),
    physical_docks: {
      default_token: String(physicalDocks.default_token || "").trim(),
      tokens: dockTokens
    },
    peers: Array.isArray(data.peers) ? data.peers.map(normalizePeer) : [],
    sync: {
      sections: normalizedSections,
      interval_seconds: Math.max(30, Number(sync.interval_seconds || DEFAULT_SYNC_INTERVAL_SECONDS)),
      auto_sync: sync.auto_sync !== false,
      prune: sync.prune === true,
      use_standby_inhibitor: sync.use_standby_inhibitor !== false,
      verify_existing_resource_hashes: sync.verify_existing_resource_hashes === true
    }
  };
}

export function redactConfig(config) {
  if (!config) return null;
  const copy = structuredClone(config);
  copy.remote.api_key = "***";
  copy.agent_token = "***";
  if (copy.physical_docks?.default_token) copy.physical_docks.default_token = "***";
  if (copy.physical_docks?.tokens) {
    for (const dockId of Object.keys(copy.physical_docks.tokens)) copy.physical_docks.tokens[dockId] = "***";
  }
  for (const peer of copy.peers) { peer.token = "***"; if (peer.command_token) peer.command_token = "***"; }
  if (copy.pairing?.master_command_token) copy.pairing.master_command_token = "***";
  return copy;
}

export function createStatus(state = "unconfigured") {
  return {
    state,
    last_sync_at: null,
    last_sync_result: "Never synchronized",
    last_snapshot_hash: null,
    pending_changes: false,
    successful_syncs: 0,
    failed_syncs: 0,
    peer_results: {}
  };
}

export function createApplyReport(operationId) {
  return {
    operation_id: operationId,
    started_at: utcNow(),
    finished_at: null,
    success: false,
    duplicate: false,
    counts: {},
    mappings: {},
    warnings: [],
    errors: []
  };
}

export function incrementReport(report, key, count = 1) {
  report.counts[key] = (report.counts[key] || 0) + count;
}

export function finishReport(report, success) {
  report.finished_at = utcNow();
  report.success = success;
  return report;
}
