import http from "node:http";
import { AGENT_API_VERSION, MAX_SNAPSHOT_BYTES, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, SNAPSHOT_SCHEMA_VERSION } from "../shared/constants.js";
import { RemoteSyncMdnsPublisher } from "../pairing/mdns.js";
import { protocolDescriptor } from "../protocol/index.js";
import { SnapshotReader } from "../protocol/snapshot.js";
import { verifyHmac } from "../shared/util.js";
import { acceptWebSocketUpgrade, rejectWebSocketUpgrade } from "../transport/websocket.js";
import { logger } from "../shared/logger.js";

const log = logger("agent");

// -----------------------------------------------------------------------------
// HTTP helpers
// -----------------------------------------------------------------------------

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

function routeSatelliteAction(pathname) {
  const match = pathname.match(/^\/v\d+\/satellites\/([^/]+)\/actions\/([^/]+)$/);
  return match ? { peerId: decodeURIComponent(match[1]), action: decodeURIComponent(match[2]) } : null;
}

// -----------------------------------------------------------------------------
// Agent server
// -----------------------------------------------------------------------------

export class AgentServer {
  constructor(config, {
    applyCallback,
    previewCallback = null,
    statusCallback,
    syncCallback,
    pairingCallback,
    credentialCallback = null,
    unpairCallback = null,
    satelliteListCallback = null,
    satelliteActionCallback = null,
    commandCallback,
    activityStateCallback = null,
    dockTunnelCallback = null
  }) {
    this.config = config;
    this.applyCallback = applyCallback;
    this.previewCallback = previewCallback;
    this.statusCallback = statusCallback;
    this.syncCallback = syncCallback;
    this.pairingCallback = pairingCallback;
    this.credentialCallback = credentialCallback;
    this.unpairCallback = unpairCallback;
    this.satelliteListCallback = satelliteListCallback;
    this.satelliteActionCallback = satelliteActionCallback;
    this.commandCallback = commandCallback;
    this.activityStateCallback = activityStateCallback;
    this.dockTunnelCallback = dockTunnelCallback;
    this.server = null;
    this.publisher = null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

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
        version: protocolDescriptor().version,
        nodeId: this.config.node_id,
        ready: this.config.pairing?.ready_to_pair !== false,
        interfaceValue: process.env.UC_MDNS_ADDRESS || process.env.UC_INTEGRATION_INTERFACE || null,
        mac: this.config.remote?.mac || null,
        broadcasts: this.config.remote?.broadcasts || [],
        protocol: protocolDescriptor()
      });
      try { await this.publisher.start(); }
      catch (error) {
        log.warn("Satellite pairing mDNS advertisement failed:", error.message);
        this.publisher.close();
        this.publisher = null;
      }
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

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // WebSocket tunnels
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Public and authenticated payloads
  // -------------------------------------------------------------------------

  #capabilitiesPayload() {
    return protocolDescriptor({
      node_id: this.config.node_id,
      node_name: this.config.node_name,
      role: this.config.role,
      identifier: this.config.role === "child" ? this.config.pairing_identifier : null,
      ready_to_pair: this.config.role === "child" ? this.config.pairing?.ready_to_pair !== false : false
    });
  }

  #pairingPayload(extra = {}) {
    return {
      ...this.#capabilitiesPayload(),
      paired_master_id: this.config.pairing?.paired_master_id || null,
      paired_at: this.config.pairing?.paired_at || null,
      mac: this.config.remote?.mac || null,
      broadcasts: this.config.remote?.broadcasts || [],
      network_interface: this.config.remote?.interface || null,
      network_source: this.config.remote?.network_source || null,
      ...extra
    };
  }

  #healthPayload() {
    return { status: "ok", version: protocolDescriptor().version };
  }

  // -------------------------------------------------------------------------
  // Request routing
  // -------------------------------------------------------------------------

  async #handle(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && ["/health", "/healthz"].includes(url.pathname)) {
        jsonResponse(response, 200, this.#healthPayload());
        return;
      }

      if (request.method === "GET" && url.pathname === `/v${AGENT_API_VERSION}/capabilities`) {
        jsonResponse(response, 200, this.#capabilitiesPayload());
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
        if (!sourceEntityId || !cmdId) {
          jsonResponse(response, 400, { error: "source_entity_id and cmd_id are required" });
          return;
        }
        const result = await this.commandCallback({ source_entity_id: sourceEntityId, cmd_id: cmdId, params: body.params || undefined });
        jsonResponse(response, result.success ? 200 : (result.status || 502), result);
        return;
      }

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/activity/state`) {
        if (!this.#authorized(request)) {
          jsonResponse(response, 401, { error: "Unauthorized activity state update" }, { "WWW-Authenticate": "Bearer" });
          return;
        }
        if (this.config.role !== "child") {
          jsonResponse(response, 409, { error: "Activity state updates are only accepted by satellite remotes" });
          return;
        }
        if (!this.activityStateCallback) {
          jsonResponse(response, 501, { error: "Activity state synchronization is unavailable" });
          return;
        }
        const body = await readJson(request);
        const sourceActivityId = String(body.source_activity_id || "").trim();
        const state = String(body.state || "").trim();
        if (!sourceActivityId || !state) {
          jsonResponse(response, 400, { error: "source_activity_id and state are required" });
          return;
        }
        const result = await this.activityStateCallback({ source_activity_id: sourceActivityId, state });
        jsonResponse(response, result.success ? 200 : (result.status || 422), result);
        return;
      }

      if (!this.#authorized(request)) {
        jsonResponse(response, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
        return;
      }

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/pairing/validate`) {
        if (this.config.role !== "child") {
          jsonResponse(response, 409, { error: "This Remote Sync instance is not configured as a satellite" });
          return;
        }
        jsonResponse(response, 200, this.#pairingPayload({ valid: true }));
        return;
      }

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/pairing/claim`) {
        if (this.config.role !== "child") {
          jsonResponse(response, 409, { error: "This Remote Sync instance is not configured as a satellite" });
          return;
        }
        const body = await readJson(request);
        const masterId = String(body.master_id || "").trim();
        const masterName = String(body.master_name || "").trim() || masterId;
        if (!masterId) {
          jsonResponse(response, 400, { error: "master_id is required" });
          return;
        }
        const pairedMasterId = this.config.pairing?.paired_master_id || null;
        const ready = this.config.pairing?.ready_to_pair !== false;
        if (!ready && pairedMasterId && pairedMasterId !== masterId) {
          jsonResponse(response, 409, { error: "This satellite is already paired with a different primary", paired_master_id: pairedMasterId });
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

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/pairing/rotate`) {
        if (this.config.role !== "child" || !this.credentialCallback) {
          jsonResponse(response, 501, { error: "Credential rotation is unavailable" });
          return;
        }
        const body = await readJson(request);
        if (String(body.master_id || "") !== String(this.config.pairing?.paired_master_id || "")) {
          jsonResponse(response, 409, { error: "Credential rotation requested by a different primary" });
          return;
        }
        const result = await this.credentialCallback(body);
        jsonResponse(response, 200, this.#pairingPayload({ rotated: true, agent_token: result.agent_token }));
        return;
      }

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/pairing/unpair`) {
        if (this.config.role !== "child" || !this.unpairCallback) {
          jsonResponse(response, 501, { error: "Unpairing is unavailable" });
          return;
        }
        const body = await readJson(request);
        if (String(body.master_id || "") !== String(this.config.pairing?.paired_master_id || "")) {
          jsonResponse(response, 409, { error: "Unpairing requested by a different primary" });
          return;
        }
        await this.unpairCallback(body);
        this.publisher?.setReady(true);
        jsonResponse(response, 200, this.#pairingPayload({ unpaired: true }));
        return;
      }

      if (request.method === "GET" && url.pathname === `/v${AGENT_API_VERSION}/status`) {
        jsonResponse(response, 200, { ...protocolDescriptor(), ...this.statusCallback() });
        return;
      }

      if (request.method === "GET" && url.pathname === `/v${AGENT_API_VERSION}/satellites`) {
        if (this.config.role !== "master" || !this.satelliteListCallback) {
          jsonResponse(response, 409, { error: "Satellite management is only available on a primary" });
          return;
        }
        const refresh = url.searchParams.get("refresh") === "true";
        jsonResponse(response, 200, { satellites: await this.satelliteListCallback(refresh) });
        return;
      }

      const satelliteAction = request.method === "POST" ? routeSatelliteAction(url.pathname) : null;
      if (satelliteAction) {
        if (this.config.role !== "master" || !this.satelliteActionCallback) {
          jsonResponse(response, 409, { error: "Satellite management is only available on a primary" });
          return;
        }
        jsonResponse(response, 200, await this.satelliteActionCallback(satelliteAction.peerId, satelliteAction.action));
        return;
      }

      if (request.method === "POST" && [
        `/v${AGENT_API_VERSION}/snapshots`,
        `/v${AGENT_API_VERSION}/snapshots/preview`
      ].includes(url.pathname)) {
        if (this.config.role !== "child") {
          jsonResponse(response, 409, { error: "This Remote Sync instance is not configured as a satellite" });
          return;
        }
        const requestProtocol = Number(request.headers["x-remote-sync-protocol"] || MIN_PROTOCOL_VERSION);
        if (!Number.isInteger(requestProtocol) || requestProtocol < MIN_PROTOCOL_VERSION || requestProtocol > PROTOCOL_VERSION) {
          jsonResponse(response, 409, { error: `Unsupported Remote Sync protocol ${requestProtocol}; supported range is ${MIN_PROTOCOL_VERSION}-${PROTOCOL_VERSION}` });
          return;
        }
        const requestSchema = Number(request.headers["x-remote-sync-snapshot-schema"] || 4);
        if (!Number.isInteger(requestSchema) || ![4, 5, SNAPSHOT_SCHEMA_VERSION].includes(requestSchema)) {
          jsonResponse(response, 409, { error: `Unsupported snapshot schema ${requestSchema}` });
          return;
        }
        const payload = await readBody(request);
        const signature = request.headers["x-remote-sync-signature"] || "";
        if (!signature || !verifyHmac(this.config.agent_token, payload, String(signature))) {
          jsonResponse(response, 401, { error: "Invalid snapshot signature" });
          return;
        }
        const { manifest, resources } = await SnapshotReader.read(payload);
        const context = {
          master_agent_url: request.headers["x-remote-sync-master-url"] || null,
          master_command_token: request.headers["x-remote-sync-command-token"] || null,
          master_mac: request.headers["x-remote-sync-master-mac"] || null,
          master_broadcasts: String(request.headers["x-remote-sync-master-broadcasts"] || "").split(",").map((item) => item.trim()).filter(Boolean)
        };
        if (url.pathname.endsWith("/preview")) {
          if (!this.previewCallback) {
            jsonResponse(response, 501, { error: "Synchronization preview is unavailable" });
            return;
          }
          jsonResponse(response, 200, await this.previewCallback(manifest, resources, context));
          return;
        }
        const report = await this.applyCallback(manifest, resources, context);
        const status = report.restart_required ? 202 : (report.success || report.duplicate ? 200 : 422);
        jsonResponse(response, status, report);
        return;
      }

      if (request.method === "POST" && url.pathname === `/v${AGENT_API_VERSION}/sync`) {
        if (this.config.role !== "master") {
          jsonResponse(response, 409, { error: "Only a primary instance can start synchronization" });
          return;
        }
        const value = await readJson(request);
        jsonResponse(response, 200, await this.syncCallback(value.force !== false, { dryRun: value.dry_run === true, peerId: value.peer_id || null }));
        return;
      }

      jsonResponse(response, 404, { error: "Not found" });
    } catch (error) {
      log.error("Agent request failed:", error);
      jsonResponse(response, error.statusCode || error.status || 400, { error: error.message, details: error.details || undefined });
    }
  }
}
