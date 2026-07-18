import {
  AGENT_API_VERSION,
  APP_VERSION,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SNAPSHOT_SCHEMA_VERSION
} from "../shared/constants.js";

// -----------------------------------------------------------------------------
// Protocol declaration
// -----------------------------------------------------------------------------

export const CAPABILITIES = Object.freeze([
  "proxy_entities",
  "activity_state",
  "dock_tunnel",
  "automatic_network_identity",
  "satellite_management",
  "credential_rotation",
  "sync_preview"
]);

export function protocolDescriptor(extra = {}) {
  return {
    service: "remote-sync",
    version: APP_VERSION,
    api_version: AGENT_API_VERSION,
    protocol_version: PROTOCOL_VERSION,
    snapshot_schema: SNAPSHOT_SCHEMA_VERSION,
    capabilities: [...CAPABILITIES],
    ...extra
  };
}

// -----------------------------------------------------------------------------
// Compatibility validation
// -----------------------------------------------------------------------------

export class ProtocolCompatibilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProtocolCompatibilityError";
    this.details = details;
    this.status = 409;
  }
}

export function normalizeProtocolDescriptor(value = {}) {
  const protocolVersion = Number(value.protocol_version || 1);
  const apiVersion = Number(value.api_version || 1);
  const snapshotSchema = Number(value.snapshot_schema || value.schema_version || 4);
  return {
    service: String(value.service || "remote-sync"),
    version: String(value.version || "legacy"),
    api_version: Number.isInteger(apiVersion) ? apiVersion : 1,
    protocol_version: Number.isInteger(protocolVersion) ? protocolVersion : 1,
    snapshot_schema: Number.isInteger(snapshotSchema) ? snapshotSchema : 4,
    capabilities: Array.isArray(value.capabilities) ? [...new Set(value.capabilities.map(String))] : []
  };
}

export function assertProtocolCompatibility(value, { requiredCapabilities = [], acceptedSnapshotSchemas = [4, 5, SNAPSHOT_SCHEMA_VERSION] } = {}) {
  const peer = normalizeProtocolDescriptor(value);
  if (peer.service !== "remote-sync") {
    throw new ProtocolCompatibilityError("The endpoint is not a Remote Sync agent", { peer });
  }
  if (peer.api_version !== AGENT_API_VERSION) {
    throw new ProtocolCompatibilityError(`Unsupported agent API version ${peer.api_version}; expected ${AGENT_API_VERSION}`, { peer });
  }
  if (peer.protocol_version < MIN_PROTOCOL_VERSION || peer.protocol_version > PROTOCOL_VERSION) {
    throw new ProtocolCompatibilityError(`Unsupported Remote Sync protocol version ${peer.protocol_version}; supported range is ${MIN_PROTOCOL_VERSION}-${PROTOCOL_VERSION}`, { peer });
  }
  if (!acceptedSnapshotSchemas.includes(peer.snapshot_schema)) {
    throw new ProtocolCompatibilityError(`Unsupported snapshot schema ${peer.snapshot_schema}`, { peer });
  }
  const missing = requiredCapabilities.filter((capability) => !peer.capabilities.includes(capability));
  if (missing.length) {
    throw new ProtocolCompatibilityError(`Satellite ${peer.version} is missing required capabilities: ${missing.join(", ")}`, { peer, missing });
  }
  return peer;
}
