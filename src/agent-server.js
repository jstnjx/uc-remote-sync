import http from "node:http";
import { AGENT_API_VERSION, APP_VERSION, MAX_SNAPSHOT_BYTES } from "./constants.js";
import { RemoteSyncMdnsPublisher } from "./pairing-mdns.js";
import { SnapshotReader } from "./snapshot.js";
import { verifyHmac } from "./util.js";
import { acceptWebSocketUpgrade, rejectWebSocketUpgrade } from "./websocket.js";
import { logger } from "./logger.js";

const log = logger("agent");

function jsonResponse(response, status, value, headers = {}) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": payload.length, ...headers });
  response.end(payload);
}

async function readBody(request, limit = MAX_SNAPSHOT_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, limit = 1024 * 1024) {
  const body = await readBody(request, limit);
  if (!body.length) return {};
  try { return JSON.parse(body.toString()); }
  catch { throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 }); }
}

export class AgentServer {
  constructor(config, { applyCallback, statusCallback, syncCallback, pairingCallback, commandCallback, activityStateCallback = null, dockTunnelCallback = null }) {
    this.config = config;
    this.applyCallback = applyCallback;
    this.statusCallback = statusCallback;
    this.syncCallback = syncCallback;
    this.pairingCallback = pairingCallback;
    this.commandCallback = commandCallback;
    this.activityStateCallback = activityStateCallback;
    this.dockTunnelCallback = dockTunnelCallback;
    this.server = null;
    this.publisher = null;
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer((request, response) => this.#handle(request, response));
    this.server.on("upgrade", (request, socket, head) => this.#handleUpgrade(request, socket, head));
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.config.agent_port, "0.0.0.0");
    });
    this.server.on("error", (error) => log.error("Agent server error:", error));
    log.info(`Remote Sync agent listening on port ${this.config.agent_port}`);

