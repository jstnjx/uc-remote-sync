import crypto from "node:crypto";
import { AgentServer } from "../agent/server.js";
import { CoreWebSocket } from "../core/events.js";
import { AGENT_API_VERSION } from "../shared/constants.js";
import { logger } from "../shared/logger.js";
import { RemoteSyncService } from "./index.js";

const log = logger("live-proxy-state");
const INSTALL_MARK = Symbol.for("uc-remote-sync.live-proxy-state");
const WS_MARK = Symbol.for("uc-remote-sync.live-proxy-state.ws");
const AGENT_MARK = Symbol.for("uc-remote-sync.live-proxy-state.agent");
const SERVICE_MARK = Symbol.for("uc-remote-sync.live-proxy-state.service");
const SUPPORTED_ENTITY_TYPES = new Set(["button", "climate", "cover", "light", "media_player", "remote", "select", "sensor", "switch"]);
const MAX_ATTRIBUTE_KEYS = 96;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_DEPTH = 3;
const MAX_PUSH_BYTES = 256 * 1024;

const endpointServices = new Map();
const nodeServices = new Map();
const serviceState = new WeakMap();

function endpointKey(endpoint = {}) {
  return [String(endpoint.host || "").toLowerCase(), Number(endpoint.port || 80), endpoint.secure === true || endpoint.tls === true ? "tls" : "plain"].join("|");
}

function stateFor(service) {
  let state = serviceState.get(service);
  if (!state) {
    state = {
      sourceEpoch: crypto.randomUUID(),
      revisions: new Map(),
      appliedVersions: new Map(),
      lastPayloads: new Map(),
      queues: new Map(),
    };
    serviceState.set(service, state);
  }
  return state;
}

function safeValue(value, depth = 0) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (depth >= MAX_OBJECT_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
      const safe = safeValue(item, depth + 1);
      if (safe !== undefined) result.push(safe);
    }
    return result;
  }
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_ATTRIBUTE_KEYS)) {
    const safe = safeValue(item, depth + 1);
    if (safe !== undefined) result[String(key)] = safe;
  }
  return result;
}

export function sanitizeLiveAttributes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return safeValue(value, 0) || {};
}

export function liveProxyUpdateFromCoreEvent(message) {
  if (String(message?.msg || "") !== "entity_change") return null;
  const data = message?.msg_data;
  if (!data || typeof data !== "object") return null;
  const eventType = String(data.event_type || "").toUpperCase();
  if (["CREATE", "DELETE"].includes(eventType)) return null;
  const sourceEntityId = String(data.entity_id || data.entity?.entity_id || "").trim();
  if (!sourceEntityId || sourceEntityId.startsWith("remote_sync.main.")) return null;
  const entityType = String(data.entity_type || data.entity?.entity_type || "").trim().toLowerCase();
  if (entityType === "activity" || (entityType && !SUPPORTED_ENTITY_TYPES.has(entityType))) return null;
  const attributes = sanitizeLiveAttributes(
    data.attributes && typeof data.attributes === "object"
      ? data.attributes
      : data.entity?.attributes,
  );
  const state = data.state ?? data.new_state ?? data.entity?.state;
  if (state !== undefined && state !== null && attributes.state === undefined) attributes.state = safeValue(state);
  if (!Object.keys(attributes).length) return null;
  return {
    source_entity_id: sourceEntityId,
    entity_type: entityType || null,
    attributes,
  };
}

function nextVersion(service, sourceEntityId) {
  const state = stateFor(service);
  const revision = Number(state.revisions.get(sourceEntityId) || 0) + 1;
  state.revisions.set(sourceEntityId, revision);
  return { source_epoch: state.sourceEpoch, revision };
}

function isStale(service, update) {
  const sourceEpoch = String(update?.source_epoch || "");
  const revision = Number(update?.revision);
  if (!sourceEpoch || !Number.isSafeInteger(revision) || revision < 1) return false;
  const current = stateFor(service).appliedVersions.get(String(update.source_entity_id || ""));
  return current?.source_epoch === sourceEpoch && Number(current.revision) >= revision;
}

function recordVersion(service, update) {
  const sourceEpoch = String(update?.source_epoch || "");
  const revision = Number(update?.revision);
  if (!sourceEpoch || !Number.isSafeInteger(revision) || revision < 1) return;
  stateFor(service).appliedVersions.set(String(update.source_entity_id || ""), { source_epoch: sourceEpoch, revision });
}

export function applyLiveProxyState(service, update) {
  if (!service?.config || service.config.role !== "child") return { success: false, status: 409, error: "This node is not an active satellite" };
  const sourceEntityId = String(update?.source_entity_id || "").trim();
  if (!sourceEntityId) return { success: false, status: 400, error: "source_entity_id is required" };
  if (isStale(service, update)) return { success: true, changed: false, ignored_stale: true, source_entity_id: sourceEntityId };
  const descriptor = service.proxyCatalog?.entities?.find((item) => String(item?.source_entity_id || "") === sourceEntityId);
  if (!descriptor) {
    recordVersion(service, update);
    return { success: true, changed: false, ignored_unmapped: true, source_entity_id: sourceEntityId };
  }
  const attributes = sanitizeLiveAttributes(update?.attributes);
  if (!Object.keys(attributes).length) {
    recordVersion(service, update);
    return { success: true, changed: false, source_entity_id: sourceEntityId };
  }
  descriptor.attributes = { ...(descriptor.attributes || {}), ...attributes };
  service.proxyCatalog.updated_at = new Date().toISOString();
  service.proxyStore?.save?.(service.proxyCatalog);
  recordVersion(service, update);
  for (const listener of service.proxyListeners || []) {
    try { listener(service.proxyCatalog); }
    catch (error) { log.error("Proxy listener failed during live state update:", error); }
  }
  return { success: true, changed: true, source_entity_id: sourceEntityId, target_entity_id: descriptor.target_entity_id };
}

