import { AgentServer } from "./agent-server.js";
import { SnapshotApplier } from "./applier.js";
import { CoreClient } from "./core-client.js";
import { CoreEventWatcher } from "./core-ws.js";
import { MappingStore } from "./mapping-store.js";
import { createApplyReport, createStatus, finishReport, redactConfig } from "./models.js";
import { OperationCache } from "./operation-cache.js";
import { SnapshotBuilder } from "./snapshot.js";
import { buildProxyCatalog, ProxyCatalogStore } from "./proxy-catalog.js";
import { defaultPairingUrl, RemoteSyncDiscovery } from "./pairing-mdns.js";
import { hmacSignature, isTransportError, reachableAgentUrl, secureToken, sleep, utcNow } from "./util.js";
import { sendMagicPacket } from "./wol.js";
import { WAKE_RETRY_SCHEDULE_MS, WAKE_TIMEOUT_MS } from "./constants.js";
import { logger } from "./logger.js";
import { bridgeMasterDockTunnel, physicalDockConnection, virtualDockToken, VirtualDockServer } from "./dock-proxy.js";

const log = logger("service");

export class RemoteSyncService {
  constructor(store) {
    this.store = store;
    this.config = null;
    this.client = null;
    this.status = createStatus();
    this.agent = null;
    this.watcher = null;
    this.periodicTimer = null;
    this.initialSyncTimer = null;
    this.syncing = false;
    this.applying = false;
    this.listeners = [];
    this.proxyListeners = [];
    this.proxyStore = new ProxyCatalogStore();
    this.proxyCatalog = this.proxyStore.load();
    this.operationCache = new OperationCache();
    this.mappings = new MappingStore();
    this.discovery = new RemoteSyncDiscovery();
    this.activityRelaySuppressions = new Map();
    this.activityCommandIntents = new Map();
    this.virtualDockServer = null;
    this.masterDockCatalog = new Map();
    this.dockTunnelSessions = new Set();
  }

  addStatusListener(listener) { this.listeners.push(listener); }
  addProxyListener(listener) { this.proxyListeners.push(listener); }
  async load() { const config = this.store.load(); if (config) await this.configure(config); }

