import crypto from "node:crypto";
import { logger } from "../shared/logger.js";

const log = logger("link-hub");

export const LINK_PATH = "/v1/link";
export const LINK_PROTOCOL = 1;
export const HEARTBEAT_MS = 15_000;
export const LINK_TIMEOUT_MS = 45_000;
export const REPLAY_BUFFER_SIZE = 2000;

// -----------------------------------------------------------------------------
// Persistent link (Primary side)
// -----------------------------------------------------------------------------
//
// Every Satellite keeps one WebSocket open to the Primary while it is awake. The Primary numbers everything it sends
// (live entity states, activity states) within an epoch that changes whenever the Primary restarts. A Satellite that
// reconnects says which epoch and sequence number it saw last: missed events are replayed from a buffer, and when they
// are no longer buffered (or the Primary restarted) it receives a complete state image instead. Nothing it missed can
// stay missing. Commands and activity starts travel the other way on the same socket.

export class LinkHub {
  constructor({
    onHello = null,
    onCommand = null,
    onActivityRelay = null,
    onDrift = null,
    fullState = async () => ({ states: [], activities: [] }),
    heartbeatMs = HEARTBEAT_MS,
    timeoutMs = LINK_TIMEOUT_MS,
    bufferSize = REPLAY_BUFFER_SIZE
  } = {}) {
    this.onHello = onHello;
    this.onCommand = onCommand;
    this.onActivityRelay = onActivityRelay;
    this.onDrift = onDrift;
    this.fullState = fullState;
    this.heartbeatMs = heartbeatMs;
    this.timeoutMs = timeoutMs;
    this.bufferSize = bufferSize;
    this.epoch = crypto.randomUUID();
    this.seq = 0;
    this.buffer = [];
    this.sessions = new Map();
    this.timer = setInterval(() => this.#heartbeat(), heartbeatMs);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    for (const session of this.sessions.values()) session.close("primary stopping");
    this.sessions.clear();
  }

  isConnected(peerId) { return this.sessions.get(peerId)?.ready === true; }

  connectedPeers() { return [...this.sessions.values()].filter((session) => session.ready).map((session) => session.peer.peer_id); }

  status(peerId) {
    const session = this.sessions.get(peerId);
    if (!session) return { connected: false };
    return { connected: session.ready, since: session.since, last_seen_at: new Date(session.lastSeen).toISOString(), hardware: session.hello?.hardware || null, version: session.hello?.version || null };
  }

  // Attach an accepted WebSocket of an authenticated Satellite.
  attach(socket, peer) {
    const previous = this.sessions.get(peer.peer_id);
    if (previous) previous.close("replaced by a new connection");
    const session = new HubSession(this, socket, peer);
    this.sessions.set(peer.peer_id, session);
    socket.on("close", () => {
      if (this.sessions.get(peer.peer_id) === session) this.sessions.delete(peer.peer_id);
      log.info(`Link to ${peer.name || peer.peer_id} closed`);
    });
    return session;
  }

  // Publish an event to every connected Satellite and keep it for replay.
  publish(type, payload) {
    const event = { type, seq: ++this.seq, epoch: this.epoch, ...payload };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    for (const session of this.sessions.values()) if (session.ready) session.send(event);
    return event.seq;
  }

  // Send an event to one Satellite only (not buffered: used for answers to that Satellite's own requests).
  sendTo(peerId, message) {
    const session = this.sessions.get(peerId);
    if (!session?.ready) return false;
    session.send(message);
    return true;
  }

  async resync(peerId) {
    const session = this.sessions.get(peerId);
    if (session?.ready) await session.sendFullState("requested");
  }

  replayFrom(epoch, lastSeq) {
    if (epoch !== this.epoch) return null;
    const after = Number(lastSeq);
    if (!Number.isSafeInteger(after) || after < 0 || after > this.seq) return null;
    if (after === this.seq) return [];
    const first = this.buffer[0]?.seq ?? this.seq + 1;
    if (after + 1 < first) return null;
    return this.buffer.filter((event) => event.seq > after);
  }

  #heartbeat() {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastSeen > this.timeoutMs) {
        log.warn(`Link to ${session.peer.name || session.peer.peer_id} timed out`);
        session.close("heartbeat timeout");
        continue;
      }
      session.send({ type: "ping", at: now });
    }
  }
}

class HubSession {
  constructor(hub, socket, peer) {
    this.hub = hub;
    this.socket = socket;
    this.peer = peer;
    this.ready = false;
    this.hello = null;
    this.since = new Date().toISOString();
    this.lastSeen = Date.now();
    socket.on("message", (raw) => this.#message(raw).catch((error) => log.warn(`Link message from ${peer.name || peer.peer_id} failed:`, error.message)));
    socket.on("error", (error) => log.debug("Link socket error:", error.message));
  }

  send(message) {
    try { this.socket.send(JSON.stringify(message)); }
    catch (error) { log.debug("Link send failed:", error.message); }
  }

  close(reason) {
    this.ready = false;
    try { this.socket.close(1000, reason); } catch { try { this.socket.terminate(); } catch {} }
  }

  // Sends a complete state image. Live events are held back while it is read; the image is stamped with the sequence
  // number from before the read, and every event published meanwhile follows it, so the Satellite applies them in order
  // and never lets an older image overwrite newer events.
  async sendFullState(reason) {
    const wasReady = this.ready;
    this.ready = false;
    const before = this.hub.seq;
    try {
      const image = await this.hub.fullState(this.peer);
      this.send({ type: "full", epoch: this.hub.epoch, seq: before, reason, states: image.states || [], activities: image.activities || [] });
      for (const event of this.hub.buffer) if (event.seq > before) this.send(event);
      this.ready = true;
    } catch (error) {
      this.ready = wasReady;
      throw error;
    }
  }

  async #message(raw) {
    this.lastSeen = Date.now();
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const type = String(message?.type || "");
    if (type === "pong" || type === "ping") { if (type === "ping") this.send({ type: "pong", at: message.at }); return; }
    if (type === "hello") return this.#hello(message);
    // Commands are accepted as soon as the Satellite introduced itself, even while a state image is being prepared.
    if (!this.hello) return;
    if (type === "resync") { if (this.ready) await this.sendFullState("requested"); return; }
    if (type === "command" || type === "activity_relay") {
      const handler = type === "command" ? this.hub.onCommand : this.hub.onActivityRelay;
      let result;
      try { result = handler ? await handler(this.peer, message) : { success: false, status: 501, error: "Not supported" }; }
      catch (error) { result = { success: false, status: 500, error: error.message }; }
      this.send({ type: "result", id: message.id, result });
      return;
    }
    if (type === "drift") { await this.hub.onDrift?.(this.peer, message); return; }
  }

  async #hello(message) {
    this.hello = message;
    this.send({ type: "welcome", epoch: this.hub.epoch, seq: this.hub.seq, protocol: LINK_PROTOCOL });
    const replay = this.hub.replayFrom(message.epoch, message.last_seq);
    if (replay) {
      for (const event of replay) this.send(event);
      this.send({ type: "resumed", epoch: this.hub.epoch, seq: this.hub.seq });
      this.ready = true;
      log.info(`Link to ${this.peer.name || this.peer.peer_id} resumed (${replay.length} missed event(s) replayed)`);
    } else {
      await this.sendFullState(message.epoch ? "gap" : "initial");
      log.info(`Link to ${this.peer.name || this.peer.peer_id} established with a full state image`);
    }
    try { await this.hub.onHello?.(this.peer, message); } catch (error) { log.warn("Link hello handler failed:", error.message); }
  }
}
