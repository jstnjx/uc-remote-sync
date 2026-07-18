import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataHome } from "../shared/paths.js";
import { atomicWriteJson, canonicalJson, readJson, sha256Bytes } from "../shared/util.js";

// -----------------------------------------------------------------------------
// Supported entity types
// -----------------------------------------------------------------------------

const SUPPORTED_ENTITY_TYPES = new Set([
  "button", "climate", "cover", "light", "media_player", "remote", "select", "sensor", "switch"
]);

const ENTITY_TYPE_ALIASES = Object.freeze({
  binary_sensor: "sensor",
  input_boolean: "switch",
  input_button: "button",
  input_select: "select",
  scene: "button",
  script: "button"
});

function language(value, fallback) {
  if (typeof value === "string" && value.trim()) return { en: value };
  if (value && typeof value === "object" && !Array.isArray(value)) return structuredClone(value);
  return { en: fallback };
}

function safeAttributes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "UNKNOWN" };
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["string", "number", "boolean"].includes(typeof item)) result[key] = item;
    else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) result[key] = [...item];
  }
  if (!Object.keys(result).length) result.state = "UNKNOWN";
  return result;
}

function normalizedEntityType(value) {
  const source = String(value || "").trim().toLowerCase();
  return ENTITY_TYPE_ALIASES[source] || source;
}

// -----------------------------------------------------------------------------
// Media-player capabilities
// -----------------------------------------------------------------------------

const MEDIA_PLAYER_COMMAND_FEATURES = Object.freeze({
  on: "on_off",
  off: "on_off",
  toggle: "toggle",
  play_pause: "play_pause",
  stop: "stop",
  previous: "previous",
  next: "next",
  fast_forward: "fast_forward",
  rewind: "rewind",
  seek: "seek",
  volume: "volume",
  volume_up: "volume_up_down",
  volume_down: "volume_up_down",
  mute_toggle: "mute_toggle",
  mute: "mute",
  unmute: "unmute",
  repeat: "repeat",
  shuffle: "shuffle",
  channel_up: "channel_switcher",
  channel_down: "channel_switcher",
  cursor_up: "dpad",
  cursor_down: "dpad",
  cursor_left: "dpad",
  cursor_right: "dpad",
  cursor_enter: "dpad",
  home: "home",
  back: "home",
  menu: "menu",
  context_menu: "context_menu",
  guide: "guide",
  info: "info",
  select_source: "select_source",
  select_sound_mode: "select_sound_mode",
  settings: "settings",
  play_media: "play_media"
});

