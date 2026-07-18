import crypto from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { MAX_SNAPSHOT_BYTES, PROTOCOL_VERSION, SNAPSHOT_SCHEMA_VERSION } from "../shared/constants.js";
import { canonicalJson, firstIdentifier, sha256Bytes, utcNow } from "../shared/util.js";
import { logger } from "../shared/logger.js";

const log = logger("snapshot");

// -----------------------------------------------------------------------------
// Entity metadata
// -----------------------------------------------------------------------------

function configuredIntegrationId(entity) {
  if (typeof entity?.integration_id === "string" && entity.integration_id) return entity.integration_id;
  const parts = String(entity?.entity_id || entity?.id || "").split(".");
  return parts.length >= 2 ? parts.slice(0, 2).join(".") : null;
}

function localEntityId(integrationId, entityId) {
  const value = String(entityId || "");
  const prefix = `${integrationId}.`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function mergeAvailableMetadata(configured, available) {
  if (!available || typeof available !== "object") return configured;
  const merged = { ...available, ...configured };
  merged.entity_id = configured.entity_id || configured.id;
  if (configured.integration_id) merged.integration_id = configured.integration_id;
  if (Array.isArray(available.features)) merged.features = [...new Set(available.features.map(String))];
  else if (Array.isArray(configured.features)) merged.features = [...new Set(configured.features.map(String))];
  if (available.device_class !== undefined) merged.device_class = available.device_class;
  if (available.options && typeof available.options === "object" && !Array.isArray(available.options)) {
    merged.options = {
      ...(configured.options && typeof configured.options === "object" && !Array.isArray(configured.options) ? configured.options : {}),
      ...structuredClone(available.options)
    };
  }
  return merged;
}

// -----------------------------------------------------------------------------
// Snapshot creation
// -----------------------------------------------------------------------------

export class SnapshotBuilder {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.warnings = [];
    this.configuredEntityDetails = null;
  }

  async build() {
    const sections = [...new Set(this.config.sync.sections)];
    const data = {};
    const resources = [];
    const payloads = new Map();
    const coreVersion = await this.client.version();
    log.info(`Collecting snapshot from Core API ${coreVersion?.api || "unknown"}`);
    data.integrations = await this.client.integrations();
    log.info(`Collected ${data.integrations.length} integration instance(s)`);
    if (sections.includes("entities")) { data.entities = await this.#collectEntities(); log.info(`Collected ${data.entities.length} configured entity/entities`); }
    if (sections.includes("activities")) { data.activities = await this.#collectInternal("activities", "activity"); log.info(`Collected ${data.activities.length} activity/activities`); }
    if (sections.includes("activity_groups")) { data.activity_groups = await this.#listOptional("/activity_groups"); log.info(`Collected ${data.activity_groups.length} activity group(s)`); }
    if (sections.includes("macros")) { data.macros = await this.#collectMacros(); log.info(`Collected ${data.macros.length} macro(s)`); }
    if (sections.includes("remotes")) { data.remotes = await this.#collectInternal("remotes", "remote"); log.info(`Collected ${data.remotes.length} remote entity/entities`); }
    if (sections.includes("profiles")) { data.profiles = await this.#collectProfiles(); log.info(`Collected ${data.profiles.items.length} profile(s)`); }
    if (sections.includes("docks")) { data.docks = await this.#collectDocks(); log.info(`Collected ${data.docks.length} dock(s)`); }
    if (sections.includes("resources")) { await this.#collectResources(resources, payloads); log.info(`Collected ${resources.length} resource file(s)`); }
    const requiredIntegrations = [...this.#requiredIntegrations(data.entities || [])].sort();
    const contentHash = sha256Bytes(canonicalJson({ data, resources, required_integrations: requiredIntegrations }));
    const manifest = {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      protocol_version: PROTOCOL_VERSION,
      operation_id: crypto.randomUUID(),
      source_node_id: this.config.node_id,
      source_name: this.config.node_name,
      created_at: utcNow(),
      core_version: coreVersion || {},
      sections,
      required_integrations: requiredIntegrations,
      content_hash: contentHash,
      data,
      resources,
      warnings: [...this.warnings]
    };
    const encodedResources = {};
    for (const [archivePath, resourcePayload] of payloads) encodedResources[archivePath] = resourcePayload.toString("base64");
    const envelope = { format: "uc-remote-sync-gzip-json-v1", manifest, resources: encodedResources };
    const payload = gzipSync(Buffer.from(JSON.stringify(envelope)), { level: 6 });
    if (payload.length > MAX_SNAPSHOT_BYTES) throw new Error(`Snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
    return { manifest, payload };
  }

  async #configuredEntities() {
    if (Array.isArray(this.configuredEntityDetails)) return this.configuredEntityDetails;
    const overview = await this.client.listPaginated("/entities");
    const result = [];
    for (const item of overview) {
      const id = firstIdentifier(item, "entity_id", "id");
      if (!id || String(id).startsWith("remote_sync.main.")) continue;
      const detail = await this.#getOptional(`/entities/${encodeURIComponent(id)}`);
      result.push(detail && typeof detail === "object" ? { ...item, ...detail } : item);
    }
    this.configuredEntityDetails = result;
    return result;
  }

  async #collectEntities() {
    const configured = await this.#configuredEntities();
    const result = configured.filter((item) => {
      const type = String(item?.entity_type || "").toLowerCase();
      return !["activity", "macro", "remote"].includes(type);
    }).map((item) => structuredClone(item));
    await this.#mergeAvailableEntityMetadata(result);
    return result;
  }

  async #mergeAvailableEntityMetadata(entities) {
    const groups = new Map();
    for (let index = 0; index < entities.length; index += 1) {
      const integrationId = configuredIntegrationId(entities[index]);
      const entityId = firstIdentifier(entities[index], "entity_id", "id");
      if (!integrationId || !entityId) continue;
      if (!groups.has(integrationId)) groups.set(integrationId, []);
      groups.get(integrationId).push({ index, entityId: String(entityId), localId: localEntityId(integrationId, entityId) });
    }

    for (const [integrationId, records] of groups) {
      try {
        const available = await this.client.reloadAvailableEntities(integrationId, {
          requiredEntityIds: records.map((record) => record.localId),
          pageSize: 100
        });
        const byLocalId = new Map();
        for (const item of available || []) {
          const id = firstIdentifier(item, "entity_id", "id");
          if (id) byLocalId.set(localEntityId(integrationId, id), item);
        }
        let enriched = 0;
        for (const record of records) {
          const metadata = byLocalId.get(record.localId);
          if (!metadata) continue;
          entities[record.index] = mergeAvailableMetadata(entities[record.index], metadata);
          enriched += 1;
        }
        log.info(`Merged full available-entity metadata for ${enriched}/${records.length} configured entity/entities from ${integrationId}`);
      } catch (error) {
        this.warnings.push(`Could not retrieve full available-entity metadata from ${integrationId}: ${error.message}`);
      }
    }
  }


  async #collectMacros() {
    let overview = await this.#listOptional("/macros");

    if (!overview.length) {
      try {
        const configured = await this.#configuredEntities();
        overview = configured.filter((item) => String(item?.entity_type || "").toLowerCase() === "macro");
        if (overview.length) log.info(`Discovered ${overview.length} macro(s) through hydrated configured entities`);
      } catch (error) {
        this.warnings.push(`Could not discover macros through configured entity details: ${error.message}`);
      }
    }

    if (!overview.length && typeof this.client.coreMessage === "function") {
      const attempts = [
        { filter: { entity_type: "macro" }, paging: { page: 1, limit: 100 } },
        { filter: { type: "macro" }, paging: { page: 1, limit: 100 } },
        { entity_type: "macro", paging: { page: 1, limit: 100 } }
      ];
      for (const payload of attempts) {
        try {
          const response = await this.client.coreMessage("get_entities", payload, 30_000);
          const candidates = this.#normalizeList(response, ["entities"]);
          overview = candidates.filter((item) => String(item?.entity_type || "").toLowerCase() === "macro");
          if (overview.length) {
            log.info(`Discovered ${overview.length} macro(s) through Core WebSocket get_entities`);
            break;
          }
        } catch { /* compatibility attempt */ }
      }
    }

    const result = [];
    for (const item of overview) {
      const id = firstIdentifier(item, "entity_id", "id");
      if (!id) { this.warnings.push("Skipped macro without identifier"); continue; }
      const encoded = encodeURIComponent(id);
      const alreadyDetailed = item?.options && typeof item.options === "object";
      const detail = (alreadyDetailed ? item : null)
        || (await this.#getOptional(`/macros/${encoded}`, true))
        || (await this.#getOptional(`/entities/${encoded}`, true))
        || item;
      result.push({ source_id: id, detail });
    }
    return result;
  }

  async #collectDocks() {
    if (typeof this.client.coreMessage !== "function") return [];
    try {
      const first = await this.client.coreMessage("get_docks", { paging: { page: 1, limit: 100 } }, 30_000);
      const overview = this.#normalizeList(first, ["docks"]);
      const result = [];
      for (const item of overview) {
        const id = firstIdentifier(item, "dock_id", "id");
        if (!id) { this.warnings.push("Skipped dock without identifier"); continue; }
        let detail = item;
        try {
          const response = await this.client.coreMessage("get_dock", { dock_id: String(id) }, 30_000);
          if (response && typeof response === "object") detail = response.dock && typeof response.dock === "object" ? response.dock : response;
        } catch (error) {
          this.warnings.push(`Could not retrieve dock ${id}: ${error.message}`);
        }
        result.push({ source_id: String(id), detail });
      }
      return result;
    } catch (error) {
      this.warnings.push(`Could not retrieve docks through Core WebSocket API: ${error.message}`);
      return [];
    }
  }

  async #collectInternal(endpoint, entityType) {
    let overview = await this.#listOptional(`/${endpoint}`);
    let hydratedById = new Map();
    if (endpoint === "remotes") {
      try {
        const hydrated = (await this.#configuredEntities())
          .filter((item) => String(item?.entity_type || "").toLowerCase() === "remote");
        hydratedById = new Map(hydrated
          .map((item) => [String(firstIdentifier(item, "entity_id", "id") || ""), item])
          .filter(([id]) => id));
        if (!overview.length && hydrated.length) {
          overview = hydrated;
          log.info(`Discovered ${hydrated.length} remote entity/entities through hydrated configured entities`);
        }
      } catch (error) {
        this.warnings.push(`Could not discover remote entities through configured entity details: ${error.message}`);
      }
    }
    const result = [];
    for (const item of overview) {
      const id = firstIdentifier(item, "entity_id", "id");
      if (!id) { this.warnings.push(`Skipped ${entityType} without identifier`); continue; }
      const encoded = encodeURIComponent(id);
      const endpointDetail = await this.#getOptional(`/${endpoint}/${encoded}`);
      const fallbackDetail = hydratedById.get(String(id)) || item;
      const record = { source_id: id, detail: endpointDetail || fallbackDetail };
      if (["activities", "remotes"].includes(endpoint)) {
        const options = record.detail?.options && typeof record.detail.options === "object" ? record.detail.options : {};
        const buttons = (await this.#getOptional(`/${endpoint}/${encoded}/buttons`, true)) ?? options.button_mapping ?? null;
        const uiBase = `/${endpoint}/${encoded}/ui`;
        const ui = (await this.#getOptional(uiBase, true)) ?? options.user_interface ?? null;
        const pages = await this.#collectPageDetails(uiBase, ui?.pages);
        if (buttons !== null) record.buttons = buttons;
        if (ui !== null || pages.length) record.ui = { ...(ui && typeof ui === "object" ? ui : {}), pages };
        if (endpoint === "remotes") {
          const ir = await this.#getOptional(`/${endpoint}/${encoded}/ir`);
          const bt = await this.#getOptional(`/${endpoint}/${encoded}/bt`);
          if (ir !== null) record.ir = ir;
          if (bt !== null) record.bt = bt;
        }
      }
      result.push(record);
    }
    return result;
  }

  async #collectProfiles() {
    let profiles = this.#normalizeList(await this.#getOptional("/profiles"), ["profiles"]);
    if (!profiles.length && typeof this.client.coreMessage === "function") {
      try { profiles = this.#normalizeList(await this.client.coreMessage("get_profiles", { paging: { page: 1, limit: 100 } }, 30_000), ["profiles"]); }
      catch (error) { this.warnings.push(`Could not retrieve profiles through Core WebSocket API: ${error.message}`); }
    }
    const items = [];
    for (const item of profiles) {
      const id = firstIdentifier(item, "profile_id", "id");
      if (!id) { this.warnings.push("Skipped profile without identifier"); continue; }
      const encoded = encodeURIComponent(id);
      let detail = (await this.#getOptional(`/profiles/${encoded}`, true)) || item;
      if (detail === item && typeof this.client.coreMessage === "function") {
        try {
          const value = await this.client.coreMessage("get_profile", { profile_id: String(id) }, 30_000);
          if (value && typeof value === "object") detail = value.profile && typeof value.profile === "object" ? value.profile : value;
        } catch {}
      }
      const record = { source_id: id, detail };
      const profileBase = `/profiles/${encoded}`;
      const pageOverview = await this.#getOptional(`${profileBase}/pages`, true);
      let pages = await this.#collectPageDetails(profileBase, pageOverview);
      let groups = this.#normalizeList(await this.#getOptional(`${profileBase}/groups`, true), ["groups"]);
      if (typeof this.client.coreMessage === "function") {
        if (!pages.length) {
          try { pages = this.#normalizeList(await this.client.coreMessage("get_pages", { profile_id: String(id) }, 30_000), ["pages"]); } catch {}
        }
        if (!groups.length) {
          try { groups = this.#normalizeList(await this.client.coreMessage("get_groups", { profile_id: String(id) }, 30_000), ["groups"]); } catch {}
        }
      }
      record.pages = pages;
      record.groups = groups;
      items.push(record);
    }
    let active = null;
    for (const endpoint of ["/profiles/active", "/profiles/active_profile"]) {
      active = await this.#getOptional(endpoint, true);
      if (active !== null) break;
    }
    if (active === null && typeof this.client.coreMessage === "function") {
      try { active = await this.client.coreMessage("get_active_profile", undefined, 30_000); } catch {}
    }
    return { items, active };
  }

  async #collectPageDetails(base, supplied = null) {
    let overview = this.#normalizeList(supplied);
    if (!overview.length && supplied === undefined) overview = this.#normalizeList(await this.#getOptional(`${base}/pages`, true));
    const pages = [];
    for (const item of overview) {
      const id = firstIdentifier(item, "page_id", "id");
      if (!id) { pages.push(item); continue; }
      const detail = await this.#getOptional(`${base}/pages/${encodeURIComponent(id)}`, true);
      pages.push(detail && typeof detail === "object" ? { ...item, ...detail } : item);
    }
    return pages;
  }

  async #collectResources(records, payloads) {
    const supported = this.#normalizeList(await this.#getOptional("/resources"));
    for (const metadata of supported) {
      const type = String(metadata.type || "");
      if (!type) continue;
      const items = await this.client.listPaginated(`/resources/${encodeURIComponent(type)}`, { optional: true });
      for (const item of items) {
        const id = firstIdentifier(item, "id", "resource_id", "identifier");
        if (!id) continue;
        const archivePath = `resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
        try {
          const payload = await this.client.bytes("GET", `/resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, { expected: [200], timeoutMs: 15_000 });
          records.push({ type, id, size: payload.length, sha256: sha256Bytes(payload), archive_path: archivePath });
          payloads.set(archivePath, payload);
        } catch (error) { this.warnings.push(`Resource ${type}/${id} could not be downloaded: ${error.message}`); }
      }
    }
    records.sort((a, b) => `${a.type}/${a.id}`.localeCompare(`${b.type}/${b.id}`));
  }

  async #listOptional(endpoint) {
    try { return await this.client.listPaginated(endpoint, { optional: true }); }
    catch (error) { this.warnings.push(`Optional endpoint ${endpoint} failed: ${error.message}`); return []; }
  }

  async #getOptional(endpoint, quiet = false) {
    try { return await this.client.getJson(endpoint, { optionalStatuses: [404, 405] }); }
    catch (error) {
      if (!quiet) this.warnings.push(`Optional endpoint ${endpoint} failed: ${error.message}`);
      return null;
    }
  }

  #normalizeList(value, preferredKeys = []) {
    if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
    if (value && typeof value === "object") {
      for (const key of [...preferredKeys, "items", "data", "results", "entities", "activities", "macros", "remotes", "activity_groups", "profiles", "pages", "groups", "docks", "resources"]) {
        if (Array.isArray(value[key])) return value[key].filter((item) => item && typeof item === "object");
      }
    }
    return [];
  }

  #requiredIntegrations(entities) {
    const result = new Set();
    for (const entity of entities) {
      let integrationId = entity.integration_id;
      if (!integrationId) {
        const parts = String(entity.entity_id || entity.id || "").split(".");
        if (parts.length >= 2) integrationId = parts.slice(0, 2).join(".");
      }
      if (typeof integrationId === "string" && integrationId && !integrationId.startsWith("uc.main")) result.add(integrationId);
    }
    return result;
  }
}

// -----------------------------------------------------------------------------
// Snapshot validation
// -----------------------------------------------------------------------------

export class SnapshotReader {
  static async read(payload) {
    if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
    if (payload.length > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds maximum size");
    let envelope;
    try {
      const uncompressed = gunzipSync(payload, { maxOutputLength: MAX_SNAPSHOT_BYTES * 3 });
      envelope = JSON.parse(uncompressed.toString("utf8"));
    } catch (error) {
      throw new Error(`Invalid snapshot archive: ${error.message}`);
    }
    if (envelope?.format !== "uc-remote-sync-gzip-json-v1") throw new Error("Unsupported snapshot archive format");
    const manifest = envelope.manifest;
    const incomingSchema = Number(manifest?.schema_version);
    if (!manifest || ![4, 5, SNAPSHOT_SCHEMA_VERSION].includes(incomingSchema)) throw new Error(`Unsupported snapshot schema ${manifest?.schema_version}`);
    const resources = {};
    for (const item of manifest.resources || []) {
      const archivePath = String(item.archive_path || "");
      if (!archivePath || archivePath.includes("..") || archivePath.startsWith("/") || archivePath.includes("\\")) throw new Error(`Unsafe resource archive path: ${archivePath}`);
      const encoded = envelope.resources?.[archivePath];
      if (typeof encoded !== "string") throw new Error(`Missing resource payload: ${archivePath}`);
      const data = Buffer.from(encoded, "base64");
      if (data.length !== Number(item.size)) throw new Error(`Resource size mismatch: ${archivePath}`);
      if (sha256Bytes(data) !== String(item.sha256)) throw new Error(`Resource hash mismatch: ${archivePath}`);
      resources[archivePath] = data;
    }
    const contentHash = sha256Bytes(canonicalJson({ data: manifest.data || {}, resources: manifest.resources || [], required_integrations: manifest.required_integrations || [] }));
    if (contentHash !== String(manifest.content_hash)) throw new Error("Snapshot manifest content hash mismatch");
    return { manifest, resources };
  }
}
