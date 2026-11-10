import crypto from "node:crypto";
import { connectWebSocket } from "../transport/websocket.js";
import { logger } from "../shared/logger.js";
import { HEARTBEAT_MS, LINK_PATH, LINK_TIMEOUT_MS } from "./hub.js";

const log = logger("link");

const RECONNECT_SCHEDULE_MS = [1000, 2000, 5000, 10_000];
const REQUEST_TIMEOUT_MS = 15_000;

export function linkUrl(agentUrl) {
  const url = new URL(String(agentUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = LINK_PATH;
  url.search = "";
  return url.toString();
}

// -----------------------------------------------------------------------------
// Persistent link (Satellite side)
// -----------------------------------------------------------------------------
//
// Keeps one WebSocket to the Primary open while this remote is awake and reconnects on its own. The Satellite never
// wakes the Primary just to hold the link; commands that need a sleeping Primary use the HTTP path, which does.

export class LinkClient {
  constructor({
    getTarget,
    hello = () => ({}),
    onFull = async () => {},
    onEvent = async () => {},
    onStatus = () => {},
    connect = connectWebSocket,
    heartbeatMs = HEARTBEAT_MS,
    timeoutMs = LINK_TIMEOUT_MS,
    reconnectScheduleMs = RECONNECT_SCHEDULE_MS
  }) {
    this.getTarget = getTarget;
    this.hello = hello;
    this.onFull = onFull;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.connectImpl = connect;
    this.heartbeatMs = heartbeatMs;
    this.timeoutMs = timeoutMs;
    this.reconnectScheduleMs = reconnectScheduleMs;
    this.socket = null;
    this.ready = false;
    this.stopped = true;
    this.epoch = null;
    this.lastSeq = 0;
    this.pending = new Map();
    this.attempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.lastSeen = 0;
    this.queue = Promise.resolve();
    this.lastError = null;
    this.connectedAt = null;
  }

  get connected() { return this.ready; }

  status() {
    return { connected: this.ready, connected_at: this.connectedAt, epoch: this.epoch, last_seq: this.lastSeq, last_error: this.lastError };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#connectSoon(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.#rejectPending(new Error("Link stopped"));
    const socket = this.socket;
    this.socket = null;
    this.#setReady(false);
    try { socket?.close(1000, "satellite stopping"); } catch {}
  }

  // Reconnect at once (after standby, or when a command found the link down).
  nudge() {
    if (this.stopped || this.ready || this.socket) return;
    this.attempt = 0;
    this.#connectSoon(0);
  }

  async request(type, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.ready) throw Object.assign(new Error("Link to the Primary is not connected"), { code: "LINK_DOWN" });
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`Primary did not answer ${type} within ${Math.round(timeoutMs / 1000)}s`), { code: "LINK_TIMEOUT" })); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.#send({ type, id, ...payload })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Object.assign(new Error("Link to the Primary is not connected"), { code: "LINK_DOWN" }));
      }
    });
  }

  send(type, payload = {}) { return this.ready && this.#send({ type, ...payload }); }

  requestResync() { return Boolean(this.socket) && this.#send({ type: "resync" }); }

  #send(message) {
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch { return false; }
  }

  #setReady(ready) {
    if (this.ready === ready) return;
    this.ready = ready;
    this.connectedAt = ready ? new Date().toISOString() : null;
    try { this.onStatus(this.status()); } catch {}
  }

  #connectSoon(delayMs) {
    clearTimeout(this.reconnectTimer);
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => this.#connect().catch((error) => this.#failed(error)), delayMs);
    this.reconnectTimer.unref?.();
  }

  #failed(error) {
    this.lastError = error?.message || String(error);
    this.socket = null;
    this.#setReady(false);
    if (this.stopped) return;
    const delay = this.reconnectScheduleMs[Math.min(this.attempt++, this.reconnectScheduleMs.length - 1)];
    log.debug(`Link to the Primary unavailable (${this.lastError}); retrying in ${Math.round(delay / 1000)}s`);
    this.#connectSoon(delay);
  }

  async #connect() {
    const target = this.getTarget();
    if (!target?.url || !target?.token) { this.#failed(new Error("Primary address is not known yet")); return; }
    const socket = await this.connectImpl(linkUrl(target.url), { headers: { Authorization: `Bearer ${target.token}` }, timeoutMs: 8000 });
    if (this.stopped) { try { socket.close(); } catch {} return; }
    this.socket = socket;
    this.lastSeen = Date.now();
    // Only the current socket counts: messages that arrive on a socket this client already gave up are ignored, so the
    // sequence number always reflects what was really applied.
    socket.on("message", (raw) => { if (this.socket !== socket) return; this.lastSeen = Date.now(); this.#message(raw); });
    socket.on("error", (error) => log.debug("Link socket error:", error.message));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      clearInterval(this.heartbeatTimer);
      this.#rejectPending(Object.assign(new Error("Link to the Primary closed"), { code: "LINK_DOWN" }));
      if (this.ready) log.info("Link to the Primary closed; reconnecting");
      this.#failed(new Error("connection closed"));
    });
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastSeen > this.timeoutMs) { log.warn("Link to the Primary timed out"); try { socket.terminate(); } catch {} return; }
      this.#send({ type: "ping", at: Date.now() });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    this.#send({ type: "hello", epoch: this.epoch, last_seq: this.lastSeq, ...this.hello() });
  }

  #message(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const type = String(message?.type || "");
    if (type === "ping") { this.#send({ type: "pong", at: message.at }); return; }
    if (type === "pong") return;
    if (type === "result") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message.result || { success: false, error: "Empty result" });
      return;
    }
    if (type === "welcome") {
      this.attempt = 0;
      this.lastError = null;
      if (message.epoch !== this.epoch) log.info("Linked to the Primary (new session)");
      return;
    }
    // State messages are applied strictly in order.
    this.queue = this.queue.then(() => this.#apply(message)).catch((error) => log.warn("Applying a link message failed:", error.message));
  }

  async #apply(message) {
    if (message.type === "full") {
      await this.onFull(message);
      this.epoch = message.epoch;
      this.lastSeq = Number(message.seq) || 0;
      this.#setReady(true);
      return;
    }
    if (message.type === "resumed") {
      if (message.epoch === this.epoch && Number(message.seq) === this.lastSeq) this.#setReady(true);
      else this.requestResync();
      return;
    }
    const seq = Number(message.seq);
    if (!Number.isSafeInteger(seq)) return;
    if (message.epoch !== this.epoch) { this.requestResync(); return; }
    if (seq <= this.lastSeq) return;
    if (seq !== this.lastSeq + 1) {
      // A gap can only come from a broken connection; ask for a complete image rather than guess.
      log.warn(`Link sequence gap (${this.lastSeq} → ${seq}); requesting a full state image`);
      this.requestResync();
      return;
    }
    await this.onEvent(message);
    this.lastSeq = seq;
    if (!this.ready) this.#setReady(true);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