  async configure(config) {
    await this.stop();
    this.config = config;
    if (this.config.role === "master") {
      // A master never exposes mirrored child entities. Clear a stale catalog
      // when a previously configured child is switched to the master role.
      this.proxyStore.clear();
      this.proxyCatalog = { schema_version: 2, entities: [], mapping: {}, activation_hash: null };
      this.#notifyProxy();
      let changed = false;
      for (const peer of this.config.peers) {
        if (!peer.command_token) { peer.command_token = secureToken(); changed = true; }
      }
      if (changed) this.store.save(this.config);
    } else {
      this.proxyCatalog = this.proxyStore.load();
      this.#notifyProxy();
    }
    this.discovery.clear();
    this.client = new CoreClient(config.remote);
    this.status = createStatus("starting");
    if (config.role === "child") {
      this.virtualDockServer = new VirtualDockServer(config);
      await this.virtualDockServer.start();
    }
    this.agent = new AgentServer(config, {
      applyCallback: (manifest, resources, context) => this.applyReceived(manifest, resources, context),
      statusCallback: () => this.statusPayload(),
      syncCallback: (force) => this.syncNow(force),
      pairingCallback: (pairing) => this.markPaired(pairing),
      commandCallback: (command) => this.executeProxyCommand(command),
      activityStateCallback: (update) => this.applyActivityState(update),
      dockTunnelCallback: (request) => this.openDockTunnel(request)
    });
    await this.agent.start();
    try {
      const { ready, bad } = await this.client.ready();
      this.status.state = ready
        ? (config.role === "child" && config.pairing?.ready_to_pair !== false ? "ready to pair" : "connected")
        : `degraded: ${JSON.stringify(bad)}`;
    } catch (error) { this.status.state = `unreachable: ${error.message}`; }
    if (config.role === "master") {
      this.watcher = new CoreEventWatcher(config.remote, (events) => this.#configurationEvents(events), {
        activityStateCallback: (event) => this.#broadcastActivityState(event)
      });
      this.watcher.run().catch((error) => log.error("Event watcher stopped:", error));
      if (config.sync.auto_sync) {
        this.#scheduleInitialSync();
        this.#schedulePeriodic();
      }
    }
    this.#notify();
  }

  async stop() {
    clearTimeout(this.periodicTimer); this.periodicTimer = null;
    clearTimeout(this.initialSyncTimer); this.initialSyncTimer = null;
    this.watcher?.stop(); this.watcher = null;
    for (const close of this.dockTunnelSessions) close();
    this.dockTunnelSessions.clear();
    await this.agent?.stop(); this.agent = null;
    await this.virtualDockServer?.stop(); this.virtualDockServer = null;
    this.masterDockCatalog.clear();
    this.activityRelaySuppressions.clear();
    this.activityCommandIntents.clear();
    this.client = null;
  }

  #scheduleInitialSync() {
    clearTimeout(this.initialSyncTimer);
    if (!this.config || this.config.role !== "master" || !this.config.sync.auto_sync) return;
    this.initialSyncTimer = setTimeout(async () => {
      this.initialSyncTimer = null;
      log.info("Starting initial synchronization after master configuration");
      await this.syncNow(true);
    }, 1500);
    this.initialSyncTimer.unref?.();
  }

  #schedulePeriodic() {
    clearTimeout(this.periodicTimer);
    if (!this.config || this.config.role !== "master" || !this.config.sync.auto_sync) return;
    this.periodicTimer = setTimeout(async () => {
      try { await this.syncNow(false); } catch (error) { log.error("Periodic synchronization failed:", error); }
      this.#schedulePeriodic();
    }, this.config.sync.interval_seconds * 1000);
    this.periodicTimer.unref?.();
  }

  async #configurationEvents(events) {
    if (!this.config || this.config.role !== "master" || !this.config.sync.auto_sync) return;
    log.debug("Configuration event batch:", [...events].sort());
    this.status.pending_changes = true;
    this.#notify();
    await this.syncNow(false);
  }

  async #pushActivityState(peer, event) {
    const destination = await this.#resolvePeerUrl(peer, false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${destination.url.replace(/\/$/, "")}/v1/activity/state`, {
        method: "POST",
        headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ""}`);
      }
      return true;
    } finally { clearTimeout(timer); }
  }

  async #broadcastActivityState(event) {
    if (!this.config || this.config.role !== "master" || !this.client) return;
    const sourceActivityId = String(event?.source_activity_id || "").trim();
    if (!sourceActivityId) return;
    let state = typeof event?.state === "string" ? event.state : null;
    let entityType = String(event?.entity_type || "").toLowerCase();
    if (!state || entityType !== "activity") {
      let detail = null;
      try {
        const activityDetail = await this.client.getJson(`/activities/${encodeURIComponent(sourceActivityId)}`, { optionalStatuses: [404] });
        if (activityDetail) {
          detail = activityDetail;
          entityType = "activity";
        } else {
          detail = await this.client.getJson(`/entities/${encodeURIComponent(sourceActivityId)}`, { optionalStatuses: [404] });
        }
      } catch (error) {
        log.debug(`Could not resolve activity event ${sourceActivityId}: ${error.message}`);
      }
      if (!detail) return;
      entityType = String(detail.entity_type || entityType).toLowerCase();
      state = detail.attributes?.state ?? detail.state ?? state;
    }
    if (entityType !== "activity" || !this.#activityActionFromState(state)) return;
    const update = { source_activity_id: sourceActivityId, state: String(state) };
    const peers = this.config.peers.filter((peer) => peer.enabled);
    await Promise.allSettled(peers.map(async (peer) => {
      try { await this.#pushActivityState(peer, update); }
      catch (error) { log.warn(`Could not synchronize activity state ${sourceActivityId} to ${peer.name}: ${error.message}`); }
    }));
  }

  async #initializePeerActivityStates(peer, activities) {
    for (const record of activities || []) {
      const sourceActivityId = String(record?.source_id || "");
      const state = record?.detail?.attributes?.state ?? record?.detail?.state;
      if (!sourceActivityId || typeof state !== "string" || !this.#activityActionFromState(state)) continue;
      try { await this.#pushActivityState(peer, { source_activity_id: sourceActivityId, state }); }
      catch (error) { log.warn(`Could not initialize activity state ${sourceActivityId} on ${peer.name}: ${error.message}`); }
    }
  }

  #activityActionFromState(state) {
    const value = String(state || "").trim().toUpperCase();
    if (value === "ON") return "on";
    if (value === "OFF") return "off";
    return null;
  }

  #activityStateMatches(state, action) {
    return this.#activityActionFromState(state) === action;
  }

  async applyActivityState({ source_activity_id, state }) {
    if (!this.config || this.config.role !== "child" || !this.client) return { success: false, status: 409, error: "This node is not an active child" };
    const sourceActivityId = String(source_activity_id || "").trim();
    const action = this.#activityActionFromState(state);
    if (!sourceActivityId || !action) return { success: false, status: 400, error: "Unsupported activity state" };
    const sourceNode = this.config.pairing?.paired_master_id;
    const targetActivityId = sourceNode ? this.mappings.get(sourceNode, "activity", sourceActivityId) : null;
    if (!targetActivityId) return { success: false, status: 404, error: `No child activity mapping exists for ${sourceActivityId}` };

    const pendingIntent = this.activityCommandIntents.get(sourceActivityId);
    if (pendingIntent) {
      if (Number(pendingIntent.expires_at || 0) <= Date.now()) {
        this.activityCommandIntents.delete(sourceActivityId);
      } else if (pendingIntent.action !== action) {
        log.info(`Ignoring stale master activity ${action.toUpperCase()} state for ${sourceActivityId}; child requested ${pendingIntent.action.toUpperCase()}`);
        return { success: true, changed: false, ignored_stale: true, target_activity_id: targetActivityId, action };
      } else {
        this.activityCommandIntents.delete(sourceActivityId);
      }
    }

    try {
      const current = (await this.client.getJson(`/entities/${encodeURIComponent(targetActivityId)}`, { optionalStatuses: [404] }))
        || (await this.client.getJson(`/activities/${encodeURIComponent(targetActivityId)}`, { optionalStatuses: [404] }));
      const currentState = current?.attributes?.state ?? current?.state;
      if (this.#activityStateMatches(currentState, action)) return { success: true, changed: false, target_activity_id: targetActivityId };
    } catch (error) { log.debug(`Could not read child activity state for ${targetActivityId}: ${error.message}`); }

    const suppressionKey = `${sourceActivityId}|${action}`;
    this.activityRelaySuppressions.set(suppressionKey, Date.now() + 10_000);
    try {
      await this.client.executeEntityCommand(targetActivityId, `activity.${action}`);
      return { success: true, changed: true, target_activity_id: targetActivityId, action };
    } catch (error) {
      this.activityRelaySuppressions.delete(suppressionKey);
      return { success: false, status: error.status || 502, error: error.message, target_activity_id: targetActivityId };
    }
  }

  async forwardActivityCommand(sourceActivityId, action) {
    const source = String(sourceActivityId || "").trim();
    const normalizedAction = String(action || "").trim().toLowerCase();
    if (!source || !["on", "off"].includes(normalizedAction)) return { success: false, status: 400, error: "Invalid activity relay command" };
    const key = `${source}|${normalizedAction}`;
    const expiresAt = Number(this.activityRelaySuppressions.get(key) || 0);
    if (expiresAt > Date.now()) {
      this.activityRelaySuppressions.delete(key);
      return { success: true, suppressed: true, source_entity_id: source, cmd_id: `activity.${normalizedAction}` };
    }
    this.activityRelaySuppressions.delete(key);
    const intent = { action: normalizedAction, expires_at: Date.now() + 360_000 };
    this.activityCommandIntents.set(source, intent);
    const result = await this.forwardProxyCommand(source, `activity.${normalizedAction}`);
    if (!result.success && this.activityCommandIntents.get(source) === intent) this.activityCommandIntents.delete(source);
    return result;
  }

  async syncNow(force = true) {
    if (!this.config || !this.client) return { success: false, error: "Remote Sync is not configured" };
    if (this.config.role !== "master") return { success: false, error: "This node is configured as a child" };
    if (this.syncing) return { success: false, error: "A synchronization is already running" };
    this.syncing = true;
    this.status.state = "building snapshot";
    this.status.last_sync_result = "Collecting master configuration";
    this.#notify();
    try {
      log.info("Building configuration snapshot");
      const snapshot = await new SnapshotBuilder(this.client, this.config).build();
      this.masterDockCatalog = new Map((snapshot.manifest.data.docks || [])
        .map((record) => [String(record?.source_id || record?.detail?.dock_id || record?.detail?.id || ""), record?.detail || {}])
        .filter(([dockId]) => dockId));
      log.info(`Snapshot ${snapshot.manifest.operation_id} built (${snapshot.payload.length} bytes, hash ${snapshot.manifest.content_hash.slice(0, 12)})`);
      if (!force && snapshot.manifest.content_hash === this.status.last_snapshot_hash) {
        Object.assign(this.status, { pending_changes: false, state: "connected", last_sync_result: "No configuration changes" });
        this.#notify();
        return { success: true, changed: false, content_hash: snapshot.manifest.content_hash };
      }
      const peers = this.config.peers.filter((peer) => peer.enabled);
      const peerResults = {};
      let success = true;
      for (const peer of peers) {
        log.info(`Pushing snapshot to ${peer.name} (${peer.identifier || peer.url || peer.peer_id})`);
        const result = await this.#pushSnapshot(peer, snapshot.payload);
        if (result.success) {
          log.info(`Child ${peer.name} applied snapshot successfully`);
          await this.#initializePeerActivityStates(peer, snapshot.manifest.data.activities || []);
        } else log.error(`Child ${peer.name} failed to apply snapshot:`, result.error || result.report || result);
        peerResults[peer.peer_id] = result;
        success &&= Boolean(result.success);
      }
      this.status.last_sync_at = utcNow();
      this.status.peer_results = peerResults;
      if (!peers.length) { this.status.last_sync_result = "Snapshot built; no child peers configured"; success = true; }
      else if (success) this.status.last_sync_result = `Synchronized ${peers.length} child remote(s)`;
      else {
        const failed = peers.filter((peer) => !peerResults[peer.peer_id]?.success);
        const details = failed.map((peer) => {
          const result = peerResults[peer.peer_id] || {};
          const reportErrors = Array.isArray(result.report?.errors) ? result.report.errors.filter(Boolean) : [];
          const reason = result.error || reportErrors[0] || result.report?.error || `HTTP ${result.status || "error"}`;
          return `${peer.name}: ${reason}`;
        });
        this.status.last_sync_result = details.join(" | ").slice(0, 1000) || `${failed.length} child remote(s) failed`;
      }
      if (success) {
        this.status.last_snapshot_hash = snapshot.manifest.content_hash;
        this.status.pending_changes = false;
        this.status.successful_syncs += 1;
        this.status.state = "connected";
      } else {
        this.status.pending_changes = true;
        this.status.failed_syncs += 1;
        this.status.state = "error";
      }
      this.#notify();
      return { success, changed: true, operation_id: snapshot.manifest.operation_id, content_hash: snapshot.manifest.content_hash, peers: peerResults, warnings: snapshot.manifest.warnings };
    } catch (error) {
      log.error("Synchronization failed:", error);
      this.status.failed_syncs += 1;
      this.status.state = "error";
      this.status.last_sync_at = utcNow();
      this.status.last_sync_result = error.message;
      this.#notify();
      return { success: false, error: error.message };
    } finally { this.syncing = false; }
  }

  async #resolvePeerUrl(peer, force = false) {
    if (peer.identifier) {
      try {
        const result = await this.discovery.resolve(peer.identifier, { force });
        return { url: result.url, discovered: true, hostname: result.hostname };
      } catch (error) {
        if (!peer.url) throw error;
        log.warn(`mDNS resolution failed for ${peer.identifier}; using saved fallback URL ${peer.url}:`, error.message);
      }
    }
    if (peer.url) return { url: peer.url, discovered: false, hostname: null };
    throw Object.assign(new Error(`Child ${peer.name} has no pairing identifier or URL`), { code: "ENOTFOUND" });
  }

  async #postSnapshot(peer, payload, { forceDiscovery = false } = {}) {
    const destination = await this.#resolvePeerUrl(peer, forceDiscovery);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
      log.info(`Sending snapshot to ${destination.url}`);
      const response = await fetch(`${destination.url.replace(/\/$/, "")}/v1/snapshots`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${peer.token}`,
          "Content-Type": "application/gzip",
          "X-Remote-Sync-Signature": hmacSignature(peer.token, payload),
          "X-Remote-Sync-Master-Url": reachableAgentUrl(this.config) || "",
          "X-Remote-Sync-Command-Token": peer.command_token || "",
          "X-Remote-Sync-Master-Mac": this.config.remote?.mac || "",
          "X-Remote-Sync-Master-Broadcasts": (this.config.remote?.broadcasts || []).join(",")
        },
        body: payload,
        signal: controller.signal
      });
      const text = await response.text();
      let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 4096) }; }
      const restartRequired = response.status === 202 && body.restart_required === true;
      const success = [200, 201].includes(response.status) && body.success !== false;
      if (!success && !restartRequired) log.warn(`Snapshot endpoint ${destination.url} returned HTTP ${response.status}:`, body);
      return {
        success,
        restart_required: restartRequired,
        status: response.status,
        report: body,
        destination: destination.url,
        discovered: destination.discovered,
        hostname: destination.hostname
      };
    } finally { clearTimeout(timer); }
  }

  async #waitForRestartAndResend(peer, payload, initialResult) {
    log.info(`Child ${peer.name} accepted a new proxy catalog and is restarting its integration driver`);
    const deadline = Date.now() + 90_000;
    let lastResult = initialResult;
    let lastError = null;
    let attempt = 0;
    while (Date.now() < deadline) {
      await sleep(Math.min(1500 + attempt * 500, 5000));
      attempt += 1;
      if (peer.identifier) this.discovery.clear(peer.identifier);
      try {
        const result = await this.#postSnapshot(peer, payload, { forceDiscovery: true });
        lastResult = result;
        if (result.success) return { ...result, restarted: true };
        if (result.restart_required) continue;
        if (result.status === 422 && Array.isArray(result.report?.errors) && result.report.errors.includes("A snapshot is already being applied")) continue;
        return { ...result, restarted: true };
      } catch (error) {
        lastError = error;
        if (!isTransportError(error)) return { success: false, error: error.message, restarted: true };
      }
    }
    return {
      success: false,
      error: lastError?.message || lastResult?.report?.error || "Child did not return after activating its proxy catalog",
      report: lastResult?.report,
      restarted: true
    };
  }

  async #pushSnapshot(peer, payload) {
    try {
      const result = await this.#postSnapshot(peer, payload);
      if (result.restart_required) return this.#waitForRestartAndResend(peer, payload, result);
      return result;
    } catch (error) {
      if (!isTransportError(error)) return { success: false, error: error.message, wowlan_sent: false };
      if (peer.identifier) this.discovery.clear(peer.identifier);

      let wowlanSent = false;
      if (peer.mac) {
        await sendMagicPacket(peer.mac, peer.broadcasts);
        wowlanSent = true;
      } else {
        try {
          const result = await this.#postSnapshot(peer, payload, { forceDiscovery: true });
          return result.restart_required
            ? { ...(await this.#waitForRestartAndResend(peer, payload, result)), wowlan_sent: false }
            : { ...result, wowlan_sent: false };
        } catch (retryError) { return { success: false, error: retryError.message, wowlan_sent: false }; }
      }

      const deadline = Date.now() + WAKE_TIMEOUT_MS;
      let index = 0;
      let lastError = error;
      while (Date.now() < deadline) {
        await sleep(WAKE_RETRY_SCHEDULE_MS[Math.min(index++, WAKE_RETRY_SCHEDULE_MS.length - 1)]);
        try {
          const result = await this.#postSnapshot(peer, payload, { forceDiscovery: true });
          const finalResult = result.restart_required ? await this.#waitForRestartAndResend(peer, payload, result) : result;
          return { ...finalResult, wowlan_sent: wowlanSent };
        } catch (retryError) {
          if (!isTransportError(retryError)) return { success: false, error: retryError.message, wowlan_sent: wowlanSent };
          lastError = retryError;
          if (peer.identifier) this.discovery.clear(peer.identifier);
        }
      }
      return { success: false, error: lastError.message, wowlan_sent: wowlanSent };
    }
  }

  async applyReceived(manifest, resources, masterContext = {}) {
    if (!this.config || !this.client) return finishReport(Object.assign(createApplyReport(manifest.operation_id), { errors: ["Remote Sync is not configured"] }), false);
    if (this.applying) return finishReport(Object.assign(createApplyReport(manifest.operation_id), { errors: ["A snapshot is already being applied"] }), false);
    this.applying = true;
    this.status.state = "building proxy catalog";
    this.#notify();
    try {
      if (this.config.role === "child") {
        const pairing = this.config.pairing || {};
        const updates = {
          master_agent_url: masterContext.master_agent_url || pairing.master_agent_url || null,
          master_command_token: masterContext.master_command_token || pairing.master_command_token || null,
          master_mac: masterContext.master_mac || pairing.master_mac || null,
          master_broadcasts: masterContext.master_broadcasts?.length ? masterContext.master_broadcasts : (pairing.master_broadcasts || [])
        };
        this.config.pairing = { ...pairing, ...updates };
        this.store.save(this.config);
      }
      if (this.config.role === "child" && manifest.sections.includes("docks")) {
        this.virtualDockServer?.setDocks(manifest.source_node_id, manifest.data.docks || []);
      }
      const previousProxyCatalog = this.proxyCatalog;
      const nextProxyCatalog = buildProxyCatalog(manifest, previousProxyCatalog);
      const activationChanged = previousProxyCatalog?.activation_hash !== nextProxyCatalog.activation_hash;
      this.proxyCatalog = nextProxyCatalog;
      this.proxyStore.save(this.proxyCatalog);
      this.#notifyProxy();

      if (activationChanged) {
        log.info(`Proxy catalog changed (${nextProxyCatalog.entities.length} entities); refreshing it through the Core WebSocket API`);
      }


      this.status.state = "applying proxy configuration";
      this.#notify();
      const report = await new SnapshotApplier(this.client, this.config, this.operationCache, this.mappings).apply(manifest, resources, this.proxyCatalog, previousProxyCatalog);
      this.status.last_sync_at = report.finished_at;
      if (report.success) this.status.last_snapshot_hash = manifest.content_hash;
      this.status.last_sync_result = report.success ? `Applied snapshot from ${manifest.source_name}` : report.errors.join("; ") || "Snapshot apply failed";
      this.status.state = report.success ? "connected" : "error";
      if (report.success) this.status.successful_syncs += 1; else this.status.failed_syncs += 1;
      this.#notify();
      return report;
    } finally { this.applying = false; }
  }

  async markPaired({ master_id, master_name, master_agent_url = null, master_command_token = null, master_mac = null, master_broadcasts = [] }) {
    if (!this.config || this.config.role !== "child") throw new Error("Only a child can be paired");
    const pairing = {
      ready_to_pair: false,
      paired_master_id: String(master_id),
      paired_master_name: String(master_name || master_id),
      paired_at: utcNow(),
      master_agent_url: master_agent_url ? String(master_agent_url).replace(/\/$/, "") : null,
      master_command_token: master_command_token ? String(master_command_token) : null,
      master_mac: master_mac ? String(master_mac) : null,
      master_broadcasts: Array.isArray(master_broadcasts) ? master_broadcasts.map(String) : []
    };
    this.config.pairing = pairing;
    this.store.save(this.config);
    this.status.state = "paired";
    this.status.last_sync_result = `Paired with ${pairing.paired_master_name}`;
    this.#notify();
    return pairing;
  }

  async #dockDetail(sourceDockId) {
    let detail = this.masterDockCatalog.get(sourceDockId) || null;
    if (this.client && typeof this.client.coreMessage === "function") {
      try {
        const response = await this.client.coreMessage("get_dock", { dock_id: sourceDockId }, 30_000);
        const live = response?.dock && typeof response.dock === "object" ? response.dock : response;
        if (live && typeof live === "object") {
          detail = { ...(detail || {}), ...live };
          this.masterDockCatalog.set(sourceDockId, detail);
        }
      } catch (error) {
        if (!detail) throw error;
        log.debug(`Could not refresh Dock ${sourceDockId} before opening tunnel: ${error.message}`);
      }
    }
    return detail;
  }

  async openDockTunnel({ downstream, dock_id, child }) {
    if (!this.config || this.config.role !== "master" || !this.client) throw new Error("This node is not an active master");
    const sourceDockId = String(dock_id || "").trim();
    if (!sourceDockId) throw new Error("dock_id is required");
    const detail = await this.#dockDetail(sourceDockId);
    if (!detail) throw new Error(`Dock ${sourceDockId} is not configured on the master`);
    const configuredToken = this.config.physical_docks?.tokens?.[sourceDockId]
      || this.config.physical_docks?.default_token
      || null;
    const physical = physicalDockConnection(detail, { dockId: sourceDockId, token: configuredToken });
    const expectedVirtualToken = virtualDockToken(child.token, this.config.node_id, sourceDockId);
    let close = null;
    close = await bridgeMasterDockTunnel({
      downstream,
      physicalUrl: physical.url,
      physicalToken: physical.token,
      virtualToken: expectedVirtualToken
    });
    const trackedClose = () => {
      this.dockTunnelSessions.delete(trackedClose);
      close?.();
    };
    this.dockTunnelSessions.add(trackedClose);
    downstream.once("close", () => this.dockTunnelSessions.delete(trackedClose));
    log.info(`Opened Dock tunnel ${sourceDockId} for ${child.name || child.peer_id}`);
  }

  async executeProxyCommand({ source_entity_id, cmd_id, params }) {
    if (!this.config || this.config.role !== "master" || !this.client) return { success: false, status: 409, error: "This node is not an active master" };
    try {
      const response = await this.client.executeEntityCommand(source_entity_id, cmd_id, params);
      let entity = null;
      try {
        await sleep(100);
        entity = await this.client.getJson(`/entities/${encodeURIComponent(source_entity_id)}`, { optionalStatuses: [404] });
      } catch (error) { log.debug(`Could not refresh state after proxy command: ${error.message}`); }
      return { success: true, status: 200, source_entity_id, cmd_id, response, entity };
    } catch (error) {
      log.warn(`Proxy command failed for ${source_entity_id}:${cmd_id}:`, error.message);
      return { success: false, status: error.status || 502, error: error.message, source_entity_id, cmd_id };
    }
  }

  async #postProxyCommand(url, token, sourceEntityId, cmdId, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${String(url).replace(/\/$/, "")}/v1/proxy/command`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source_entity_id: sourceEntityId, cmd_id: cmdId, params }),
        signal: controller.signal
      });
      const text = await response.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
      return { ...body, success: response.ok && body.success !== false, status: response.status };
    } finally { clearTimeout(timer); }
  }

  async forwardProxyCommand(sourceEntityId, cmdId, params = undefined) {
    if (!this.config || this.config.role !== "child") return { success: false, status: 409, error: "Proxy commands are only available on child remotes" };
    const pairing = this.config.pairing || {};
    if (!pairing.master_agent_url || !pairing.master_command_token) return { success: false, status: 503, error: "Master command endpoint is not configured; run a synchronization from the master" };
    try {
      const result = await this.#postProxyCommand(pairing.master_agent_url, pairing.master_command_token, sourceEntityId, cmdId, params);
      if (result.success) this.#updateProxyState(sourceEntityId, result.entity?.attributes);
      return result;
    } catch (error) {
      if (!isTransportError(error) || !pairing.master_mac) return { success: false, status: 503, error: error.message };
      await sendMagicPacket(pairing.master_mac, pairing.master_broadcasts || []);
      let lastError = error;
      const deadline = Date.now() + WAKE_TIMEOUT_MS;
      let index = 0;
      while (Date.now() < deadline) {
        await sleep(WAKE_RETRY_SCHEDULE_MS[Math.min(index++, WAKE_RETRY_SCHEDULE_MS.length - 1)]);
        try {
          const result = await this.#postProxyCommand(pairing.master_agent_url, pairing.master_command_token, sourceEntityId, cmdId, params);
          if (result.success) this.#updateProxyState(sourceEntityId, result.entity?.attributes);
          return result;
        } catch (retryError) { lastError = retryError; if (!isTransportError(retryError)) break; }
      }
      return { success: false, status: 503, error: lastError.message };
    }
  }

  #updateProxyState(sourceEntityId, attributes) {
    if (!attributes || typeof attributes !== "object") return;
    const descriptor = this.proxyCatalog?.entities?.find((item) => item.source_entity_id === sourceEntityId);
    if (!descriptor) return;
    descriptor.attributes = { ...descriptor.attributes, ...attributes };
    this.proxyCatalog.updated_at = utcNow();
    this.proxyStore.save(this.proxyCatalog);
    this.#notifyProxy();
  }

  async reconcile() {
    if (!this.config || !this.client) return { success: false, error: "Remote Sync is not configured" };
    if (this.config.role === "master") return this.syncNow(true);
    try {
      const { ready, bad } = await this.client.ready();
      this.status.state = ready ? "connected" : `degraded: ${JSON.stringify(bad)}`;
      this.#notify();
      return { success: ready, bad_integration_states: bad };
    } catch (error) { this.status.state = `unreachable: ${error.message}`; this.#notify(); return { success: false, error: error.message }; }
  }

  statusPayload() {
    return {
      configured: Boolean(this.config),
      config: redactConfig(this.config),
      status: structuredClone(this.status),
      agent_url: this.agentUrl,
      virtual_docks: this.virtualDockServer?.status() || null,
      dock_tunnels: this.dockTunnelSessions.size
    };
  }
  get agentUrl() {
    if (!this.config) return null;
    if (this.config.agent_public_url) return this.config.agent_public_url;
    if (this.config.role === "child" && this.config.pairing_identifier) return defaultPairingUrl(this.config.pairing_identifier, this.config.agent_port);
    return reachableAgentUrl(this.config) || `http://${this.config.remote.host}:${this.config.agent_port}`;
  }
  #notifyProxy() { for (const listener of this.proxyListeners) { try { listener(this.proxyCatalog); } catch (error) { log.error("Proxy listener failed:", error); } } }
  #notify() { for (const listener of this.listeners) { try { listener(this.status, this.config); } catch (error) { log.error("Status listener failed:", error); } } }
}
