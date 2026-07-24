import { utcNow } from "./util.js";

// -----------------------------------------------------------------------------
// Endpoint helpers
// -----------------------------------------------------------------------------

export function endpointBaseUrl(endpoint) {
  const netloc = endpoint.port ? `${endpoint.host}:${endpoint.port}` : endpoint.host;
  return `${endpoint.scheme || "http"}://${netloc}/api`;
}

export function endpointWsUrl(endpoint) {
  const netloc = endpoint.port ? `${endpoint.host}:${endpoint.port}` : endpoint.host;
  return `${endpoint.scheme === "https" ? "wss" : "ws"}://${netloc}/ws`;
}

// -----------------------------------------------------------------------------
// Configuration normalization
// -----------------------------------------------------------------------------

export { validateConfig as normalizeConfig } from "../config/schema.js";

export function redactConfig(config) {
  if (!config) return null;
  const copy = structuredClone(config);
  copy.remote.api_key = "***";
  copy.agent_token = "***";
  if (copy.physical_docks?.default_token) copy.physical_docks.default_token = "***";
  if (copy.physical_docks?.tokens) {
    for (const dockId of Object.keys(copy.physical_docks.tokens)) copy.physical_docks.tokens[dockId] = "***";
  }
  for (const peer of copy.peers) {
    peer.token = "***";
    if (peer.command_token) peer.command_token = "***";
  }
  if (copy.pairing?.master_command_token) copy.pairing.master_command_token = "***";
  return copy;
}

// -----------------------------------------------------------------------------
// Status and reports
// -----------------------------------------------------------------------------

export function createStatus(state = "unconfigured") {
  return {
    state,
    last_sync_at: null,
    last_sync_result: "Never synchronized",
    last_snapshot_hash: null,
    pending_changes: false,
    successful_syncs: 0,
    failed_syncs: 0,
    peer_results: {},
    last_preview_at: null,
    last_preview_result: null,
    configuration_errors: [],
    telemetry: { builds: 0, suppressed_builds: 0, retries: 0, last_build_reason: null, last_build_ms: null, last_compression_ms: null, last_payload_bytes: null, last_uncompressed_bytes: null, last_resource_count: 0, rss_bytes: 0, heap_used_bytes: 0, event_loop_delay_ms: 0 }
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
