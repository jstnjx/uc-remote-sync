import { connectWebSocket, WebSocketPeer } from "./websocket.js";
import { CONFIG_EVENT_NAMES, DEFAULT_EVENT_DEBOUNCE_MS } from "./constants.js";
import { endpointWsUrl } from "./models.js";
import { logger } from "./logger.js";
import { sleep } from "./util.js";

const log = logger("core-ws");

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
  }

  async connect() {
    if (this.socket?.readyState === WebSocketPeer.OPEN) return;
    this.socket = await connectWebSocket(endpointWsUrl(this.endpoint), {
      headers: { "API-KEY": this.endpoint.api_key },
      timeoutMs: 9000,
      rejectUnauthorized: this.endpoint.verify_tls !== false
    });
    this.socket.on("message", (raw) => this.#handleMessage(raw));
    this.socket.on("close", () => this.#rejectPending(new Error("Core WebSocket closed")));
    this.socket.on("error", (error) => this.#rejectPending(error));
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

export class CoreEventWatcher {
  constructor(endpoint, callback, { debounceMs = DEFAULT_EVENT_DEBOUNCE_MS, activityStateCallback = null } = {}) {
    this.endpoint = endpoint;
    this.callback = callback;
    this.activityStateCallback = activityStateCallback;
    this.debounceMs = debounceMs;
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
        this.client = new CoreWebSocket(this.endpoint, { onEvent: (message) => this.#event(message) });
        await this.client.connect();
        await this.client.subscribeAll();
        attempt = 0;
        await new Promise((resolve) => this.client.socket.once("close", resolve));
      } catch (error) {
        if (!this.stopped) log.warn("Core event stream disconnected:", error.message);
      } finally {
        await this.client?.close();
        this.client = null;
      }
      if (!this.stopped) await sleep(backoff[Math.min(attempt++, backoff.length - 1)]);
    }
  }
  #event(message) {
    const name = String(message.msg || "");
    const data = message.msg_data;
    const activityState = this.#activityStateEvent(name, data);
    if (activityState && this.activityStateCallback) {
      Promise.resolve(this.activityStateCallback(activityState)).catch((error) => log.error("Activity-state callback failed:", error));
    }
    if (!this.#configurationEvent(name, data)) return;
    this.pending.add(name);
    if (!this.timer) this.timer = setTimeout(() => this.#flush(), this.debounceMs);
  }
  #activityStateEvent(name, data) {
    if (name !== "entity_change" || !data || typeof data !== "object") return null;
    const entityType = String(data.entity_type || data.entity?.entity_type || "").toLowerCase();
    const entityId = String(data.entity_id || data.entity?.entity_id || "");
    const eventType = String(data.event_type || "").toUpperCase();
    if (!entityId || ["CREATE", "DELETE"].includes(eventType)) return null;
    if (entityType !== "activity" && !entityId.startsWith("uc.main.")) return null;
    const state = data.attributes?.state ?? data.state ?? data.entity?.attributes?.state ?? data.new_state;
    return {
      source_activity_id: entityId,
      state: typeof state === "string" ? state : null,
      entity_type: entityType || null,
      event_type: eventType
    };
  }
  #configurationEvent(name, data) {
    if (!CONFIG_EVENT_NAMES.has(name)) return false;
    if (name !== "entity_change") return true;
    if (!data || typeof data !== "object") return true;
    const eventType = String(data.event_type || "").toUpperCase();
    const entityType = String(data.entity_type || "").toLowerCase();
    const entityId = String(data.entity_id || "");
    if (entityId.startsWith("remote_sync.main.")) return false;
    const changedAttributes = data.attributes && typeof data.attributes === "object"
      ? data.attributes
      : (data.entity?.attributes && typeof data.entity.attributes === "object" ? data.entity.attributes : {});
    const attributeKeys = Object.keys(changedAttributes);
    const stateOnlyActivityUpdate = (entityType === "activity" || entityId.startsWith("uc.main."))
      && !["CREATE", "DELETE"].includes(eventType)
      && (attributeKeys.length > 0 || typeof data.state === "string" || typeof data.new_state === "string")
      && attributeKeys.every((key) => ["state", "progress", "step", "timeout", "total_steps", "error"].includes(String(key)));
    if (stateOnlyActivityUpdate) return false;
    return ["CREATE", "DELETE"].includes(eventType) || ["activity", "macro", "remote"].includes(entityType) || entityId.startsWith("uc.main.");
  }
  async #flush() {
    this.timer = null;
    const events = new Set(this.pending);
    this.pending.clear();
    try { await this.callback(events); } catch (error) { log.error("Configuration-event callback failed:", error); }
  }
}