async function pushLiveProxyState(service, peer, update) {
  const destination = await service.syncCoordinator.resolvePeerUrl(peer, false);
  const body = JSON.stringify(update);
  if (Buffer.byteLength(body) > MAX_PUSH_BYTES) throw new Error(`Live proxy state payload exceeds ${MAX_PUSH_BYTES} bytes`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${destination.url.replace(/\/$/, "")}/v${AGENT_API_VERSION}/proxy/state`, {
      method: "POST",
      headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function broadcastLiveProxyState(service, message) {
  const update = liveProxyUpdateFromCoreEvent(message);
  if (!update || !service?.config || service.config.role !== "master") return;
  const state = stateFor(service);
  const signature = JSON.stringify(update.attributes);
  if (state.lastPayloads.get(update.source_entity_id) === signature) return;
  state.lastPayloads.set(update.source_entity_id, signature);
  Object.assign(update, nextVersion(service, update.source_entity_id), { observed_at: new Date().toISOString() });
  const peers = service.config.peers.filter((peer) => peer.enabled);
  await Promise.all(peers.map(async (peer) => {
    try { await pushLiveProxyState(service, peer, update); }
    catch (error) { log.warn(`Could not synchronize live state ${update.source_entity_id} to ${peer.name}: ${error.message}`); }
  }));
}

function queueLiveProxyState(service, message) {
  const update = liveProxyUpdateFromCoreEvent(message);
  if (!update) return;
  const state = stateFor(service);
  const key = update.source_entity_id;
  const previous = state.queues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(() => broadcastLiveProxyState(service, message));
  state.queues.set(key, current);
  current.finally(() => { if (state.queues.get(key) === current) state.queues.delete(key); });
}

async function readJson(request, limit = MAX_PUSH_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 }); }
}

function sendJson(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": payload.length });
  response.end(payload);
}

function installCoreEventBridge() {
  if (CoreWebSocket.prototype[WS_MARK]) return;
  const originalConnect = CoreWebSocket.prototype.connect;
  Object.defineProperty(CoreWebSocket.prototype, WS_MARK, { value: true });
  CoreWebSocket.prototype.connect = async function connectWithLiveProxyState() {
    if (this.onEvent && !this[INSTALL_MARK]) {
      const originalOnEvent = this.onEvent;
      this.onEvent = (message) => {
        originalOnEvent(message);
        const service = endpointServices.get(endpointKey(this.endpoint));
        if (service) queueLiveProxyState(service, message);
      };
      Object.defineProperty(this, INSTALL_MARK, { value: true });
    }
    return originalConnect.call(this);
  };
}

function installAgentBridge() {
  if (AgentServer.prototype[AGENT_MARK]) return;
  const originalStart = AgentServer.prototype.start;
  Object.defineProperty(AgentServer.prototype, AGENT_MARK, { value: true });
  AgentServer.prototype.start = async function startWithLiveProxyState() {
    await originalStart.call(this);
    if (!this.server || this.server[INSTALL_MARK]) return;
    const listeners = this.server.listeners("request");
    this.server.removeAllListeners("request");
    this.server.on("request", (request, response) => {
      let url;
      try { url = new URL(request.url, "http://localhost"); }
      catch { return listeners.forEach((listener) => listener.call(this.server, request, response)); }
      if (request.method !== "POST" || url.pathname !== `/v${AGENT_API_VERSION}/proxy/state`) {
        return listeners.forEach((listener) => listener.call(this.server, request, response));
      }
      void (async () => {
        try {
          if (request.headers.authorization !== `Bearer ${this.config.agent_token}`) {
            sendJson(response, 401, { error: "Unauthorized live proxy state update" });
            return;
          }
          if (this.config.role !== "child") {
            sendJson(response, 409, { error: "Live proxy state updates are only accepted by satellite remotes" });
            return;
          }
          const service = nodeServices.get(String(this.config.node_id || ""));
          if (!service) {
            sendJson(response, 503, { error: "Live proxy state synchronization is unavailable" });
            return;
          }
          const body = await readJson(request);
          const result = applyLiveProxyState(service, body);
          sendJson(response, result.success ? 200 : (result.status || 422), result);
        } catch (error) {
          sendJson(response, error.statusCode || 500, { error: error.message || "Live proxy state update failed" });
        }
      })();
    });
    Object.defineProperty(this.server, INSTALL_MARK, { value: true });
  };
}

function unregisterService(service) {
  for (const [key, value] of endpointServices) if (value === service) endpointServices.delete(key);
  for (const [key, value] of nodeServices) if (value === service) nodeServices.delete(key);
}

function installServiceRegistration() {
  if (RemoteSyncService.prototype[SERVICE_MARK]) return;
  const originalConfigure = RemoteSyncService.prototype.configure;
  const originalStop = RemoteSyncService.prototype.stop;
  Object.defineProperty(RemoteSyncService.prototype, SERVICE_MARK, { value: true });
  RemoteSyncService.prototype.configure = async function configureWithLiveProxyState(config) {
    const result = await originalConfigure.call(this, config);
    unregisterService(this);
    if (this.config?.remote) endpointServices.set(endpointKey(this.config.remote), this);
    if (this.config?.node_id) nodeServices.set(String(this.config.node_id), this);
    stateFor(this);
    return result;
  };
  RemoteSyncService.prototype.stop = async function stopWithLiveProxyState() {
    unregisterService(this);
    serviceState.delete(this);
    return originalStop.call(this);
  };
}

export function installLiveProxyStateCompatibility() {
  installCoreEventBridge();
  installAgentBridge();
  installServiceRegistration();
}