    if (this.config.role === "child" && this.config.pairing_identifier) {
      this.publisher = new RemoteSyncMdnsPublisher({
        identifier: this.config.pairing_identifier,
        port: this.config.agent_port,
        name: this.config.node_name,
        version: APP_VERSION,
        nodeId: this.config.node_id,
        ready: this.config.pairing?.ready_to_pair !== false,
        interfaceValue: process.env.UC_MDNS_ADDRESS || process.env.UC_INTEGRATION_INTERFACE || null
      });
      try { await this.publisher.start(); }
      catch (error) { log.warn("Child pairing mDNS advertisement failed:", error.message); this.publisher.close(); this.publisher = null; }
    }
  }

  async stop() {
    this.publisher?.close();
    this.publisher = null;
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }

  #authorized(request) {
    return request.headers.authorization === `Bearer ${this.config.agent_token}`;
  }

  #commandPeer(request) {
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token || this.config.role !== "master") return null;
    return this.config.peers.find((peer) => peer.enabled !== false && peer.command_token && peer.command_token === token) || null;
  }

  #commandAuthorized(request) {
    return Boolean(this.#commandPeer(request));
  }

  #handleUpgrade(request, socket, head) {
    let url;
    try { url = new URL(request.url, "http://localhost"); }
    catch { rejectWebSocketUpgrade(socket, 400, "Bad Request"); return; }
    if (url.pathname !== `/v${AGENT_API_VERSION}/dock/tunnel`) {
      rejectWebSocketUpgrade(socket, 404, "Not Found");
      return;
    }
    const child = this.#commandPeer(request);
    if (!child) {
      rejectWebSocketUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (!this.dockTunnelCallback) {
      rejectWebSocketUpgrade(socket, 501, "Not Implemented");
      return;
    }
    const dockId = String(url.searchParams.get("dock_id") || "").trim();
    if (!dockId) {
      rejectWebSocketUpgrade(socket, 400, "Missing dock_id");
      return;
    }
    const peer = acceptWebSocketUpgrade(request, socket, head);
    if (!peer) return;
    peer.on("error", (error) => log.debug("Dock tunnel client error:", error.message));
    Promise.resolve(this.dockTunnelCallback({ downstream: peer, dock_id: dockId, child }))
      .catch((error) => {
        log.warn(`Dock tunnel ${dockId} failed:`, error.message);
        try { peer.close(1011, "Dock tunnel unavailable"); } catch { peer.terminate(); }
      });
  }

  #pairingPayload(extra = {}) {
    return {
      service: "remote-sync",
      version: APP_VERSION,
      api_version: AGENT_API_VERSION,
      node_id: this.config.node_id,
      node_name: this.config.node_name,
      role: this.config.role,
      identifier: this.config.role === "child" ? this.config.pairing_identifier : null,
      ready_to_pair: this.config.role === "child" ? this.config.pairing?.ready_to_pair !== false : false,
      paired_master_id: this.config.pairing?.paired_master_id || null,
      paired_at: this.config.pairing?.paired_at || null,
      ...extra
    };
  }

  async #handle(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        jsonResponse(response, 200, this.#pairingPayload());
        return;
      }

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/proxy/command`) {
        if (!this.#commandAuthorized(request)) {
          jsonResponse(response, 401, { error: "Unauthorized proxy command" }, { "WWW-Authenticate": "Bearer" });
          return;
        }
        const body = await readJson(request);
        const sourceEntityId = String(body.source_entity_id || "").trim();
        const cmdId = String(body.cmd_id || "").trim();
        if (!sourceEntityId || !cmdId) { jsonResponse(response, 400, { error: "source_entity_id and cmd_id are required" }); return; }
        const result = await this.commandCallback({ source_entity_id: sourceEntityId, cmd_id: cmdId, params: body.params || undefined });
        jsonResponse(response, result.success ? 200 : (result.status || 502), result);
        return;
      }

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/activity/state`) {
        if (!this.#authorized(request)) {
          jsonResponse(response, 401, { error: "Unauthorized activity state update" }, { "WWW-Authenticate": "Bearer" });
          return;
        }
        if (this.config.role !== "child") { jsonResponse(response, 409, { error: "Activity state updates are only accepted by child remotes" }); return; }
        if (!this.activityStateCallback) { jsonResponse(response, 501, { error: "Activity state synchronization is unavailable" }); return; }
        const body = await readJson(request);
        const sourceActivityId = String(body.source_activity_id || "").trim();
        const state = String(body.state || "").trim();
        if (!sourceActivityId || !state) { jsonResponse(response, 400, { error: "source_activity_id and state are required" }); return; }
        const result = await this.activityStateCallback({ source_activity_id: sourceActivityId, state });
        jsonResponse(response, result.success ? 200 : (result.status || 422), result);
        return;
      }

      if (!this.#authorized(request)) {
        jsonResponse(response, 401, { error: "Unauthorized", identifier: this.config.pairing_identifier || null }, { "WWW-Authenticate": "Bearer" });
        return;
      }

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/pairing/validate`) {
        if (this.config.role !== "child") { jsonResponse(response, 409, { error: "This Remote Sync instance is not configured as a child" }); return; }
        jsonResponse(response, 200, this.#pairingPayload({ valid: true }));
        return;
      }

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/pairing/claim`) {
        if (this.config.role !== "child") { jsonResponse(response, 409, { error: "This Remote Sync instance is not configured as a child" }); return; }
        const body = await readJson(request);
        const masterId = String(body.master_id || "").trim();
        const masterName = String(body.master_name || "").trim() || masterId;
        if (!masterId) { jsonResponse(response, 400, { error: "master_id is required" }); return; }
        const pairedMasterId = this.config.pairing?.paired_master_id || null;
        const ready = this.config.pairing?.ready_to_pair !== false;
        if (!ready && pairedMasterId && pairedMasterId !== masterId) {
          jsonResponse(response, 409, { error: "This child is already paired with a different master", paired_master_id: pairedMasterId });
          return;
        }
        const pairing = await this.pairingCallback({
          master_id: masterId,
          master_name: masterName,
          master_agent_url: body.master_agent_url || null,
          master_command_token: body.master_command_token || null,
          master_mac: body.master_mac || null,
          master_broadcasts: Array.isArray(body.master_broadcasts) ? body.master_broadcasts : []
        });
        this.config.pairing = pairing;
        this.publisher?.setReady(false);
        jsonResponse(response, 200, this.#pairingPayload({ paired: true }));
        return;
      }

      if (request.method === "GET" && url.pathname === `/v${AGENT_API_VERSION}/status`) {
        jsonResponse(response, 200, this.statusCallback());
        return;
      }

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/snapshots`) {
        if (this.config.role !== "child") { jsonResponse(response, 409, { error: "This Remote Sync instance is not configured as a child" }); return; }
        const payload = await readBody(request);
        const signature = request.headers["x-remote-sync-signature"] || "";
        if (!signature || !verifyHmac(this.config.agent_token, payload, String(signature))) { jsonResponse(response, 401, { error: "Invalid snapshot signature" }); return; }
        const { manifest, resources } = await SnapshotReader.read(payload);
        const report = await this.applyCallback(manifest, resources, {
          master_agent_url: request.headers["x-remote-sync-master-url"] || null,
          master_command_token: request.headers["x-remote-sync-command-token"] || null,
          master_mac: request.headers["x-remote-sync-master-mac"] || null,
          master_broadcasts: String(request.headers["x-remote-sync-master-broadcasts"] || "").split(",").map((item) => item.trim()).filter(Boolean)
        });
        const status = report.restart_required ? 202 : (report.success || report.duplicate ? 200 : 422);
        jsonResponse(response, status, report);
        return;
      }

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/sync`) {
        if (this.config.role !== "master") { jsonResponse(response, 409, { error: "Only a master instance can start synchronization" }); return; }
        const value = await readJson(request);
        jsonResponse(response, 200, await this.syncCallback(value.force !== false));
        return;
      }
      jsonResponse(response, 404, { error: "Not found" });
    } catch (error) {
      log.error("Agent request failed:", error);
      jsonResponse(response, error.statusCode || 400, { error: error.message });
    }
  }
}
