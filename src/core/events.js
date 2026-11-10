import { connectWebSocket, WebSocketPeer } from "../transport/websocket.js";
import { CONFIG_EVENT_NAMES, DEFAULT_EVENT_DEBOUNCE_MS } from "../shared/constants.js";
import { endpointWsUrl } from "../shared/models.js";
import { logger } from "../shared/logger.js";
import { sleep } from "../shared/util.js";

const log = logger("core-ws");

// -----------------------------------------------------------------------------
// Core WebSocket client
// -----------------------------------------------------------------------------

export class CoreWebSocketError extends Error {
  constructor(code, messageName, data = null) {
    super(`Core WebSocket ${messageName} failed: ${code}${data !== null && data !== undefined ? ` ${JSON.stringify(data)}` : ""}`);
    this.name = "CoreWebSocketError";
    this.code = Number(code);
    this.messageName = messageName;
    this.data = data;
  }
}

export class CoreWebSocket {
  constructor(endpoint, { onEvent = null } = {}) {
    this.endpoint = endpoint;
    this.onEvent = onEvent;
    this.socket = null;
    this.requestId = 1;
    this.pending = new Map();
    this.connecting = null;
  }

  get connected() { return this.socket?.readyState === WebSocketPeer.OPEN; }

  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.#open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #open() {
    // The Core limits concurrent WebSocket sessions and answers 503 with a retry period when the limit is reached.
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const socket = await connectWebSocket(endpointWsUrl(this.endpoint), {
          headers: { "API-KEY": this.endpoint.api_key },
          timeoutMs: 9000,
          rejectUnauthorized: this.endpoint.verify_tls !== false
        });
        this.socket = socket;
        socket.on("message", (raw) => this.#handleMessage(raw));
        socket.on("close", () => { if (this.socket === socket) this.socket = null; this.#rejectPending(new Error("Core WebSocket closed")); });
        socket.on("error", (error) => this.#rejectPending(error));
        return;
      } catch (error) {
        lastError = error;
        if (error?.status !== 503) throw error;
        const wait = Math.min(30_000, Math.max(500, Number(error.retryAfterMs ?? 2000 * (attempt + 1))));
        log.warn(`Core WebSocket connection limit reached; retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
    throw lastError;
  }

  #handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.kind === "event") {
      this.onEvent?.(message);
      return;
    }
    const id = message.req_id ?? message.id;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    const code = Number(message.code ?? 500);
    if (code < 200 || code >= 300) pending.reject(new CoreWebSocketError(code, pending.name, message.msg_data));
    else pending.resolve(message);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  async request(name, data = undefined, timeoutMs = 10_000) {
    await this.connect();
    const id = this.requestId++;
    const payload = { kind: "req", id, msg: name };
    if (data !== undefined) payload.msg_data = data;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Core WebSocket ${name} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, name });
      try { this.socket.send(JSON.stringify(payload)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  subscribeAll() { return this.request("subscribe_events", { channels: ["all"] }); }

  async close() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    if (socket.readyState === WebSocketPeer.CLOSED) return;
    await new Promise((resolve) => { socket.once("close", resolve); socket.close(); setTimeout(() => { socket.terminate(); resolve(); }, 3000).unref?.(); });
  }
}

// -----------------------------------------------------------------------------
// Core event watcher
// -----------------------------------------------------------------------------

// Changed attributes of an entity_change event. Cores report them as `attributes`, inside `new_state` or inside
// `entity`; null means the event carried none and the entity has to be read back.
// Event types that add or remove something. The Core sends NEW / DELETE; CREATE is accepted for older firmware.
const STRUCTURAL_EVENTS = new Set(["NEW", "CREATE", "DELETE"]);
const CONFIGURATION_FIELDS = ["name", "icon", "description", "options"];

function hasConfigurationFields(data) {
  const update = data?.new_state && typeof data.new_state === "object" ? data.new_state : null;
  return Boolean(update) && CONFIGURATION_FIELDS.some((key) => update[key] !== undefined);
}

export function entityChangeAttributes(data) {
  if (!data || typeof data !== "object") return null;
  for (const candidate of [data.attributes, data.new_state?.attributes, data.entity?.attributes]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  }
  if (typeof data.new_state === "string") return { state: data.new_state };
  if (typeof data.state === "string") return { state: data.state };
  if (typeof data.new_state?.state === "string") return { state: data.new_state.state };
  return null;
}

export class CoreEventWatcher {
  constructor(endpoint, callback, { debounceMs = DEFAULT_EVENT_DEBOUNCE_MS, activityStateCallback = null, entityStateCallback = null, reconnectCallback = null, configurationDetailCallback = null, configurationFilter = null } = {}) {
    this.configurationDetailCallback = configurationDetailCallback;
    this.configurationFilter = configurationFilter;
    this.endpoint = endpoint;
    this.callback = callback;
    this.activityStateCallback = activityStateCallback;
    this.entityStateCallback = entityStateCallback;
    this.debounceMs = debounceMs;
    this.reconnectCallback = reconnectCallback;
    this.stopped = false;
    this.pending = new Set();
    this.timer = null;
    this.client = null;
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.client?.close(); }
  async run() {
    const backoff = [1000, 2000, 5000, 10_000, 30_000];
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.client = new CoreWebSocket(this.endpoint, { onEvent: (message) => this.handleEvent(message) });
        await this.client.connect();
        await this.client.subscribeAll();
        const reconnected = attempt > 0;
        attempt = 0;
        if (reconnected) await this.reconnectCallback?.();
        await new Promise((resolve) => this.client.socket.once("close", resolve));
      } catch (error) {
        if (!this.stopped) log.warn("Core event stream disconnected:", error.message);
        if (error?.retryAfterMs) await sleep(Math.min(60_000, error.retryAfterMs));
      } finally {
        await this.client?.close();
        this.client = null;
      }
      if (!this.stopped) await sleep(backoff[Math.min(attempt++, backoff.length - 1)]);
    }
  }
  // Entry point for every Core event message ({ msg, msg_data }).
  handleEvent(message) { this.#event(message); }

  #event(message) {
    const name = String(message.msg || "");
    const data = message.msg_data;
    const activityState = this.#activityStateEvent(name, data);
    if (activityState && this.activityStateCallback) {
      Promise.resolve(this.activityStateCallback(activityState)).catch((error) => log.error("Activity-state callback failed:", error));
    }
    const entityState = this.#entityStateEvent(name, data);
    if (entityState && this.entityStateCallback) {
      try { this.entityStateCallback(entityState); } catch (error) { log.error("Entity-state callback failed:", error); }
    }
    if (!this.#configurationEvent(name, data)) return;
    if (this.configurationDetailCallback) {
      try { this.configurationDetailCallback(name, data); } catch (error) { log.error("Configuration-detail callback failed:", error); }
    }
    this.pending.add(name);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#flush(), this.debounceMs);
    this.timer.unref?.();
  }
  #activityStateEvent(name, data) {
    if (name !== "entity_change" || !data || typeof data !== "object") return null;
    const entityType = String(data.entity_type || data.entity?.entity_type || "").toLowerCase();
    const entityId = String(data.entity_id || data.entity?.entity_id || "");
    const eventType = String(data.event_type || "").toUpperCase();
    if (!entityId || STRUCTURAL_EVENTS.has(eventType)) return null;
    if (entityType !== "activity" && !entityId.startsWith("uc.main.")) return null;
    const state = entityChangeAttributes(data)?.state;
    return {
      source_activity_id: entityId,
      state: typeof state === "string" ? state : null,
      entity_type: entityType || null,
      event_type: eventType
    };
  }
  #entityStateEvent(name, data) {
    if (name !== "entity_change" || !data || typeof data !== "object") return null;
    const eventType = String(data.event_type || "").toUpperCase();
    const entityId = String(data.entity_id || data.entity?.entity_id || "");
    if (!entityId || STRUCTURAL_EVENTS.has(eventType) || entityId.startsWith("remote_sync.main.")) return null;
    return { entity_id: entityId, entity_type: String(data.entity_type || data.entity?.entity_type || "").toLowerCase() || null, attributes: entityChangeAttributes(data) };
  }
  #configurationEvent(name, data) {
    if (!CONFIG_EVENT_NAMES.has(name)) return false;
    if (this.configurationFilter && !this.configurationFilter(name, data)) return false;
    if (name === "configuration_change") return Boolean(this.configurationFilter);
    if (name !== "entity_change") return true;
    if (!data || typeof data !== "object") return true;
    const eventType = String(data.event_type || "").toUpperCase();
    const entityType = String(data.entity_type || "").toLowerCase();
    const entityId = String(data.entity_id || "");
    if (entityId.startsWith("remote_sync.main.")) return false;
    // Added or removed entities always change the configuration (the Core reports NEW; older docs said CREATE).
    if (STRUCTURAL_EVENTS.has(eventType)) return true;
    const changedAttributes = entityChangeAttributes(data) || {};
    const attributeKeys = Object.keys(changedAttributes);
    const internal = ["activity", "macro", "remote"].includes(entityType) || entityId.startsWith("uc.main.");
    const stateOnlyActivityUpdate = internal
      && attributeKeys.length > 0
      && attributeKeys.every((key) => ["state", "progress", "step", "timeout", "total_steps", "error"].includes(String(key)))
      && !hasConfigurationFields(data);
    if (stateOnlyActivityUpdate) return false;
    // Renamed entities, new icons or changed options: configuration of any entity type.
    if (hasConfigurationFields(data)) return true;
    return internal;
  }
  async #flush() {
    this.timer = null;
    const events = new Set(this.pending);
    this.pending.clear();
    try { await this.callback(events); } catch (error) { log.error("Configuration-event callback failed:", error); }
  }
}
