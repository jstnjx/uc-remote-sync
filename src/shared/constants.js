// -----------------------------------------------------------------------------
// Application metadata
// -----------------------------------------------------------------------------

export const APP_NAME = "Remote Sync";
export const DRIVER_ID = "remote_sync";
export const ACTIVITY_RELAY_LOCAL_ID = "activity_relay";
export const ACTIVITY_RELAY_ENTITY_ID = `${DRIVER_ID}.main.${ACTIVITY_RELAY_LOCAL_ID}`;
export const APP_VERSION = "0.8.0";
export const SCHEMA_VERSION = 6;
export const SNAPSHOT_SCHEMA_VERSION = 6;
export const AGENT_API_VERSION = 1;
export const PROTOCOL_VERSION = 2;
export const MIN_PROTOCOL_VERSION = 1;

// -----------------------------------------------------------------------------
// Network and synchronization defaults
// -----------------------------------------------------------------------------

export const DEFAULT_AGENT_PORT = 11081;
export const DEFAULT_INTEGRATION_PORT = 11082;
export const DEFAULT_VIRTUAL_DOCK_PORT = 11083;
export const DEFAULT_SYNC_INTERVAL_SECONDS = 3600;
export const DEFAULT_EVENT_DEBOUNCE_MS = 20_000;
export const MIN_EVENT_SYNC_INTERVAL_MS = 60_000;
export const DEFAULT_OPERATION_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_OPERATION_CACHE_SIZE = 1024;
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const MAX_UNCOMPRESSED_SNAPSHOT_BYTES = 128 * 1024 * 1024;
export const MAX_RESOURCE_BYTES = 24 * 1024 * 1024;
export const MAX_TOTAL_RESOURCE_BYTES = 96 * 1024 * 1024;
export const MAX_RESOURCE_COUNT = 4096;
export const PEER_RETRY_BACKOFF_MS = [60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000];
export const FULL_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PERIODIC_JITTER_RATIO = 0.10;
export const SNAPSHOT_ENTITY_CONCURRENCY = 4;
export const MAX_AUTO_SYNC_RSS_BYTES = 384 * 1024 * 1024;
export const MAX_EVENT_LOOP_DELAY_MS = 250;
export const REQUEST_TIMEOUT_MS = 5000;
export const WAKE_TIMEOUT_MS = 90_000;
export const WAKE_RETRY_SCHEDULE_MS = [500, 500, 1000, 1000, 2000, 2000, 5000];
export const DEFAULT_SECTIONS = [
  "resources",
  "entities",
  "activities",
  "activity_groups",
  "macros",
  "remotes",
  "profiles",
  "docks"
];
export const INTERNAL_ENTITY_PREFIXES = ["uc.main.activity.", "uc.main.macro.", "uc.main.remote.", "remote_sync.main."];
export const BAD_INTEGRATION_STATES = new Set([
  "DISCONNECTED", "CONNECTING", "RECONNECTING", "ERROR", "UNAVAILABLE", "UNKNOWN",
  "STOPPED", "FAILED", "FAILURE", "SUSPENDED"
]);
export const CONFIG_EVENT_NAMES = new Set([
  "integration_change", "integration_driver_change", "entity_change", "activity_group_change",
  "profile_change", "dock_change"
]);
