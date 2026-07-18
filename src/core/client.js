import { BAD_INTEGRATION_STATES, REQUEST_TIMEOUT_MS, WAKE_RETRY_SCHEDULE_MS, WAKE_TIMEOUT_MS } from "../shared/constants.js";
import { endpointBaseUrl } from "../shared/models.js";
import { sendMagicPacket } from "../network/wol.js";
import { CoreWebSocket, CoreWebSocketError } from "./events.js";
import { isTransportError, sleep } from "../shared/util.js";
import { logger } from "../shared/logger.js";

const log = logger("core-client");

// -----------------------------------------------------------------------------
// Error types
// -----------------------------------------------------------------------------

export class CoreApiError extends Error {
  constructor(status, method, path, body = null, url = null) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    super(`Core API ${method} ${path} returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "CoreApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
    this.url = url;
  }
}

export class CoreUnavailable extends Error { constructor(message, options) { super(message, options); this.name = "CoreUnavailable"; } }

// -----------------------------------------------------------------------------
// Response helpers
// -----------------------------------------------------------------------------

async function readBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text.slice(0, 4096); }
}

function responseItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of ["items", "data", "results", "entities", "integrations", "activities", "macros", "remotes", "activity_groups", "profiles", "resources"]) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}

function isRouteCompatibilityError(error) {
  return error instanceof CoreApiError && [400, 404, 405].includes(error.status);
}

function availableEntityItems(message) {
  const data = message?.msg_data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    if (Array.isArray(data.available_entities)) return data.available_entities;
    if (Array.isArray(data.entities)) return data.entities;
  }
  return [];
}

function availableEntityPaging(message) {
  const paging = message?.msg_data?.paging;
  return paging && typeof paging === "object" ? paging : null;
}

function integrationLocalEntityId(integrationId, entityId) {
  const value = String(entityId || "");
  const prefix = `${integrationId}.`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function isWebSocketCompatibilityError(error) {
  return error instanceof CoreWebSocketError && [400, 404, 405, 422, 500, 501].includes(error.code);
}

// -----------------------------------------------------------------------------
// Core client
// -----------------------------------------------------------------------------

export class CoreClient {
  constructor(endpoint, { requestTimeoutMs = REQUEST_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    this.endpoint = endpoint;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.lastWakeAttempts = [];
    this.integrationCollectionPath = null;
  }

  get authHeaders() { return { Authorization: `Bearer ${this.endpoint.api_key}` }; }

  // -------------------------------------------------------------------------
  // HTTP transport
  // -------------------------------------------------------------------------

  async #requestOnce(method, apiPath, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.requestTimeoutMs);
    const headers = new Headers(options.headers || {});
    headers.set("Accept", options.accept || "application/json");
    if (options.authenticated !== false) headers.set("Authorization", `Bearer ${this.endpoint.api_key}`);
    let body = options.body;
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.json);
    }
    const url = new URL(`${endpointBaseUrl(this.endpoint)}${apiPath}`);
    for (const [key, value] of Object.entries(options.params || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const started = Date.now();
    try {
      log.debug(`${method} ${url.pathname}${url.search}`);
      const response = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
      const expected = new Set(options.expected || [200]);
      if (!expected.has(response.status)) {
        const errorBody = await readBody(response);
        log.warn(`${method} ${url.pathname}${url.search} -> HTTP ${response.status} (${Date.now() - started}ms):`, errorBody);
        throw new CoreApiError(response.status, method, `${apiPath}${url.search}`, errorBody, url.toString());
      }
      log.debug(`${method} ${url.pathname}${url.search} -> HTTP ${response.status} (${Date.now() - started}ms)`);
      return response;
    } catch (error) {
      if (!(error instanceof CoreApiError)) log.warn(`${method} ${url.pathname}${url.search} failed (${Date.now() - started}ms):`, error.message);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async request(method, apiPath, options = {}) {
    try {
      return await this.#requestOnce(method, apiPath, options);
    } catch (error) {
      if (!isTransportError(error)) throw error;
      if (options.wakeOnUnavailable === false || !this.endpoint.mac) {
        throw new CoreUnavailable(`Core API unavailable at ${this.endpoint.host}: ${error.message}`, { cause: error });
      }
      log.info(`Core API unavailable; sending WoWLAN to ${this.endpoint.host}`);
      this.lastWakeAttempts = await sendMagicPacket(this.endpoint.mac, this.endpoint.broadcasts);
      return this.#retryAfterWake(method, apiPath, options);
    }
  }

  async #retryAfterWake(method, apiPath, options) {
    const deadline = Date.now() + WAKE_TIMEOUT_MS;
    let lastError = null;
    let index = 0;
    while (Date.now() < deadline) {
      await sleep(WAKE_RETRY_SCHEDULE_MS[Math.min(index++, WAKE_RETRY_SCHEDULE_MS.length - 1)]);
      try {
        const path = this.integrationCollectionPath || "/intg";
        const ready = await this.#requestOnce("GET", path, { params: { limit: 100 }, timeoutMs: Math.min(3000, this.requestTimeoutMs), expected: [200] });
        await ready.arrayBuffer();
        return await this.#requestOnce(method, apiPath, options);
      } catch (error) {
        if (!isTransportError(error)) throw error;
        lastError = error;
      }
    }
    throw new CoreUnavailable(`Core API did not recover within ${WAKE_TIMEOUT_MS / 1000}s after WoWLAN: ${lastError?.message || "unknown error"}`, { cause: lastError });
  }

  async json(method, apiPath, options = {}) {
    try {
      const response = await this.request(method, apiPath, options);
      return await readBody(response);
    } catch (error) {
      if (error instanceof CoreApiError && (options.optionalStatuses || []).includes(error.status)) return null;
      throw error;
    }
  }

  async bytes(method, apiPath, options = {}) {
    const response = await this.request(method, apiPath, options);
    return Buffer.from(await response.arrayBuffer());
  }

  getJson(apiPath, options = {}) { return this.json("GET", apiPath, options); }

  // -------------------------------------------------------------------------
  // Collection access
  // -------------------------------------------------------------------------

  async listPaginated(apiPath, { params = {}, pageSize = 100, optional = false } = {}) {
    const items = [];
    let page = 1;
    let firstRequest = true;
    while (true) {
      let response;
      const requestParams = firstRequest ? { ...params, limit: pageSize } : { ...params, page, limit: pageSize };
      try {
        response = await this.request("GET", apiPath, { params: requestParams, expected: [200] });
      } catch (error) {
        if (optional && error instanceof CoreApiError && [404, 405].includes(error.status)) return [];
        throw error;
      }
      const totalHeader = response.headers.get("Pagination-Count");
      const currentPageHeader = response.headers.get("Pagination-Page");
      const limitHeader = response.headers.get("Pagination-Limit");
      const payload = await readBody(response);
      const pageItems = responseItems(payload).filter((item) => item && typeof item === "object");
      items.push(...pageItems);

      const total = totalHeader !== null ? Number(totalHeader) : null;
      const effectiveLimit = limitHeader !== null ? Number(limitHeader) : pageSize;
      if ((Number.isFinite(total) && items.length >= total) || pageItems.length < effectiveLimit || pageItems.length === 0) break;

      const currentPage = currentPageHeader !== null ? Number(currentPageHeader) : page;
      page = Number.isFinite(currentPage) ? currentPage + 1 : page + 1;
      firstRequest = false;
    }
    return items;
  }

  async requestFirst(attempts, { compatibilityStatuses = [400, 404, 405] } = {}) {
    let lastError = null;
    for (const attempt of attempts) {
      try {
        if (attempt.kind === "json") return await this.json(attempt.method, attempt.path, attempt.options || {});
        return await this.request(attempt.method, attempt.path, attempt.options || {});
      } catch (error) {
        lastError = error;
        if (!(error instanceof CoreApiError) || !compatibilityStatuses.includes(error.status)) throw error;
        log.debug(`Compatibility attempt unavailable: ${attempt.method} ${attempt.path} -> ${error.status}`);
      }
    }
    throw lastError || new Error("No Core API compatibility route succeeded");
  }

  version() { return this.getJson("/pub/version", { authenticated: false, wakeOnUnavailable: false }); }

  async integrations() {
    if (this.integrationCollectionPath) return this.listPaginated(this.integrationCollectionPath);
    let lastError = null;
    for (const path of ["/intg", "/intg/instances"]) {
      try {
        const result = await this.listPaginated(path);
        this.integrationCollectionPath = path;
        log.info(`Using Core integration collection endpoint ${path}`);
        return result;
      } catch (error) {
        lastError = error;
        if (!isRouteCompatibilityError(error)) throw error;
      }
    }
    throw lastError;
  }

  async configureEntity(integrationId, entityId, payload, { localEntityId = null } = {}) {
    const encodedIntegration = encodeURIComponent(String(integrationId));
    const identifiers = [...new Set([entityId, localEntityId].filter(Boolean).map((value) => String(value)))];
    const attempts = [];
    for (const identifier of identifiers) {
      const encodedEntity = encodeURIComponent(identifier);
      attempts.push(
        { kind: "json", method: "POST", path: `/intg/instances/${encodedIntegration}/entities/${encodedEntity}`, options: { json: payload, expected: [200, 201] } },
        { kind: "json", method: "POST", path: `/intg/${encodedIntegration}/entities/${encodedEntity}`, options: { json: payload, expected: [200, 201] } }
      );
    }
    return this.requestFirst(attempts);
  }

  // -------------------------------------------------------------------------
  // Integration entity management
  // -------------------------------------------------------------------------

  async reloadAvailableEntities(integrationId, { pageSize = 100, client = null, requiredEntityIds = [] } = {}) {
    const ws = client || new CoreWebSocket(this.endpoint);
    const ownsClient = client === null;
    const integration = String(integrationId);
    const required = new Set((requiredEntityIds || [])
      .map((value) => integrationLocalEntityId(integration, value))
      .filter(Boolean));
    const modern = (page, forceReload) => ({
      force_reload: forceReload,
      filter: { integration_id: integration },
      paging: { page, limit: pageSize }
    });
    const attempts = [
      modern(1, true),
      { force_reload: true, filter: { integration_id: integration } },
      { force_reload: true, integration_id: integration, paging: { page: 1, limit: pageSize } },
      { force_reload: true, integration_id: integration }
    ];
    const collected = new Map();
    let lastError = null;

    const merge = (items) => {
      for (const item of items) {
        const id = integrationLocalEntityId(integration, item?.entity_id ?? item?.id);
        if (id) collected.set(id, item);
      }
    };
    const containsRequired = () => [...required].every((id) => collected.has(id));

    try {
      for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
        const data = attempts[attemptIndex];
        try {
          const first = await ws.request("get_available_entities", data, 30_000);
          const items = [...availableEntityItems(first)];
          const paging = availableEntityPaging(first);
          if (attemptIndex === 0 && paging) {
            const total = Number(paging.count ?? items.length);
            const limit = Number(paging.limit ?? pageSize);
            let page = Number(paging.page ?? 1) + 1;
            while (Number.isFinite(total) && items.length < total) {
              const response = await ws.request("get_available_entities", modern(page, false), 30_000);
              const pageItems = availableEntityItems(response);
              items.push(...pageItems);
              if (!pageItems.length || pageItems.length < limit) break;
              page += 1;
            }
          }
          merge(items);

          if (!required.size || containsRequired()) {
            const result = [...collected.values()];
            log.info(`Core refreshed ${result.length} available entity/entities for ${integration}`);
            return result;
          }
          log.debug(`Available-entity response shape ${attemptIndex + 1} is missing ${[...required].filter((id) => !collected.has(id)).length} required entity/entities; trying compatibility shape`);
        } catch (error) {
          lastError = error;
          if (!isWebSocketCompatibilityError(error)) throw error;
          log.debug(`Core WebSocket available-entity request shape unavailable: ${error.message}`);
        }
      }

      if (collected.size) {
        const result = [...collected.values()];
        log.info(`Core refreshed ${result.length} available entity/entities for ${integration}`);
        return result;
      }
      throw lastError || new Error(`Core did not return available entities for ${integration}`);
    } finally {
      if (ownsClient) await ws.close();
    }
  }

  async configureEntitiesFromIntegration(integrationId, entityIds, { pageSize = 100 } = {}) {
    const expected = [...new Set((entityIds || []).map((value) => integrationLocalEntityId(integrationId, value)).filter(Boolean))];
    if (!expected.length) return { available: [], configured: [] };

    const ws = new CoreWebSocket(this.endpoint);
    try {
      const available = await this.reloadAvailableEntities(integrationId, { pageSize, client: ws, requiredEntityIds: expected });
      const availableIds = new Set(available.map((item) => integrationLocalEntityId(integrationId, item?.entity_id ?? item?.id)).filter(Boolean));
      const unavailable = expected.filter((id) => !availableIds.has(id));
      if (unavailable.length) {
        throw new Error(`Integration ${integrationId} did not advertise ${unavailable.length} expected entity/entities after force reload: ${unavailable.slice(0, 8).join(", ")}`);
      }

      try {
        await ws.request("configure_entities_from_integration", { integration_id: String(integrationId), entity_ids: expected }, 60_000);
        log.info(`Configured ${expected.length} entity/entities from ${integrationId} through Core WebSocket API`);
      } catch (error) {
        if (!isWebSocketCompatibilityError(error)) throw error;
        log.warn(`Batch entity configuration is unavailable; falling back to individual requests: ${error.message}`);
        for (const entityId of expected) {
          await ws.request("configure_entity_from_integration", { integration_id: String(integrationId), entity_id: entityId }, 30_000);
        }
      }
      return { available, configured: expected };
    } finally {
      await ws.close();
    }
  }

  async coreMessage(name, data = undefined, timeoutMs = 30_000) {
    const ws = new CoreWebSocket(this.endpoint);
    try {
      const response = await ws.request(String(name), data, timeoutMs);
      return response?.msg_data ?? null;
    } finally {
      await ws.close();
    }
  }

  async executeEntityCommand(entityId, cmdId, params = undefined) {
    const payload = { cmd_id: String(cmdId) };
    if (params && typeof params === "object" && Object.keys(params).length) payload.params = params;
    return this.json("PUT", `/entities/${encodeURIComponent(String(entityId))}/command`, {
      json: payload,
      expected: [200]
    });
  }

  async ready() {
    const integrations = await this.integrations();
    const bad = [];
    for (const item of integrations) {
      const id = String(item.integration_id || item.id || "unknown");
      for (const key of ["state", "device_state", "driver_state"]) {
        const state = item[key];
        if (typeof state === "string" && BAD_INTEGRATION_STATES.has(state.toUpperCase())) bad.push([`${id}.${key}`, state.toUpperCase()]);
      }
    }
    return { ready: bad.length === 0, bad };
  }

  async uploadResource(resourceType, filename, payload) {
    const form = new FormData();
    form.append("file", new Blob([payload]), filename);
    return this.json("POST", `/resources/${encodeURIComponent(resourceType)}`, { body: form, timeoutMs: 15_000, expected: [201] });
  }

  deleteResource(resourceType, resourceId) {
    return this.json("DELETE", `/resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, { expected: [200, 204], optionalStatuses: [404] });
  }

  async withStandbyInhibitor(inhibitorId, who, why, callback) {
    const websocket = new CoreWebSocket(this.endpoint);
    let created = false;
    try {
      await websocket.connect();
      await websocket.request("create_standby_inhibitor", { id: inhibitorId, who, why });
      created = true;
      return await callback();
    } finally {
      if (created) {
        try { await websocket.request("del_standby_inhibitor", { id: inhibitorId }); }
        catch (error) { log.warn(`Failed to remove standby inhibitor ${inhibitorId}:`, error.message); }
      }
      await websocket.close();
    }
  }

  static async provisionApiKey(host, pin, { name, scheme = "http", port = null, fetchImpl = fetch } = {}) {
    const netloc = port ? `${host}:${port}` : host;
    const credentials = Buffer.from(`web-configurator:${pin}`).toString("base64");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImpl(`${scheme}://${netloc}/api/auth/api_keys`, {
        method: "POST",
        headers: { Authorization: `Basic ${credentials}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name, scopes: ["admin"] }),
        signal: controller.signal
      });
      const data = await readBody(response);
      if (response.status !== 201) throw new CoreApiError(response.status, "POST", "/auth/api_keys", data);
      if (!data?.api_key) throw new Error("Core API key creation response did not contain api_key");
      return { apiKey: String(data.api_key), active: Boolean(data.active) };
    } finally { clearTimeout(timer); }
  }
}
