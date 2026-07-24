import net from "node:net";
import {
  DEFAULT_AGENT_PORT,
  DEFAULT_SECTIONS,
  DEFAULT_SYNC_INTERVAL_SECONDS,
  DEFAULT_VIRTUAL_DOCK_PORT,
  SCHEMA_VERSION
} from "../shared/constants.js";
import { normalizeMacAddress } from "../network/identity.js";
import { displayPairingIdentifier, normalizePairingIdentifier } from "../pairing/mdns.js";

// -----------------------------------------------------------------------------
// Validation primitives
// -----------------------------------------------------------------------------

export class ConfigurationError extends Error {
  constructor(errors, { cause = null } = {}) {
    const list = Array.isArray(errors) ? errors : [String(errors)];
    super(`Remote Sync configuration is invalid: ${list.join("; ")}`, { cause });
    this.name = "ConfigurationError";
    this.errors = list;
    this.code = "CONFIGURATION_INVALID";
  }
}

function text(value) {
  if (value === null || value === undefined) return "";
  const result = String(value).trim();
  return ["undefined", "null"].includes(result.toLowerCase()) ? "" : result;
}

function requiredText(value, field, errors, { min = 1 } = {}) {
  const result = text(value);
  if (result.length < min) errors.push(`${field} is required${min > 1 ? ` and must contain at least ${min} characters` : ""}`);
  return result;
}

function port(value, field, errors, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) errors.push(`${field} must be an integer between 1 and 65535`);
  return result;
}

function url(value, field, errors, { nullable = true, protocols = ["http:", "https:"] } = {}) {
  const result = text(value);
  if (!result && nullable) return null;
  try {
    const parsed = new URL(result);
    if (!protocols.includes(parsed.protocol) || !parsed.hostname) throw new Error();
    return result.replace(/\/$/, "");
  } catch {
    errors.push(`${field} must be a valid ${protocols.map((item) => item.slice(0, -1)).join(" or ")} URL`);
    return result || null;
  }
}

function broadcasts(value, field, errors) {
  const source = Array.isArray(value) ? value : text(value).split(",");
  const result = [...new Set(source.map(text).filter(Boolean))];
  for (const item of result) {
    if (!net.isIPv4(item)) errors.push(`${field} contains invalid IPv4 address ${item}`);
  }
  return result;
}

function mac(value, field, errors) {
  const raw = text(value);
  if (!raw) return null;
  const result = normalizeMacAddress(raw);
  if (!result) errors.push(`${field} must be a valid unicast MAC address`);
  return result;
}

function token(value, field, errors, { min = 16, nullable = false } = {}) {
  const result = text(value);
  if (!result && nullable) return "";
  if (result.length < min) errors.push(`${field} must contain at least ${min} characters`);
  return result;
}

function normalizePeer(item, index, errors) {
  const explicitIdentifier = item?.identifier || item?.pairing_identifier || (text(item?.peer_id).startsWith("rms-") ? item.peer_id : null);
  const normalized = normalizePairingIdentifier(explicitIdentifier);
  const identifier = normalized.length >= 8 ? displayPairingIdentifier(normalized) : null;
  const fallbackPeerId = text(item?.peer_id || item?.name || `satellite-${index + 1}`)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const peerId = requiredText(normalized ? `rms-${normalized.toLowerCase()}` : fallbackPeerId, `peers[${index}].peer_id`, errors);
  return {
    peer_id: peerId,
    identifier,
    name: requiredText(item?.name || identifier || peerId || `Satellite ${index + 1}`, `peers[${index}].name`, errors),
    url: url(item?.url, `peers[${index}].url`, errors),
    token: token(item?.token, `peers[${index}].token`, errors),
    mac: mac(item?.mac, `peers[${index}].mac`, errors),
    broadcasts: broadcasts(item?.broadcasts || [], `peers[${index}].broadcasts`, errors),
    enabled: item?.enabled !== false,
    child_node_id: text(item?.child_node_id) || null,
    claimed_at: text(item?.claimed_at) || null,
    command_token: token(item?.command_token, `peers[${index}].command_token`, errors, { min: 16, nullable: true }) || null,
    protocol: item?.protocol && typeof item.protocol === "object" ? structuredClone(item.protocol) : null
  };
}

// -----------------------------------------------------------------------------
// Schema migrations
// -----------------------------------------------------------------------------

function migrationTo5(config) {
  const next = structuredClone(config);
  next.sync ||= {};
  if (!Array.isArray(next.sync.sections)) next.sync.sections = [...DEFAULT_SECTIONS];
  if (!next.sync.sections.includes("docks")) next.sync.sections.push("docks");
  next.physical_docks ||= { default_token: "", tokens: {} };
  next.virtual_dock_port ||= DEFAULT_VIRTUAL_DOCK_PORT;
  next.schema_version = 5;
  return next;
}

function migrationTo6(config) {
  const next = structuredClone(config);
  next.network_overrides ||= {
    mac: null,
    broadcasts: []
  };
  next.schema_version = 6;
  return next;
}

export function migrateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigurationError("configuration root must be an object");
  let config = structuredClone(input);
  const from = Number(config.schema_version || 0);
  if (from > SCHEMA_VERSION) throw new ConfigurationError(`configuration schema ${from} is newer than supported schema ${SCHEMA_VERSION}`);
  if (Number(config.schema_version || 0) < 5) config = migrationTo5(config);
  if (Number(config.schema_version || 0) < 6) config = migrationTo6(config);
  return { config, migrated: from !== SCHEMA_VERSION, from, to: SCHEMA_VERSION };
}

// -----------------------------------------------------------------------------
// Configuration normalization and validation
// -----------------------------------------------------------------------------

