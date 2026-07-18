import crypto from "node:crypto";
import { DEFAULT_VIRTUAL_DOCK_PORT } from "../shared/constants.js";
import { connectWebSocket, createWebSocketHttpServer, WebSocketPeer } from "../transport/websocket.js";
import { logger } from "../shared/logger.js";

const log = logger("dock-proxy");
// -----------------------------------------------------------------------------
// Tunnel endpoints
// -----------------------------------------------------------------------------

const DOCK_TUNNEL_PATH = "/v1/dock/tunnel";
const VIRTUAL_DOCK_PATH = "/v1/docks/";

// -----------------------------------------------------------------------------
// Virtual Dock addressing
// -----------------------------------------------------------------------------

export function virtualDockToken(agentToken, sourceNodeId, sourceDockId) {
  return crypto.createHmac("sha256", String(agentToken || ""))
    .update(`uc-remote-sync-dock\0${String(sourceNodeId || "")}\0${String(sourceDockId || "")}`)
    .digest("base64url")
    .slice(0, 40);
}

export function virtualDockUrl(config, sourceDockId) {
  const port = Number(config?.virtual_dock_port || DEFAULT_VIRTUAL_DOCK_PORT);
  return `ws://127.0.0.1:${port}${VIRTUAL_DOCK_PATH}${encodeURIComponent(String(sourceDockId))}`;
}