function collectReferencedCommands(value, result = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferencedCommands(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  if (typeof value.entity_id === "string" && typeof value.cmd_id === "string") {
    if (!result.has(value.entity_id)) result.set(value.entity_id, new Set());
    result.get(value.entity_id).add(value.cmd_id);
  }
  for (const child of Object.values(value)) collectReferencedCommands(child, result);
  return result;
}

function augmentReferencedCapabilities(descriptor, commands) {
  if (!commands?.size) return descriptor;
  const features = new Set((descriptor.features || []).map(String));
  for (const cmdId of commands) {
    const [prefix, command] = String(cmdId).split(".", 2);
    if (prefix !== descriptor.entity_type || !command) continue;
    if (descriptor.entity_type === "media_player") {
      const feature = /^digit_[0-9]$/.test(command) ? "numpad" : MEDIA_PLAYER_COMMAND_FEATURES[command];
      if (feature) features.add(feature);
    } else if (["light", "switch"].includes(descriptor.entity_type) && ["on", "off"].includes(command)) {
      features.add("on_off");
    } else if (descriptor.entity_type === "button" && command === "push") {
      features.add("press");
    } else {
      features.add(command);
    }
  }
  descriptor.features = [...features];
  return descriptor;
}

function activationDescriptor(item) {
  return Object.fromEntries(Object.entries({
    local_id: item.local_id,
    source_entity_id: item.source_entity_id,
    entity_type: item.entity_type,
    name: item.name,
    icon: item.icon,
    description: item.description,
    features: item.features,
    device_class: item.device_class,
    options: item.options,
    area: item.area
  }).filter(([, value]) => value !== undefined));
}

function capabilityDescriptor(item) {
  return Object.fromEntries(Object.entries({
    entity_type: item.entity_type,
    features: Array.isArray(item.features) ? [...item.features].map(String).sort() : [],
    device_class: item.device_class,
    options: item.options
  }).filter(([, value]) => value !== undefined));
}

// -----------------------------------------------------------------------------
// Proxy descriptors
// -----------------------------------------------------------------------------

export function proxyCapabilityHash(item) {
  return sha256Bytes(canonicalJson(capabilityDescriptor(item))).slice(0, 8);
}

export function catalogActivationHash(catalog) {
  const descriptors = (catalog?.entities || []).map(activationDescriptor).sort((a, b) => a.local_id.localeCompare(b.local_id));
  return sha256Bytes(canonicalJson(descriptors));
}

export function proxyLocalId(sourceEntityId) {
  const hash = crypto.createHash("sha256").update(String(sourceEntityId)).digest("hex").slice(0, 24);
  return `proxy_${hash}`;
}

function revisedProxyLocalId(sourceEntityId, descriptor) {
  return `${proxyLocalId(sourceEntityId)}_${proxyCapabilityHash(descriptor)}`;
}

export function proxyEntityId(sourceEntityId) {
  return `remote_sync.main.${proxyLocalId(sourceEntityId)}`;
}

export function proxyDescriptor(source, { sourceId = null, forceType = null } = {}) {
  const entityId = String(sourceId || source?.entity_id || source?.id || "").trim();
  if (!entityId) return null;
  const entityType = normalizedEntityType(forceType || source?.entity_type);
  if (!SUPPORTED_ENTITY_TYPES.has(entityType)) return null;
  const fallbackName = entityId.split(".").at(-1) || entityId;
  return {
    local_id: proxyLocalId(entityId),
    target_entity_id: proxyEntityId(entityId),
    source_entity_id: entityId,
    source_entity_type: String(source?.entity_type || entityType).trim().toLowerCase(),
    entity_type: entityType,
    name: language(source?.name, fallbackName),
    icon: typeof source?.icon === "string" ? source.icon : undefined,
    description: source?.description ? language(source.description, "") : undefined,
    features: Array.isArray(source?.features) ? [...new Set(source.features.map(String))] : [],
    attributes: safeAttributes(source?.attributes),
    device_class: typeof source?.device_class === "string" ? source.device_class : undefined,
    options: source?.options && typeof source.options === "object" ? structuredClone(source.options) : undefined,
    area: typeof source?.area === "string" ? source.area : undefined
  };
}

function preserveOrReviseIdentity(descriptor, previousBySource) {
  const previous = previousBySource.get(descriptor.source_entity_id);
  if (!previous) return descriptor;

  const previousHash = proxyCapabilityHash(previous);
  const nextHash = proxyCapabilityHash(descriptor);
  if (previousHash === nextHash) {
    descriptor.local_id = String(previous.local_id || proxyLocalId(descriptor.source_entity_id));
    descriptor.target_entity_id = String(previous.target_entity_id || `remote_sync.main.${descriptor.local_id}`);
    return descriptor;
  }

  descriptor.local_id = revisedProxyLocalId(descriptor.source_entity_id, descriptor);
  descriptor.target_entity_id = `remote_sync.main.${descriptor.local_id}`;
  return descriptor;
}

export function buildProxyCatalog(manifest, previousCatalog = null) {
  const referencedCommands = collectReferencedCommands(manifest?.data || {});
  const previousBySource = new Map((previousCatalog?.entities || [])
    .filter((item) => item?.source_entity_id)
    .map((item) => [String(item.source_entity_id), item]));
  const descriptors = new Map();
  for (const entity of manifest?.data?.entities || []) {
    const descriptor = proxyDescriptor(entity);
    if (descriptor) {
      augmentReferencedCapabilities(descriptor, referencedCommands.get(descriptor.source_entity_id));
      descriptors.set(descriptor.source_entity_id, preserveOrReviseIdentity(descriptor, previousBySource));
    }
  }
  for (const record of manifest?.data?.remotes || []) {
    const detail = record?.detail || {};
    const options = { ...(detail.options && typeof detail.options === "object" ? detail.options : {}) };
    if (Array.isArray(detail.simple_commands)) options.simple_commands = detail.simple_commands;
    if (record?.buttons !== undefined) options.button_mapping = record.buttons;
    if (record?.ui !== undefined) options.user_interface = record.ui;
    const descriptor = proxyDescriptor({ ...detail, options }, { sourceId: record?.source_id, forceType: "remote" });
    if (descriptor) {
      augmentReferencedCapabilities(descriptor, referencedCommands.get(descriptor.source_entity_id));
      descriptors.set(descriptor.source_entity_id, preserveOrReviseIdentity(descriptor, previousBySource));
    }
  }
  const entities = [...descriptors.values()].sort((a, b) => a.source_entity_id.localeCompare(b.source_entity_id));
  const mapping = Object.fromEntries(entities.map((item) => [item.source_entity_id, item.target_entity_id]));
  const catalog = {
    schema_version: 3,
    source_node_id: String(manifest?.source_node_id || ""),
    source_name: String(manifest?.source_name || "Primary remote"),
    content_hash: String(manifest?.content_hash || ""),
    updated_at: new Date().toISOString(),
    entities,
    mapping
  };
  catalog.activation_hash = catalogActivationHash(catalog);
  return catalog;
}

function normalizeLoadedCatalog(catalog) {
  const value = catalog && typeof catalog === "object" ? catalog : { schema_version: 3, entities: [], mapping: {} };
  value.entities = Array.isArray(value.entities) ? value.entities : [];
  value.mapping = value.mapping && typeof value.mapping === "object" ? value.mapping : {};
  value.activation_hash = catalogActivationHash(value);
  value.schema_version = 3;
  return value;
}

// -----------------------------------------------------------------------------
// Catalog persistence
// -----------------------------------------------------------------------------

export class ProxyCatalogStore {
  constructor(filePath = path.join(dataHome(), "proxy-catalog.json")) { this.filePath = filePath; }
  load() { return normalizeLoadedCatalog(readJson(this.filePath, { schema_version: 3, entities: [], mapping: {} })); }
  save(catalog) { atomicWriteJson(this.filePath, normalizeLoadedCatalog(structuredClone(catalog))); }
  clear() { try { fs.unlinkSync(this.filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
}