export function normalizeAndValidateConfig(input) {
  const errors = [];
  const { config: data, migrated, from, to } = migrateConfig(input);
  const remote = data.remote && typeof data.remote === "object" ? data.remote : {};
  const sync = data.sync && typeof data.sync === "object" ? data.sync : {};
  const role = data.role === "child" ? "child" : data.role === "master" ? "master" : null;
  if (!role) errors.push("role must be master or child");

  const sourceSections = Array.isArray(sync.sections) ? sync.sections.map(text) : [...DEFAULT_SECTIONS];
  const sections = [...new Set(sourceSections.filter((item) => DEFAULT_SECTIONS.includes(item)))];
  if (!sections.length) errors.push("sync.sections must enable at least one supported section");

  const pairingSource = data.pairing && typeof data.pairing === "object" ? data.pairing : {};
  const pairingNormalized = normalizePairingIdentifier(data.pairing_identifier);
  const pairingIdentifier = pairingNormalized.length >= 8 ? displayPairingIdentifier(pairingNormalized) : null;
  if (role === "child" && !pairingIdentifier) errors.push("pairing_identifier is required for a satellite");
  const pairedMasterId = text(pairingSource.paired_master_id) || null;

  const physicalSource = data.physical_docks && typeof data.physical_docks === "object" ? data.physical_docks : {};
  const dockTokens = {};
  for (const [dockIdRaw, dockTokenRaw] of Object.entries(physicalSource.tokens && typeof physicalSource.tokens === "object" && !Array.isArray(physicalSource.tokens) ? physicalSource.tokens : {})) {
    const dockId = requiredText(dockIdRaw, "physical_docks.tokens dock ID", errors);
    if (!text(dockTokenRaw)) continue;
    const dockToken = token(dockTokenRaw, `physical_docks.tokens.${dockId}`, errors, { min: 4 });
    if (dockId && dockToken) dockTokens[dockId] = dockToken;
  }

  const interval = Number(sync.interval_seconds || DEFAULT_SYNC_INTERVAL_SECONDS);
  if (!Number.isFinite(interval) || interval < 300 || interval > 86_400) errors.push("sync.interval_seconds must be between 300 and 86400");

  const networkOverrides = data.network_overrides && typeof data.network_overrides === "object" ? data.network_overrides : {};
  const result = {
    schema_version: SCHEMA_VERSION,
    role: role || "master",
    node_id: requiredText(data.node_id, "node_id", errors),
    node_name: requiredText(data.node_name || data.node_id, "node_name", errors),
    pairing_identifier: role === "child" ? pairingIdentifier : null,
    pairing: {
      ready_to_pair: role === "child" ? (pairingSource.ready_to_pair !== false && !pairedMasterId) : false,
      paired_master_id: pairedMasterId,
      paired_master_name: text(pairingSource.paired_master_name) || null,
      paired_at: text(pairingSource.paired_at) || null,
      master_agent_url: url(pairingSource.master_agent_url, "pairing.master_agent_url", errors),
      master_command_token: token(pairingSource.master_command_token, "pairing.master_command_token", errors, { nullable: true }) || null,
      master_mac: mac(pairingSource.master_mac, "pairing.master_mac", errors),
      master_broadcasts: broadcasts(pairingSource.master_broadcasts || [], "pairing.master_broadcasts", errors)
    },
    remote: {
      host: requiredText(remote.host, "remote.host", errors),
      api_key: token(remote.api_key, "remote.api_key", errors, { min: 8 }),
      scheme: ["http", "https"].includes(text(remote.scheme).toLowerCase()) ? text(remote.scheme).toLowerCase() : "http",
      port: port(remote.port, "remote.port", errors, null),
      mac: mac(remote.mac, "remote.mac", errors),
      broadcasts: broadcasts(remote.broadcasts || [], "remote.broadcasts", errors),
      interface: text(remote.interface) || null,
      network_source: text(remote.network_source) || null,
      verify_tls: remote.verify_tls !== false
    },
    network_overrides: {
      mac: mac(networkOverrides.mac, "network_overrides.mac", errors),
      broadcasts: broadcasts(networkOverrides.broadcasts || [], "network_overrides.broadcasts", errors)
    },
    agent_token: token(data.agent_token, "agent_token", errors, { min: 32 }),
    agent_port: port(data.agent_port || DEFAULT_AGENT_PORT, "agent_port", errors, DEFAULT_AGENT_PORT),
    agent_public_url: url(data.agent_public_url, "agent_public_url", errors),
    virtual_dock_port: port(data.virtual_dock_port || DEFAULT_VIRTUAL_DOCK_PORT, "virtual_dock_port", errors, DEFAULT_VIRTUAL_DOCK_PORT),
    physical_docks: {
      default_token: token(physicalSource.default_token, "physical_docks.default_token", errors, { min: 4, nullable: true }),
      tokens: dockTokens
    },
    peers: Array.isArray(data.peers) ? data.peers.map((item, index) => normalizePeer(item, index, errors)) : [],
    sync: {
      sections,
      interval_seconds: Math.max(300, Math.min(86_400, Number.isFinite(interval) ? interval : DEFAULT_SYNC_INTERVAL_SECONDS)),
      auto_sync: sync.auto_sync !== false,
      prune: sync.prune === true,
      use_standby_inhibitor: sync.use_standby_inhibitor !== false,
      verify_existing_resource_hashes: sync.verify_existing_resource_hashes === true
    }
  };

  if (errors.length) throw new ConfigurationError(errors);
  return { config: result, migrated, from, to };
}

export function validateConfig(input) {
  return normalizeAndValidateConfig(input).config;
}