export function dockTunnelUrl(masterAgentUrl, sourceDockId) {
  const url = new URL(String(masterAgentUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = DOCK_TUNNEL_PATH;
  url.search = "";
  url.searchParams.set("dock_id", String(sourceDockId));
  return url.toString();
}

// -----------------------------------------------------------------------------
// Physical Dock resolution
// -----------------------------------------------------------------------------

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function physicalDockConnection(detail = {}, { dockId = null, token: configuredToken = null } = {}) {
  const nested = detail.dock && typeof detail.dock === "object" ? detail.dock : {};
  const credentials = detail.credentials && typeof detail.credentials === "object" ? detail.credentials : {};
  let url = firstString(
    detail.custom_ws_url,
    detail.resolved_ws_url,
    detail.ws_url,
    detail.websocket_url,
    detail.url,
    nested.custom_ws_url,
    nested.resolved_ws_url,
    nested.ws_url,
    nested.websocket_url,
    nested.url
  );
  if (!url) {
    const addressObject = detail.address && typeof detail.address === "object" ? detail.address : {};
    const host = firstString(
      detail.host,
      detail.hostname,
      detail.ip,
      typeof detail.address === "string" ? detail.address : null,
      addressObject.host,
      addressObject.hostname,
      addressObject.ip,
      nested.host,
      nested.hostname,
      nested.ip
    );
    if (host) url = `ws://${host}:946`;
  }
  if (!url && dockId) {
    const serviceHost = String(dockId).replace(/\.$/, "");
    url = `ws://${serviceHost.toLowerCase().endsWith(".local") ? serviceHost : `${serviceHost}.local`}:946`;
  }
  if (url && !/^[a-z]+:\/\//i.test(url)) url = `ws://${url}`;
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    if (!["ws:", "wss:"].includes(parsed.protocol)) throw new Error(`Unsupported physical Dock URL scheme ${parsed.protocol}`);
    url = parsed.toString();
  }
  const token = firstString(
    configuredToken,
    detail.token,
    detail.auth_token,
    detail.api_token,
    credentials.token,
    nested.token,
    nested.auth_token,
    nested.api_token
  );
  return { url, token };
}

// -----------------------------------------------------------------------------
// WebSocket relay
// -----------------------------------------------------------------------------

function closePeer(peer, code = 1000, reason = "") {
  try {
    if (peer?.readyState === WebSocketPeer.OPEN) peer.close(code, reason);
    else peer?.terminate?.();
  } catch { /* best effort */ }
}

function relayPeers(left, right, { leftToRight = (value) => value, onClose = null } = {}) {
  let closed = false;
  const finish = (origin, code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    closePeer(origin === left ? right : left, code, reason);
    onClose?.();
  };
  left.on("message", (raw) => {
    try {
      const value = leftToRight(raw);
      if (value !== null && value !== undefined && right.readyState === WebSocketPeer.OPEN) right.send(value);
    } catch (error) {
      log.warn("Dock tunnel request transform failed:", error.message);
      closePeer(left, 1008, "Invalid Dock request");
      closePeer(right, 1008, "Invalid Dock request");
    }
  });
  right.on("message", (raw) => {
    if (left.readyState === WebSocketPeer.OPEN) left.send(raw);
  });
  left.on("close", () => finish(left));
  right.on("close", () => finish(right));
  left.on("error", (error) => { log.debug("Local Dock socket error:", error.message); finish(left, 1011, "Dock tunnel error"); });
  right.on("error", (error) => { log.debug("Upstream Dock socket error:", error.message); finish(right, 1011, "Dock tunnel error"); });
  return () => { closePeer(left); closePeer(right); finish(left); };
}

export async function bridgeMasterDockTunnel({ downstream, physicalUrl, physicalToken, virtualToken, connect = connectWebSocket }) {
  if (!physicalUrl) throw new Error("The primary Core did not expose a physical Dock WebSocket URL");
  if (!physicalToken) throw new Error("No physical Dock API token is configured on the primary; reconfigure Remote Sync and enter the Dock token");
  const upstream = await connect(physicalUrl, { timeoutMs: 10_000 });
  const transform = (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return raw; }
    if (message?.type !== "auth") return raw;
    if (String(message.token || "") !== String(virtualToken || "")) {
      const response = {
        type: "authentication",
        ...(message.id !== undefined ? { req_id: message.id } : {}),
        code: 401,
        error: "Invalid token"
      };
      downstream.send(JSON.stringify(response));
      return null;
    }
    return JSON.stringify({ ...message, token: physicalToken });
  };
  return relayPeers(downstream, upstream, { leftToRight: transform });
}

// -----------------------------------------------------------------------------
// Satellite virtual Dock server
// -----------------------------------------------------------------------------

export class VirtualDockServer {
  constructor(config, { connect = connectWebSocket } = {}) {
    this.config = config;
    this.connect = connect;
    this.server = null;
    this.sourceNodeId = null;
    this.docks = new Set();
    this.sessions = new Set();
  }

  setDocks(sourceNodeId, records = []) {
    this.sourceNodeId = String(sourceNodeId || "");
    this.docks = new Set(records.map((record) => String(record?.source_id || record?.detail?.dock_id || record?.detail?.id || "")).filter(Boolean));
  }

  async start() {
    if (this.server) return;
    this.server = createWebSocketHttpServer({
      host: "0.0.0.0",
      port: Number(this.config.virtual_dock_port || DEFAULT_VIRTUAL_DOCK_PORT),
      onConnection: (peer, request) => this.#connection(peer, request)
    });
    await this.server.listen();
    log.info(`Virtual Dock server listening on port ${Number(this.config.virtual_dock_port || DEFAULT_VIRTUAL_DOCK_PORT)}`);
  }

  async stop() {
    for (const close of this.sessions) close();
    this.sessions.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await server.close();
  }

  status() {
    return {
      port: Number(this.config.virtual_dock_port || DEFAULT_VIRTUAL_DOCK_PORT),
      docks: this.docks.size,
      sessions: this.sessions.size
    };
  }

  async #connection(peer, request) {
    peer.on("error", (error) => log.debug("Virtual Dock client error:", error.message));
    let sourceDockId = null;
    try {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith(VIRTUAL_DOCK_PATH)) throw new Error("Unknown virtual Dock endpoint");
      sourceDockId = decodeURIComponent(url.pathname.slice(VIRTUAL_DOCK_PATH.length));
      if (!sourceDockId) throw new Error("Unknown virtual Dock");
      const pairing = this.config.pairing || {};
      if (!pairing.master_agent_url || !pairing.master_command_token) throw new Error("Primary Dock tunnel is not configured");
      const upstream = await this.connect(dockTunnelUrl(pairing.master_agent_url, sourceDockId), {
        headers: { Authorization: `Bearer ${pairing.master_command_token}` },
        timeoutMs: 10_000
      });
      let close = null;
      close = relayPeers(peer, upstream, { onClose: () => this.sessions.delete(close) });
      this.sessions.add(close);
      log.info(`Virtual Dock ${sourceDockId} connected to primary tunnel`);
    } catch (error) {
      log.warn(`Virtual Dock ${sourceDockId || "connection"} failed:`, error.message);
      closePeer(peer, 1011, "Primary Dock unavailable");
    }
  }
}
