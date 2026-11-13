import { monitorEventLoopDelay } from "node:perf_hooks";
import { AgentServer } from "../agent/server.js";
import { SnapshotApplier } from "../apply/index.js";
import { CoreApiError, CoreClient } from "../core/client.js";
import { CoreEventWatcher } from "../core/events.js";
import { MappingStore } from "../storage/mappings.js";
import { createApplyReport, createStatus, finishReport, incrementReport, redactConfig } from "../shared/models.js";
import { OperationCache } from "../storage/operations.js";
import { buildProxyCatalog, ProxyCatalogStore } from "../proxy/catalog.js";
import { defaultPairingUrl, generatePairingIdentifier, normalizePairingIdentifier, RemoteSyncDiscovery } from "../pairing/mdns.js";
import { canonicalJson, isTransportError, reachableAgentUrl, secureToken, sha256Bytes, sleep, utcNow } from "../shared/util.js";
import { stableConfiguration } from "../protocol/snapshot.js";
import { PeerAgentClient } from "./peer-agent-client.js";
import { sendMagicPacket } from "../network/wol.js";
import { FULL_AUDIT_INTERVAL_MS, MAX_AUTO_SYNC_RSS_BYTES, MAX_EVENT_LOOP_DELAY_MS, MIN_EVENT_SYNC_INTERVAL_MS, PEER_RETRY_BACKOFF_MS, PERIODIC_JITTER_RATIO, WAKE_RETRY_SCHEDULE_MS, WAKE_TIMEOUT_MS } from "../shared/constants.js";
import { logger } from "../shared/logger.js";
import { bridgeMasterDockTunnel, physicalDockConnection, virtualDockToken, VirtualDockServer } from "../dock/proxy.js";
import { ConfigurationError } from "../config/store.js";
import { buildApplyPreview } from "../apply/preview.js";
import { SatellitePurger } from "../apply/purge.js";
import { SatelliteManager } from "./satellite-manager.js";
import { SyncCoordinator } from "./sync-coordinator.js";
import { ActivitySyncManager } from "./activity-sync.js";
import { proxyAttributes, ProxyStateRelay } from "./state-relay.js";
import { DriftGuard } from "./drift-guard.js";
import { LinkHub } from "../link/hub.js";
import { LinkClient } from "../link/client.js";
import { HardwareAdapter, readHardwareProfile } from "../apply/hardware.js";
import { applyDeviceSettings } from "../apply/settings.js";
import { SETTINGS_CATEGORIES, extractSettings, normalizeSettingsCategories, settingsFingerprint } from "../settings/catalog.js";
import { provisionSatelliteByPin, revokeManagementKey } from "./satellite-provisioner.js";
import { inspectManualSatellite } from "../setup/manual-satellite.js";
import { networkOverrides, physicalDockTokens } from "../setup/common.js";
import { detectRemoteNetworkIdentity } from "../network/identity.js";
import { isPairingIdentifier } from "../pairing/config.js";
import { createUiHandler } from "../web/server.js";
import { APP_VERSION, DEFAULT_SECTIONS, SUPPORTED_SECTIONS } from "../shared/constants.js";

const log = logger("service");
const DRIFT_RESYNC_INTERVAL_MS = 5 * 60_000;
// Live states are written to flash at most this often (the catalog can be around a megabyte).
const PROXY_STATE_SAVE_INTERVAL_MS = 5 * 60_000;
const MIN_PEER_SYNC_INTERVAL_MS = 5 * 60_000;
const FAILED_PEER_SYNC_QUIET_MS = 30 * 60_000;
const SATELLITE_EVENT_CHANNELS = ["configuration", "activity_groups", "profiles", "entity_activity", "entity_macro"];

// Command ids reach the Primary in two spellings: qualified ("light.on", "activity.on") from Remote Sync itself and
// short ("on") from the Satellite's Integration API. The Core REST API takes the qualified form; the short form is
// kept as a fallback for Cores that accept it.
// Converts the age of an action reported by a Satellite into this node's clock.
// What makes up an activity group's configuration (not the state of its activities).
export function groupFingerprint(group) {
  const members = Array.isArray(group?.activity_ids) ? group.activity_ids
    : (Array.isArray(group?.activities) ? group.activities.map((item) => (typeof item === "string" ? item : item?.entity_id)) : []);
  return sha256Bytes(canonicalJson(stableConfiguration({ name: group?.name ?? null, icon: group?.icon ?? null, description: group?.description ?? null, options: group?.options ?? null, members: members.filter(Boolean).map(String) })));
}

export function ageToTime(ageMs) {
  const age = Number(ageMs);
  return Number.isFinite(age) && age >= 0 ? Date.now() - age : null;
}

export function proxyCommandCandidates(cmdId, entityType = null) {
  const command = String(cmdId || "").trim();
  const type = String(entityType || "").trim().toLowerCase();
  if (!command || command.includes(".") || !/^[a-z_]+$/.test(type)) return [command];
  return [`${type}.${command}`, command];
}

// -----------------------------------------------------------------------------
// Remote Sync service
// -----------------------------------------------------------------------------

export class RemoteSyncService {
  constructor(store) {
    this.store = store;
    this.config = null;
    this.client = null;
    this.status = createStatus();
    this.agent = null;
    this.watcher = null;
    this.watcherTask = null;
    this.retryTimers = new Map();
    this.lastFullAuditAt = 0;
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 }); this.eventLoopDelay.enable();
    this.periodicTimer = null;
    this.initialSyncTimer = null;
    this.eventSyncTimer = null;
    this.lastSyncCompletedAt = 0;
    this.trailingSyncRequested = false;
    this.configurationRevision = 0;
    this.pendingConfigurationEvents = new Set();
    this.syncing = false;
    this.applying = false;
    this.listeners = [];
    this.proxyListeners = [];
    this.proxyStore = new ProxyCatalogStore();
    this.proxyCatalog = this.proxyStore.load();
    this.operationCache = new OperationCache();
    this.mappings = new MappingStore();
    this.discovery = new RemoteSyncDiscovery();
    this.virtualDockServer = null;
    this.masterDockCatalog = new Map();
    this.dockTunnelSessions = new Set();
    this.remoteInfo = null;
    this.provisioning = new Map();
    this.uiHandler = createUiHandler(this);
    this.syncCoordinator = new SyncCoordinator({
      getConfig: () => this.config,
      getClient: () => this.client,
      getStatus: () => this.status,
      discovery: this.discovery,
      setDockCatalog: (catalog) => { this.masterDockCatalog = catalog; },
      initializeActivityStates: async (peer, activities) => {
        await this.activitySync.initialize(peer, activities);
        await this.stateRelay.initialize(peer);
      },
      onSnapshotBuilt: (manifest) => {
        this.stateRelay.setSnapshot(manifest);
        this.activitySync.setActivities(manifest?.data?.activities);
        if (manifest?.data?.settings) this.settingsFingerprint = settingsFingerprint(manifest.data.settings);
        for (const group of manifest?.data?.activity_groups || []) if (group?.group_id) this.groupFingerprints.set(String(group.group_id), groupFingerprint(group));
      }
    });
    this.linkHub = null;
    this.link = null;
    this.driftGuard = null;
    this.peerSyncTimers = new Map();
    this.driftSyncAt = new Map();
    this.groupFingerprints = new Map();
    this.peerSyncAt = new Map();
    this.hardwareProfile = null;
    this.stateRelay = new ProxyStateRelay({
      getConfig: () => this.config,
      getClient: () => this.client,
      resolvePeerUrl: (peer, force) => this.syncCoordinator.resolvePeerUrl(peer, force),
      publish: (states) => this.linkHub?.publish("state", { states }),
      linkedPeer: (peer) => this.#linkedPeer(peer)
    });
    this.proxyStateListeners = [];
    this.proxySaveTimer = null;
    this.activitySync = new ActivitySyncManager({
      getConfig: () => this.config,
      getClient: () => this.client,
      getMappings: () => this.mappings,
      resolvePeerUrl: (peer, force) => this.syncCoordinator.resolvePeerUrl(peer, force),
      forwardProxyCommand: (sourceEntityId, cmdId, params, options) => this.forwardProxyCommand(sourceEntityId, cmdId, params, options),
      publish: (update) => this.linkHub?.publish("activity", { update }),
      linkedPeer: (peer) => this.#linkedPeer(peer)
    });
    this.satelliteManager = new SatelliteManager({
      getConfig: () => this.config,
      store: this.store,
      resolvePeer: (peer, force) => this.syncCoordinator.resolvePeerUrl(peer, force),
      syncPeer: (peer, force) => this.syncCoordinator.syncSinglePeer(peer, force),
      previewPeer: (peer) => this.syncNow(true, { dryRun: true, peerId: peer.peer_id }),
      syncedResources: () => (this.syncCoordinator.cachedSnapshot()?.manifest?.resources || []).map((item) => ({ type: item.type, id: item.id })),
      notify: () => this.#notify()
    });
  }

  addStatusListener(listener) { this.listeners.push(listener); }
  addProxyListener(listener) { this.proxyListeners.push(listener); }
  addProxyStateListener(listener) { this.proxyStateListeners.push(listener); }
  async load() {
    try {
      const config = this.store.load();
      if (config) await this.configure(config);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      this.config = null;
      this.client = null;
      this.status = createStatus("configuration_invalid");
      this.status.last_sync_result = error.message;
      this.status.configuration_errors = [...error.errors];
      this.#notify();
      log.error("Configuration validation failed:", error.message);
    }
  }

  // -------------------------------------------------------------------------
  // Service lifecycle
  // -------------------------------------------------------------------------

  async configure(config) {
    await this.stop();
    this.config = config;
    if (this.config.role === "master") {
      this.proxyStore.clear();
      this.proxyCatalog = { schema_version: 2, entities: [], mapping: {}, activation_hash: null };
      this.#notifyProxy();
      let changed = false;
      for (const peer of this.config.peers) {
        if (!peer.command_token) { peer.command_token = secureToken(); changed = true; }
      }
      if (changed) this.config = this.store.save(this.config);
    } else {
      this.proxyCatalog = this.proxyStore.load();
      this.#notifyProxy();
    }
    this.discovery.clear();
    this.client = new CoreClient(config.remote);
    if (config.role === "master") this.linkHub = this.createLinkHub();
    this.status = createStatus("starting");
    if (config.role === "child") {
      this.virtualDockServer = new VirtualDockServer(config);
      await this.virtualDockServer.start();
    }
    this.agent = new AgentServer(config, {
      applyCallback: (manifest, resources, context) => this.applyReceived(manifest, resources, context),
      previewCallback: (manifest, resources, context) => this.previewReceived(manifest, resources, context),
      statusCallback: () => this.statusPayload(),
      syncCallback: (force, options) => this.syncNow(force, options),
      pairingCallback: (pairing) => this.markPaired(pairing),
      credentialCallback: (request) => this.rotateSatelliteCredentials(request),
      unpairCallback: (request) => this.unpairSatellite(request),
      purgeCallback: (request) => this.purgeSynchronized(request),
      satelliteListCallback: (refresh) => refresh ? this.satelliteManager.refresh() : this.satelliteManager.list(),
      satelliteActionCallback: (peerId, action) => this.satelliteManager.action(peerId, action),
      commandCallback: (command) => this.executeProxyCommand(command),
      activityStateCallback: (update) => this.activitySync.apply(update),
      proxyStateCallback: (states) => this.applyProxyStates(states),
      proxyStatesCallback: () => this.stateRelay.currentStates(),
      linkCallback: ({ socket, peer }) => {
        if (!this.linkHub) throw new Error("This node is not an active primary");
        this.linkHub.attach(socket, peer);
      },
      dockTunnelCallback: (request) => this.openDockTunnel(request),
      pinPairingCallback: (coreKey) => this.pinPair(coreKey),
      uiHandler: this.uiHandler
    });
    await this.agent.start();
    try {
      const { ready, bad } = await this.client.ready();
      this.status.state = !ready ? `degraded: ${JSON.stringify(bad)}`
        : config.role === "unassigned" ? "choose a role"
          : (config.role === "child" && config.pairing?.ready_to_pair !== false ? "ready to pair" : "connected");
    } catch (error) { this.status.state = `unreachable: ${error.message}`; }
    if (config.role === "master") {
      this.watcher = new CoreEventWatcher(config.remote, (events) => this.#configurationEvents(events), {
        configurationFilter: (name, data) => {
          if (name === "configuration_change") return this.#settingsChanged(data?.new_state);
          if (name === "activity_group_change") return this.#groupChanged(data);
          return true;
        },
        activityStateCallback: (event) => this.activitySync.broadcast(event),
        entityStateCallback: (event) => this.stateRelay.handle(event),
        reconnectCallback: async () => { this.status.pending_changes = true; this.configurationRevision += 1; this.syncCoordinator.invalidateCache(); this.#scheduleEventSync(); }
      });
      this.watcherTask = this.watcher.run().catch((error) => log.error("Event watcher stopped:", error));
      this.#loadRelaySources().catch((error) => log.debug("Could not prepare the live state relay:", error.message));
      if (config.sync.auto_sync) {
        this.#scheduleInitialSync();
        this.#schedulePeriodic();
      }
    }
    if (config.role === "child" && config.pairing?.paired_master_id) this.#startSatelliteLink();
    this.#notify();
  }

  async stop() {
    clearTimeout(this.periodicTimer); this.periodicTimer = null;
    clearTimeout(this.initialSyncTimer); this.initialSyncTimer = null;
    clearTimeout(this.eventSyncTimer); this.eventSyncTimer = null;
    this.trailingSyncRequested = false;
    this.watcher?.stop();
    await this.watcherTask; this.watcherTask = null; this.watcher = null;
    for (const timer of this.retryTimers.values()) clearTimeout(timer); this.retryTimers.clear();
    for (const close of this.dockTunnelSessions) close();
    this.dockTunnelSessions.clear();
    this.linkHub?.close(); this.linkHub = null;
    this.link?.stop(); this.link = null;
    await this.agent?.stop(); this.agent = null;
    await this.virtualDockServer?.stop(); this.virtualDockServer = null;
    this.masterDockCatalog.clear();
    this.activitySync.clear();
    this.stateRelay.clear();
    this.driftGuard?.stop(); this.driftGuard = null;
    for (const timer of this.peerSyncTimers.values()) clearTimeout(timer); this.peerSyncTimers.clear();
    clearTimeout(this.proxyStateRefreshTimer); this.proxyStateRefreshTimer = null;
    this.#flushProxySave();
    try { await this.client?.close?.(); } catch (error) { log.debug("Core client close failed:", error.message); }
    this.client = null;
  }

  // -------------------------------------------------------------------------
  // Synchronization scheduling
  // -------------------------------------------------------------------------

  #scheduleInitialSync() {
    clearTimeout(this.initialSyncTimer);
    if (!this.config || this.config.role !== "master" || !this.config.sync.auto_sync) return;
    this.initialSyncTimer = setTimeout(async () => {
      this.initialSyncTimer = null;
      log.info("Starting initial synchronization after primary configuration");
      await this.syncNow(true);
    }, 2000 + Math.floor(Math.random() * 8000));
    this.initialSyncTimer.unref?.();
  }

  #schedulePeriodic() {
    clearTimeout(this.periodicTimer);
    if (!this.config || this.config.role !== "master" || !this.config.sync.auto_sync) return;
    const base = this.config.sync.interval_seconds * 1000;
    const jitter = Math.round(base * PERIODIC_JITTER_RATIO * (Math.random() * 2 - 1));
    this.periodicTimer = setTimeout(async () => {
      try {
        const peers = await this.satelliteManager.refresh();
        // Compared by change hash (content hashes include live device states and always differ), only for Satellites
        // that are awake and report what they hold. A sleeping Satellite is never woken for this: its link brings it up
        // to date as soon as it wakes up.
        const current = this.syncCoordinator.cachedSnapshot()?.manifest?.change_hash || this.status.last_change_hash || null;
        const stale = peers.filter((peer) => peer.enabled && peer.online && current && peer.last_applied_change_hash && peer.last_applied_change_hash !== current);
        for (const peer of stale) this.#queuePeerSync(peer.peer_id, "periodic check found an older configuration");
        if (!this.lastFullAuditAt || Date.now() - this.lastFullAuditAt >= FULL_AUDIT_INTERVAL_MS) {
          this.lastFullAuditAt = Date.now(); await this.syncNow(false, { reconcile: true, reason: "daily audit" });
        }
      } catch (error) { log.error("Periodic reconciliation failed:", error); }
      this.#schedulePeriodic();
    }, Math.max(60_000, base + jitter));
    this.periodicTimer.unref?.();
  }

  async #configurationEvents(events) {
    if (!this.config || this.config.role !== "master" || !this.config.sync.auto_sync) return;
    log.debug("Configuration event batch:", [...events].sort());
    for (const event of events) this.pendingConfigurationEvents.add(String(event));
    this.configurationRevision += 1;
    this.syncCoordinator.invalidateCache();
    this.status.pending_changes = true;
    this.#notify();
    this.#scheduleEventSync();
  }

  #scheduleEventSync() {
    clearTimeout(this.eventSyncTimer);
    if (!this.config || this.config.role !== "master" || !this.config.sync.auto_sync || !this.status.pending_changes) return;
    const cooldownRemaining = Math.max(0, this.lastSyncCompletedAt + MIN_EVENT_SYNC_INTERVAL_MS - Date.now());
    const delay = cooldownRemaining;
    this.eventSyncTimer = setTimeout(async () => {
      this.eventSyncTimer = null;
      if (this.syncing) {
        this.trailingSyncRequested = true;
        return;
      }
      try { await this.syncNow(false); } catch (error) { log.error("Event synchronization failed:", error); }
    }, delay);
    this.eventSyncTimer.unref?.();
  }


  #schedulePeerRetry(peerId, immediate = false) {
    if (this.retryTimers.has(peerId) || !this.config?.sync?.auto_sync) return;
    const runtime = this.satelliteManager.runtime.get(peerId) || {};
    const failures = Number(runtime.consecutive_failures || 0);
    const base = immediate ? 1000 : PEER_RETRY_BACKOFF_MS[Math.min(failures, PEER_RETRY_BACKOFF_MS.length - 1)];
    const delay = Math.max(1000, Math.round(base * (0.9 + Math.random() * 0.2)));
    const nextRetryAt = new Date(Date.now() + delay).toISOString();
    this.satelliteManager.record(peerId, { next_retry_at: nextRetryAt });
    const timer = setTimeout(async () => {
      this.retryTimers.delete(peerId);
      const peer = this.config?.peers?.find((item) => item.peer_id === peerId && item.enabled); if (!peer) return;
      this.status.telemetry.retries += 1;
      const snapshot = this.syncCoordinator.cachedSnapshot();
      if (!snapshot) { this.status.pending_changes = true; this.#scheduleEventSync(); return; }
      const result = await this.syncCoordinator.pushSnapshot(peer, snapshot.payload, { wake: false });
      if (result.asleep) { this.#recordAsleep(peerId); return; }
      if (result.success) { this.stateRelay.initialize(peer).catch(() => {}); this.satelliteManager.record(peerId, { online: true, last_error: null, last_applied_hash: snapshot.manifest.content_hash, last_attempted_hash: snapshot.manifest.content_hash, consecutive_failures: 0, next_retry_at: null, last_seen_at: utcNow() }); }
      else { const nextFailures = failures + 1; this.satelliteManager.record(peerId, { online: false, last_error: result.error || result.report?.error || "Synchronization failed", last_attempted_hash: snapshot.manifest.content_hash, consecutive_failures: nextFailures }); this.#schedulePeerRetry(peerId); }
    }, delay); timer.unref?.(); this.retryTimers.set(peerId, timer);
  }

  #recordAsleep(peerId) {
    this.satelliteManager.record(peerId, { online: false, last_error: null, next_retry_at: null, last_sync_result: "In standby; takes the configuration when it wakes up" });
  }

  #automaticLoadAllowed() {
    const memory = process.memoryUsage(); const eventLoopMs = Number(this.eventLoopDelay.mean || 0) / 1e6;
    Object.assign(this.status.telemetry, { rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed, event_loop_delay_ms: Math.round(eventLoopMs) });
    return memory.rss < MAX_AUTO_SYNC_RSS_BYTES && eventLoopMs < MAX_EVENT_LOOP_DELAY_MS;
  }

  // activity_group_change also reports the running state of the group's activities. Only a change of the group itself
  // (name, icon, options, members) is a configuration change.
  #groupChanged(data) {
    const eventType = String(data?.event_type || "").toUpperCase();
    const groupId = String(data?.group_id || data?.new_state?.group_id || "");
    if (!groupId || !data?.new_state || ["NEW", "CREATE", "DELETE"].includes(eventType)) return true;
    const fingerprint = groupFingerprint(data.new_state);
    const previous = this.groupFingerprints.get(groupId);
    this.groupFingerprints.set(groupId, fingerprint);
    return previous !== fingerprint;
  }

  // A configuration_change event carries every system setting; only a change of a synchronized one is relevant.
  #settingsChanged(cfgAll) {
    if (!this.config?.sync?.sections?.includes("settings") || !cfgAll) return false;
    const fingerprint = settingsFingerprint(extractSettings(cfgAll, this.config.sync.settings_categories));
    if (fingerprint === this.settingsFingerprint) return false;
    // Unknown before the first snapshot: treat as changed; the snapshot's change hash decides whether anything is sent.
    this.settingsFingerprint = fingerprint;
    return true;
  }

  // -------------------------------------------------------------------------
  // Persistent link
  // -------------------------------------------------------------------------

  // A Satellite that can hold a link gets live updates only over it; while it is disconnected (asleep) it catches up
  // when it reconnects, so the Primary does not try to reach it over HTTP for every change.
  #linkedPeer(peer) {
    if (!peer) return false;
    if (this.linkHub?.isConnected(peer.peer_id)) return true;
    return Array.isArray(peer.protocol?.capabilities) && peer.protocol.capabilities.includes("persistent_link");
  }

  createLinkHub() {
    return new LinkHub({
      fullState: async () => ({ states: await this.stateRelay.currentStates(), activities: await this.activitySync.currentUpdates() }),
      onCommand: (peer, message) => this.executeProxyCommand({
        source_entity_id: String(message.source_entity_id || ""),
        cmd_id: String(message.cmd_id || ""),
        params: message.params || undefined,
        entity_type: message.entity_type || null,
        issued_at: ageToTime(message.issued_age_ms),
        via: peer.name || peer.peer_id
      }),
      onActivityRelay: (peer, message) => this.executeProxyCommand({
        source_entity_id: String(message.source_activity_id || ""),
        cmd_id: `activity.${String(message.action || "").toLowerCase()}`,
        issued_at: ageToTime(message.issued_age_ms),
        via: peer.name || peer.peer_id
      }),
      onDrift: (peer, message) => {
        const objects = Array.isArray(message.objects) ? message.objects : [];
        log.warn(`${peer.name || peer.peer_id} reports ${objects.length} local edit(s) of synchronized configuration; restoring the Primary's version`);
        this.satelliteManager.record(peer.peer_id, { last_drift_at: utcNow(), last_drift: objects.slice(0, 20) });
        // Something other than a person (for example the Core reacting to a missing device) could keep changing an
        // object; restore at most once every few minutes so that can never turn into a synchronization loop.
        const last = this.driftSyncAt.get(peer.peer_id) || 0;
        const wait = Math.max(0, last + DRIFT_RESYNC_INTERVAL_MS - Date.now());
        this.driftSyncAt.set(peer.peer_id, Date.now() + wait);
        if (wait) log.warn(`Restoring ${peer.name || peer.peer_id} in ${Math.round(wait / 1000)}s (repeated local edits are throttled)`);
        setTimeout(() => this.#queuePeerSync(peer.peer_id, "local edits on the Satellite", { fresh: true }), wait).unref?.();
      },
      onHello: (peer, message) => {
        // Configuration is compared by its change hash, which ignores live state: comparing content hashes would
        // re-send the whole configuration on every wake-up because device states always differ.
        const appliedChange = typeof message.applied_change_hash === "string" ? message.applied_change_hash : null;
        const applied = typeof message.applied_content_hash === "string" ? message.applied_content_hash : null;
        this.satelliteManager.record(peer.peer_id, {
          online: true,
          last_seen_at: utcNow(),
          version: message.version || undefined,
          hardware: message.hardware || null,
          link_connected_at: utcNow()
        });
        const manifest = this.syncCoordinator.cachedSnapshot()?.manifest;
        const currentChange = manifest?.change_hash || this.status.last_change_hash || null;
        const currentContent = manifest?.content_hash || this.status.last_snapshot_hash || null;
        const outdated = appliedChange && currentChange ? appliedChange !== currentChange
          : (!applied && !appliedChange) ? Boolean(currentChange || currentContent)
            : Boolean(currentContent && applied !== currentContent);
        if (!outdated) return;
        // A configuration this Satellite already failed to apply is not pushed again on every wake-up; the retry
        // backoff takes care of it.
        const runtime = this.satelliteManager.list().find((item) => item.peer_id === peer.peer_id) || {};
        const recentlyFailed = currentChange && runtime.last_attempted_change_hash === currentChange && runtime.last_error
          && Date.now() - Date.parse(runtime.last_sync_at || 0) < FAILED_PEER_SYNC_QUIET_MS;
        if (recentlyFailed) { log.info(`${peer.name || peer.peer_id} is still missing the current configuration; the last attempt failed, waiting for the scheduled retry`); return; }
        this.#queuePeerSync(peer.peer_id, applied || appliedChange ? "configuration changed while the Satellite was away" : "Satellite has no configuration yet");
      }
    });
  }

  // Bring one Satellite up to date: on reconnect with an outdated configuration, or to undo local edits (fresh = build a
  // new snapshot so the Satellite applies it even if it saw the same content before).
  #queuePeerSync(peerId, reason, { fresh = false } = {}) {
    if (this.peerSyncTimers.has(peerId)) return;
    const timer = setTimeout(async () => {
      this.peerSyncTimers.delete(peerId);
      const peer = this.config?.peers?.find((item) => item.peer_id === peerId && item.enabled);
      if (!peer || this.config?.role !== "master") return;
      if (this.syncing) { this.#queuePeerSync(peerId, reason, { fresh }); return; }
      // The same guards as every other automatic synchronization: never while this remote is under load, and not more
      // often than every few minutes per Satellite (repeated full synchronizations are what makes remotes sluggish).
      const wait = Math.max(0, (this.peerSyncAt.get(peerId) || 0) + MIN_PEER_SYNC_INTERVAL_MS - Date.now());
      if (wait > 0 || !this.#automaticLoadAllowed()) {
        const delay = wait || 60_000;
        log.info(`Synchronizing ${peer.name || peerId} later (${wait ? "recently synchronized" : "this remote is busy"}); retrying in ${Math.round(delay / 1000)}s`);
        const later = setTimeout(() => { this.peerSyncTimers.delete(peerId); this.#queuePeerSync(peerId, reason, { fresh }); }, delay);
        later.unref?.();
        this.peerSyncTimers.set(peerId, later);
        return;
      }
      this.peerSyncAt.set(peerId, Date.now());
      log.info(`Synchronizing ${peer.name || peerId}: reason=${reason} mode=${fresh ? "full" : "changes"}`);
      this.syncing = true;
      try {
        const cached = this.syncCoordinator.cachedSnapshot();
        const snapshot = !fresh && cached ? cached : await this.syncCoordinator.buildSnapshot({ force: true });
        log.info(`Peer sync hashes for ${peer.name || peerId}: previous=${String(this.satelliteManager.runtime.get(peerId)?.last_applied_change_hash || "none").slice(0, 12)} next=${String(snapshot.manifest.change_hash || "none").slice(0, 12)} content=${String(snapshot.manifest.content_hash || "none").slice(0, 12)}`);
        const result = await this.syncCoordinator.pushSnapshot(peer, snapshot.payload, { wake: false, full: fresh });
        if (result.asleep) { this.#recordAsleep(peerId); return; }
        if (result.success) {
          await this.activitySync.initialize(peer, snapshot.manifest.data.activities || []);
          await this.stateRelay.initialize(peer);
        }
        this.satelliteManager.record(peerId, {
          online: Boolean(result.success),
          last_sync_at: utcNow(),
          last_sync_result: result.success ? `Synchronized (${reason})` : (result.error || "Synchronization failed"),
          last_error: result.success ? null : (result.error || result.report?.error || "Synchronization failed"),
          last_applied_hash: result.success ? snapshot.manifest.content_hash : undefined,
          last_attempted_hash: snapshot.manifest.content_hash,
          last_attempted_change_hash: snapshot.manifest.change_hash || null
        });
        if (!result.success) this.#schedulePeerRetry(peerId);
      } catch (error) {
        log.warn(`Synchronizing ${peer.name || peerId} failed:`, error.message);
        this.#schedulePeerRetry(peerId);
      } finally {
        this.syncing = false;
        this.#notify();
      }
    }, 3000);
    timer.unref?.();
    this.peerSyncTimers.set(peerId, timer);
  }

  #stopSatelliteLink() {
    this.link?.stop(); this.link = null;
    this.driftGuard?.stop(); this.driftGuard = null;
    const watcher = this.watcher;
    this.watcher = null;
    watcher?.stop();
    this.watcherTask = null;
  }

  #startSatelliteLink() {
    const sourceNode = () => this.config?.pairing?.paired_master_id || null;
    this.driftGuard = new DriftGuard({
      getClient: () => this.client,
      getMappings: () => this.mappings,
      getSourceNode: sourceNode,
      report: async (objects) => Boolean(this.link?.send("drift", { objects })),
      appliedSettings: this.proxyCatalog?.applied_settings || {},
      restoreSettings: async (settings) => {
        const report = createApplyReport("settings-restore");
        await applyDeviceSettings(this.client, settings, report);
        for (const warning of report.warnings) log.warn(warning);
      }
    });
    this.driftGuard.restoreFingerprints(this.proxyCatalog?.applied_fingerprints);
    this.link = new LinkClient({
      getTarget: () => ({ url: this.config?.pairing?.master_agent_url, token: this.config?.pairing?.master_command_token }),
      hello: () => ({
        node_id: this.config?.node_id,
        version: APP_VERSION,
        applied_content_hash: this.proxyCatalog?.applied_content_hash || null,
        applied_change_hash: this.proxyCatalog?.applied_change_hash || null,
        hardware: this.hardwareProfile
      }),
      onFull: async (message) => {
        this.applyProxyStates(message.states || [], { full: true });
        for (const update of message.activities || []) await this.activitySync.apply(update);
      },
      onEvent: async (message) => {
        if (message.type === "state") this.applyProxyStates(message.states || []);
        else if (message.type === "activity" && message.update) await this.activitySync.apply(message.update);
      },
      onStatus: (status) => {
        this.status.link = status;
        if (status.connected) this.driftGuard?.flush().catch(() => {});
        this.#notify();
      }
    });
    this.link.start();
    // Satellites also watch their own Core: edits to configuration that came from the Primary are reverted.
    if (!this.watcher) {
      this.watcher = new CoreEventWatcher(this.config.remote, async () => {}, {
        // Only what the drift guard needs: not the device-state events Remote Sync itself pushes into this remote.
        channels: SATELLITE_EVENT_CHANNELS,
        configurationFilter: () => true,
        configurationDetailCallback: (name, data) => this.driftGuard?.note(name, data)
      });
      this.watcherTask = this.watcher.run().catch((error) => log.error("Satellite event watcher stopped:", error));
    }
    readHardwareProfile(this.client).then((profile) => { this.hardwareProfile = profile; }).catch(() => {});
    // Without a link (Primary on an older release), pull states over HTTP once.
    setTimeout(() => { if (!this.link?.connected) this.#scheduleProxyStateRefresh(0); }, 15_000).unref?.();
  }

  applyActivityState(update) {
    return this.activitySync.apply(update);
  }

  forwardActivityCommand(sourceActivityId, action) {
    return this.activitySync.forward(sourceActivityId, action);
  }

  // -------------------------------------------------------------------------
  // Snapshot synchronization
  // -------------------------------------------------------------------------

  async syncNow(force = true, { dryRun = false, peerId = null, reconcile = false, reason = null } = {}) {
    if (!this.config || !this.client) return { success: false, error: "Remote Sync is not configured" };
    if (this.config.role !== "master") return { success: false, error: "This node is configured as a satellite" };
    if (!dryRun && !force && !reconcile && !this.status.pending_changes) { this.status.telemetry.suppressed_builds += 1; return { success: true, changed: false, content_hash: this.status.last_snapshot_hash }; }
    if (!dryRun && !force && !this.#automaticLoadAllowed()) { this.status.last_sync_result = "Automatic synchronization deferred due to process load"; this.#scheduleEventSync(); return { success: false, deferred: true, error: this.status.last_sync_result }; }
    if (this.syncing) {
      if (!dryRun) this.trailingSyncRequested = this.trailingSyncRequested || this.status.pending_changes;
      return { success: false, error: "A synchronization is already running" };
    }
    this.syncing = true;
    const syncRevision = this.configurationRevision;
    this.status.state = dryRun ? "building synchronization preview" : "building snapshot";
    this.status.last_sync_result = dryRun ? "Collecting primary configuration for preview" : "Collecting primary configuration";
    this.#notify();
    try {
      const eventReasons = [...this.pendingConfigurationEvents].sort().slice(0, 12);
      this.status.telemetry.last_build_reason = reason || (dryRun ? "preview" : force ? "forced" : reconcile ? "audit" : `configuration event (${eventReasons.join(", ") || "unspecified"})`);
      const snapshot = await this.syncCoordinator.buildSnapshot({ force: force || reconcile || dryRun, shouldAbort: () => !force && !dryRun && this.configurationRevision !== syncRevision });
      this.status.telemetry.builds += 1; Object.assign(this.status.telemetry, { last_build_ms: snapshot.metrics?.build_ms || null, last_compression_ms: snapshot.metrics?.compression_ms || null, last_payload_bytes: snapshot.metrics?.payload_bytes || snapshot.payload.length, last_uncompressed_bytes: snapshot.metrics?.uncompressed_bytes || null, last_resource_count: snapshot.metrics?.resource_count || 0 });
      log.info(`Snapshot decision: reason=${this.status.telemetry.last_build_reason} requested_mode=${force ? "full" : "changes"} previous_change=${String(this.status.last_change_hash || "none").slice(0, 12)} new_change=${String(snapshot.manifest.change_hash || "none").slice(0, 12)} previous_content=${String(this.status.last_snapshot_hash || "none").slice(0, 12)} new_content=${String(snapshot.manifest.content_hash || "none").slice(0, 12)}`);
      const unchanged = snapshot.manifest.content_hash === this.status.last_snapshot_hash
        || (snapshot.manifest.change_hash && snapshot.manifest.change_hash === this.status.last_change_hash);
      if (!dryRun && !force && unchanged) {
        if (this.configurationRevision === syncRevision) this.pendingConfigurationEvents.clear();
        Object.assign(this.status, { pending_changes: this.configurationRevision !== syncRevision, state: "connected", last_sync_result: "No configuration changes" });
        this.#notify();
        return { success: true, changed: false, content_hash: snapshot.manifest.content_hash };
      }

      const peers = this.config.peers.filter((peer) => peer.enabled && (!peerId || peer.peer_id === peerId));
      if (peerId && !peers.length) return { success: false, error: `Enabled satellite ${peerId} was not found` };
      const peerResults = {};
      let success = true;
      for (const peer of peers) {
        if (!dryRun) log.info(`Pushing snapshot to ${peer.name || peer.peer_id}: reason=${this.status.telemetry.last_build_reason} mode=${force ? "full" : "changes"} previous_applied=${String(this.satelliteManager.runtime.get(peer.peer_id)?.last_applied_change_hash || "none").slice(0, 12)} change=${String(snapshot.manifest.change_hash || "none").slice(0, 12)}`);
        const result = dryRun
          ? await this.syncCoordinator.previewPeer(peer, snapshot.payload)
          : await this.syncCoordinator.pushSnapshot(peer, snapshot.payload, { wake: force, full: force });
        peerResults[peer.peer_id] = result;
        if (result.asleep) {
          // Not a failure: the Satellite is in standby and takes this configuration over its link when it wakes up.
          peerResults[peer.peer_id] = { ...result, success: true, deferred: true };
          this.#recordAsleep(peer.peer_id);
          continue;
        }
        success &&= Boolean(result.success);
        this.satelliteManager.record(peer.peer_id, {
          online: Boolean(result.success),
          version: result.protocol?.version || peer.protocol?.version || null,
          protocol: result.protocol || peer.protocol || null,
          last_seen_at: result.success ? utcNow() : null,
          last_error: result.success ? null : (result.error || result.report?.error || `HTTP ${result.status || "error"}`),
          last_sync_at: dryRun ? null : utcNow(),
          last_sync_result: dryRun ? result.preview?.summary || null : (result.success ? "Synchronized" : result.error || "Synchronization failed"),
          mirrored_entities: Number(result.report?.counts?.proxy_entities_configured || result.report?.counts?.proxy_entities_updated || 0),
          last_attempted_hash: snapshot.manifest.content_hash,
          last_attempted_change_hash: snapshot.manifest.change_hash || null,
          last_applied_change_hash: result.success ? snapshot.manifest.change_hash || null : undefined,
          last_applied_hash: result.success ? snapshot.manifest.content_hash : undefined,
          consecutive_failures: result.success ? 0 : Number((this.satelliteManager.runtime.get(peer.peer_id) || {}).consecutive_failures || 0) + 1,
          next_retry_at: result.success ? null : undefined
        });
        if (!dryRun && result.success) {
          await this.activitySync.initialize(peer, snapshot.manifest.data.activities || []);
          await this.stateRelay.initialize(peer);
        }
        if (!dryRun && !result.success) this.#schedulePeerRetry(peer.peer_id);
      }

      const now = utcNow();
      if (dryRun) {
        const totals = { create: 0, update: 0, remove: 0 };
        for (const result of Object.values(peerResults)) {
          const counts = result.preview?.counts || {};
          totals.create += Number(counts.create || 0);
          totals.update += Number(counts.update || 0);
          totals.remove += Number(counts.remove || 0);
        }
        this.status.last_preview_at = now;
        this.status.last_preview_details = {
          generated_at: now,
          totals,
          peers: peers.map((peer) => {
            const result = peerResults[peer.peer_id] || {};
            return {
              peer_id: peer.peer_id,
              name: peer.name,
              success: Boolean(result.success),
              error: result.success ? null : (result.error || result.report?.error || null),
              counts: result.preview?.counts || null,
              sections: result.preview?.sections || null,
              summary: result.preview?.summary || null
            };
          })
        };
        this.status.last_preview_result = peers.length
          ? `Create ${totals.create}, update ${totals.update}, remove ${totals.remove} across ${peers.length} satellite(s)`
          : "No satellite peers configured";
        this.status.state = success ? "connected" : "error";
        this.status.last_sync_result = this.status.last_preview_result;
        this.#notify();
        return { success, dry_run: true, operation_id: snapshot.manifest.operation_id, content_hash: snapshot.manifest.content_hash, totals, peers: peerResults };
      }

      this.status.last_sync_at = now;
      this.status.peer_results = peerResults;
      if (!peers.length) {
        this.status.last_sync_result = "Snapshot built; no satellite peers configured";
        success = true;
      } else if (success) {
        this.status.last_sync_result = `Synchronized ${peers.length} satellite remote(s)`;
      } else {
        const failed = peers.filter((peer) => !peerResults[peer.peer_id]?.success);
        this.status.last_sync_result = failed.map((peer) => {
          const result = peerResults[peer.peer_id] || {};
          const errors = Array.isArray(result.report?.errors) ? result.report.errors.filter(Boolean) : [];
          return `${peer.name}: ${result.error || errors[0] || result.report?.error || `HTTP ${result.status || "error"}`}`;
        }).join(" | ").slice(0, 1000) || `${failed.length} satellite remote(s) failed`;
      }
      if (success) {
        if (this.configurationRevision === syncRevision) this.pendingConfigurationEvents.clear();
        this.status.last_snapshot_hash = snapshot.manifest.content_hash;
        this.status.last_change_hash = snapshot.manifest.change_hash || null;
        this.status.pending_changes = this.configurationRevision !== syncRevision;
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
      if (error?.code === "SNAPSHOT_SUPERSEDED") { this.status.pending_changes = true; this.status.last_sync_result = error.message; return { success: false, superseded: true, error: error.message }; }
      log.error(dryRun ? "Synchronization preview failed:" : "Synchronization failed:", error);
      if (!dryRun) this.status.failed_syncs += 1;
      this.status.state = "error";
      this.status.last_sync_at = dryRun ? this.status.last_sync_at : utcNow();
      this.status.last_sync_result = error.message;
      this.#notify();
      return { success: false, dry_run: dryRun, error: error.message, details: error.details || undefined };
    } finally {
      this.syncing = false;
      if (!dryRun) this.lastSyncCompletedAt = Date.now();
      if (!dryRun && (this.trailingSyncRequested || this.configurationRevision !== syncRevision)) {
        this.trailingSyncRequested = false;
        this.#scheduleEventSync();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Satellite snapshot application
  // -------------------------------------------------------------------------

  async applyReceived(manifest, resources, masterContext = {}) {
    if (!this.config || !this.client) return finishReport(Object.assign(createApplyReport(manifest.operation_id), { errors: ["Remote Sync is not configured"] }), false);
    if (this.applying) return finishReport(Object.assign(createApplyReport(manifest.operation_id), { errors: ["A snapshot is already being applied"] }), false);
    this.applying = true;
    this.driftGuard?.beginApply();
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
      // An automatic synchronization of the configuration this Satellite already holds changes nothing: rewriting every
      // activity and page anyway makes the remote reload its UI and is what made Satellites sluggish. The drift guard
      // confirms nothing was edited here before the apply is skipped.
      const sameConfiguration = Boolean(manifest.change_hash && this.proxyCatalog?.applied_change_hash === manifest.change_hash);
      const integrity = masterContext.apply_mode === "changes" && sameConfiguration && this.driftGuard
        ? (typeof this.driftGuard.integrityReport === "function"
          ? await this.driftGuard.integrityReport()
          : { intact: await this.driftGuard.intact(), reason: "legacy integrity check" })
        : null;
      log.info(`Satellite received snapshot: mode=${masterContext.apply_mode || "unknown"} change=${String(manifest.change_hash || "none").slice(0, 12)} previous=${String(this.proxyCatalog?.applied_change_hash || "none").slice(0, 12)} same_configuration=${sameConfiguration} integrity=${integrity?.intact ?? "not-checked"}${integrity && !integrity.intact ? ` reason=${integrity.reason}${integrity.key ? ` object=${integrity.key}` : ""}` : ""}`);
      if (integrity?.intact) {
        this.proxyCatalog.applied_content_hash = manifest.content_hash;
        this.proxyStore.save(this.proxyCatalog);
        this.status.last_snapshot_hash = manifest.content_hash;
        this.status.last_sync_result = `Configuration from ${manifest.source_name} is already applied`;
        this.status.state = "connected";
        this.link?.requestResync();
        log.info(`Configuration ${manifest.change_hash.slice(0, 12)} is already applied; nothing to do`);
        const report = createApplyReport(manifest.operation_id);
        report.unchanged = true;
        incrementReport(report, "unchanged_snapshots");
        return finishReport(report, true);
      }
      const previousProxyCatalog = this.proxyCatalog;
      // Adapt the Primary's button mappings and UI pages to this remote's hardware (Remote Two ↔ Remote 3).
      if (!this.hardwareProfile) this.hardwareProfile = await readHardwareProfile(this.client).catch(() => null);
      const hardware = new HardwareAdapter(manifest.source_hardware || null, this.hardwareProfile);
      if (hardware.differs) log.info(`Adapting configuration from ${manifest.source_hardware?.model || "the Primary"} to ${this.hardwareProfile?.model || "this remote"}`);
      const nextProxyCatalog = buildProxyCatalog(manifest, previousProxyCatalog, { adaptRemoteOptions: (options, context) => hardware.remoteOptions(options, context) });
      const activationChanged = previousProxyCatalog?.activation_hash !== nextProxyCatalog.activation_hash;
      // Live states arrive through their own channel. Re-registering 157 proxy
      // entities for a state-only change creates needless Core UI work.
      const proxyConfigurationHash = (catalog) => sha256Bytes(canonicalJson(stableConfiguration(
        (catalog?.entities || []).map(({ attributes: _attributes, ...descriptor }) => descriptor)
      )));
      const catalogChanged = proxyConfigurationHash(previousProxyCatalog) !== proxyConfigurationHash(nextProxyCatalog);
      const sameSource = previousProxyCatalog?.source_node_id === manifest.source_node_id;
      const appliedObjects = sameSource ? structuredClone(previousProxyCatalog?.applied_objects || {}) : {};
      for (const key of ["applied_content_hash", "applied_change_hash", "applied_fingerprints", "applied_settings"]) {
        if (sameSource && previousProxyCatalog?.[key] !== undefined) nextProxyCatalog[key] = previousProxyCatalog[key];
      }
      nextProxyCatalog.applied_objects = appliedObjects;
      this.proxyCatalog = nextProxyCatalog;
      this.proxyStore.save(this.proxyCatalog);
      if (catalogChanged) this.#notifyProxy();
      else log.info("Proxy descriptors unchanged; skipped available/configured entity re-registration");

      if (activationChanged) {
        log.info(`Proxy catalog changed (${nextProxyCatalog.entities.length} entities); refreshing it through the Core WebSocket API`);
      }


      this.status.state = "applying proxy configuration";
      this.#notify();
      const applier = new SnapshotApplier(this.client, this.config, this.operationCache, this.mappings, { hardware, appliedObjects });
      const report = await applier.apply(manifest, resources, this.proxyCatalog, previousProxyCatalog);
      this.status.last_sync_at = report.finished_at;
      if (report.success) {
        this.status.last_snapshot_hash = manifest.content_hash;
        // Only a fully applied snapshot counts; the link reports this hash so the Primary can tell what is missing.
        this.proxyCatalog.applied_content_hash = manifest.content_hash;
        this.proxyCatalog.applied_change_hash = manifest.change_hash || null;
        this.proxyCatalog.applied_objects = applier.objectState.entries;
        // Device settings now held for the Primary; edits to them on this remote are restored.
        if (!manifest.sections.includes("settings")) this.proxyCatalog.applied_settings = {};
        else if (applier.appliedSettings) this.proxyCatalog.applied_settings = applier.appliedSettings;
        this.driftGuard?.setAppliedSettings(this.proxyCatalog.applied_settings || {});
        // Remember how every synchronized object looks now, so later events can be checked against it.
        const catalog = this.proxyCatalog;
        this.driftGuard?.captureFingerprints().then((fingerprints) => {
          if (this.proxyCatalog !== catalog) return;
          catalog.applied_fingerprints = fingerprints;
          this.proxyStore.save(catalog);
        }).catch((error) => log.debug("Could not record configuration fingerprints:", error.message));
        this.proxyStore.save(this.proxyCatalog);
        // Proxy entities were rebuilt from snapshot attributes; take the current live states again.
        this.link?.requestResync();
      }
      this.status.last_hardware_adjustments = report.hardware_adjustments || [];
      this.status.last_sync_result = report.success ? `Applied snapshot from ${manifest.source_name}` : report.errors.join("; ") || "Snapshot apply failed";
      this.status.state = report.success ? "connected" : "error";
      if (report.success) this.status.successful_syncs += 1; else this.status.failed_syncs += 1;
      this.#notify();
      return report;
    } finally { this.applying = false; this.driftGuard?.endApply(); }
  }

  previewReceived(manifest, _resources, _masterContext = {}) {
    if (!this.config || this.config.role !== "child") {
      return { success: false, dry_run: true, error: "Synchronization preview is only available on a configured satellite" };
    }
    const preview = buildApplyPreview(manifest, this.config, this.mappings, this.proxyCatalog);
    this.status.last_preview_at = preview.generated_at;
    this.status.last_preview_result = preview.summary;
    this.#notify();
    return { success: true, ...preview };
  }

  async rotateSatelliteCredentials({ master_id, master_command_token }) {
    if (!this.config || this.config.role !== "child") throw new Error("Only a satellite can rotate pairing credentials");
    if (String(master_id || "") !== String(this.config.pairing?.paired_master_id || "")) throw new Error("Credential rotation requested by a different primary");
    const nextToken = secureToken();
    this.config.agent_token = nextToken;
    this.config.pairing.master_command_token = String(master_command_token || this.config.pairing.master_command_token || "");
    this.store.save(this.config);
    this.status.last_sync_result = "Pairing credentials rotated";
    this.#notify();
    return { agent_token: nextToken };
  }

  // Remove everything the paired Primary synchronized to this Satellite. Called by the Primary before it removes the
  // Satellite.
  async purgeSynchronized({ master_id, resources = [] }) {
    if (!this.config || this.config.role !== "child") throw new Error("Only a satellite can remove synchronized configuration");
    if (String(master_id || "") !== String(this.config.pairing?.paired_master_id || "")) throw new Error("Removal requested by a different primary");
    if (this.applying) throw new Error("A snapshot is being applied; try again in a moment");
    this.applying = true;
    this.status.state = "removing synchronized configuration";
    this.#notify();
    try {
      const purger = new SatellitePurger(this.client, this.mappings);
      const report = await purger.purge(String(master_id), { proxyCatalog: this.proxyCatalog, resources });
      this.virtualDockServer?.setDocks(String(master_id), []);
      this.proxyStore.clear();
      this.proxyCatalog = { schema_version: 2, entities: [], mapping: {}, activation_hash: null };
      this.#notifyProxy();
      this.status.last_snapshot_hash = null;
      this.status.last_sync_result = `Removed ${report.removed} synchronized object(s)${report.remaining ? `; ${report.remaining} could not be removed` : ""}`;
      return report;
    } finally {
      this.applying = false;
      this.status.state = this.config?.pairing?.paired_master_id ? "paired" : "ready to pair";
      this.#notify();
    }
  }

  async unpairSatellite({ master_id }) {
    if (!this.config || this.config.role !== "child") throw new Error("Only a satellite can be unpaired");
    if (String(master_id || "") !== String(this.config.pairing?.paired_master_id || "")) throw new Error("Unpairing requested by a different primary");
    this.config.pairing = {
      ready_to_pair: true,
      paired_master_id: null,
      paired_master_name: null,
      paired_at: null,
      master_agent_url: null,
      master_command_token: null,
      master_mac: null,
      master_broadcasts: []
    };
    this.store.save(this.config);
    this.#stopSatelliteLink();
    this.status.state = "ready to pair";
    this.status.last_sync_result = "Satellite was unpaired";
    this.#notify();
    return { success: true };
  }

  async markPaired({ master_id, master_name, master_agent_url = null, master_command_token = null, master_mac = null, master_broadcasts = [] }) {
    if (!this.config || this.config.role !== "child") throw new Error("Only a satellite can be paired");
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
    this.status.last_sync_result = `Paired with primary ${pairing.paired_master_name}`;
    if (!this.link && this.client) this.#startSatelliteLink();
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

  // -------------------------------------------------------------------------
  // Dock tunnels
  // -------------------------------------------------------------------------

  async openDockTunnel({ downstream, dock_id, child }) {
    if (!this.config || this.config.role !== "master" || !this.client) throw new Error("This node is not an active primary");
    const sourceDockId = String(dock_id || "").trim();
    if (!sourceDockId) throw new Error("dock_id is required");
    const detail = await this.#dockDetail(sourceDockId);
    if (!detail) throw new Error(`Dock ${sourceDockId} is not configured on the primary`);
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

  // -------------------------------------------------------------------------
  // Proxy command routing
  // -------------------------------------------------------------------------

  async executeProxyCommand({ source_entity_id, cmd_id, params, entity_type = null, issued_at = null, via = null }) {
    if (!this.config || this.config.role !== "master" || !this.client) return { success: false, status: 409, error: "This node is not an active primary" };
    // Newest action wins: an activity start/stop that was issued before the activity last changed on the Primary (for
    // example queued while the Primary was asleep) is dropped, and the Satellite is told the current state instead.
    const activityAction = /^activity\.(on|off)$/.exec(String(cmd_id || ""));
    const issuedAt = Number(issued_at);
    if (activityAction && Number.isFinite(issuedAt) && issuedAt > 0) {
      const lastChange = this.activitySync.lastChange(source_entity_id);
      if (lastChange && issuedAt < lastChange) {
        log.info(`Ignoring activity.${activityAction[1]} for ${source_entity_id}${via ? ` from ${via}` : ""}: a newer change happened on the Primary`);
        const update = this.activitySync.republish(source_entity_id);
        return { success: true, status: 200, superseded: true, source_entity_id, cmd_id, current_state: update?.state || null };
      }
    }
    const candidates = proxyCommandCandidates(cmd_id, entity_type);
    let executed = candidates[0];
    try {
      const readiness = await this.#activityReadiness(source_entity_id, executed);
      let response;
      for (let index = 0; index < candidates.length; index += 1) {
        executed = candidates[index];
        try {
          response = await this.client.executeEntityCommand(source_entity_id, executed, params);
          break;
        } catch (error) {
          // A Core that rejects one spelling of the command id gets the other one; any other error is final.
          const retry = index + 1 < candidates.length && error instanceof CoreApiError && [400, 422].includes(error.status);
          if (!retry) throw error;
          log.debug(`Core rejected command ${executed} for ${source_entity_id}; trying ${candidates[index + 1]}`);
        }
      }
      let entity = null;
      try {
        await sleep(100);
        entity = await this.client.getJson(`/entities/${encodeURIComponent(source_entity_id)}`, { optionalStatuses: [404] });
      } catch (error) { log.debug(`Could not refresh state after proxy command: ${error.message}`); }
      if (entity?.attributes) this.stateRelay.observe(source_entity_id, entity.attributes);
      return { success: true, status: 200, source_entity_id, cmd_id: executed, response, entity, readiness };
    } catch (error) {
      log.warn(`Proxy command failed for ${source_entity_id}:${executed}:`, error.message);
      return { success: false, status: error.status || 502, error: error.message, source_entity_id, cmd_id: executed };
    }
  }

  // Pre-flight report for relayed activity commands. The check never gates the command (the Core runs the activity
  // exactly as before); it surfaces devices that would not be reached so the satellite can show a useful reason.
  async #activityReadiness(entityId, cmdId) {
    const match = /^activity\.(on|off|start)$/.exec(String(cmdId || ""));
    if (!match || typeof this.client?.activityReadiness !== "function") return null;
    const report = await this.client.activityReadiness(entityId, match[1] === "start" ? "on" : match[1]);
    if (!report || typeof report !== "object") return null;
    const blocked = (Array.isArray(report.steps) ? report.steps : [])
      .filter((step) => step && step.ready === false)
      .map((step) => ({ entity_id: step.entity_id || step.target_entity_id || null, name: step.name || step.entity_name || null, reason: step.reason || null }))
      .slice(0, 20);
    const summary = { ready: report.ready !== false, blocked_steps: Number(report.blocked_steps ?? blocked.length) || 0, aborting_steps: Number(report.aborting_steps || 0), blocked };
    if (!summary.ready || summary.blocked_steps) {
      log.warn(`Activity ${entityId} ${match[1]} readiness: ${summary.ready ? "ready" : "not ready"}, ${summary.blocked_steps} blocked step(s)`, blocked.map((step) => `${step.name || step.entity_id}: ${step.reason || "blocked"}`).join("; "));
    }
    return summary;
  }

  async #postProxyCommand(url, token, sourceEntityId, cmdId, params, entityType = null, issuedAt = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${String(url).replace(/\/$/, "")}/v1/proxy/command`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        // The age (not a timestamp) of the action: the two remotes' clocks never have to agree.
        body: JSON.stringify({ source_entity_id: sourceEntityId, cmd_id: cmdId, params, entity_type: entityType || undefined, issued_age_ms: issuedAt ? Math.max(0, Date.now() - issuedAt) : undefined }),
        signal: controller.signal
      });
      const text = await response.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
      return { ...body, success: response.ok && body.success !== false, status: response.status };
    } finally { clearTimeout(timer); }
  }

  async forwardProxyCommand(sourceEntityId, cmdId, params = undefined, { entityType = null, issuedAt = null } = {}) {
    if (!this.config || this.config.role !== "child") return { success: false, status: 409, error: "Proxy commands are only available on satellite remotes" };
    const pairing = this.config.pairing || {};
    if (!pairing.master_agent_url || !pairing.master_command_token) return { success: false, status: 503, error: "Primary command endpoint is not configured; run a synchronization from the primary" };
    const stampedAt = issuedAt || Date.now();
    // The persistent link is the fast path. If it is down the command goes over HTTP, which also wakes a sleeping
    // Primary. A command that was sent over the link but not answered is not repeated, so it never runs twice.
    if (this.link?.connected) {
      try {
        const result = await this.link.request("command", { source_entity_id: sourceEntityId, cmd_id: cmdId, params, entity_type: entityType || undefined, issued_age_ms: Math.max(0, Date.now() - stampedAt) });
        if (result.success) this.#updateProxyState(sourceEntityId, result.entity?.attributes);
        return result;
      } catch (error) {
        if (error.code !== "LINK_DOWN") return { success: false, status: 504, error: error.message };
      }
    }
    this.link?.nudge();
    try {
      const result = await this.#postProxyCommand(pairing.master_agent_url, pairing.master_command_token, sourceEntityId, cmdId, params, entityType, stampedAt);
      if (result.success) this.#updateProxyState(sourceEntityId, result.entity?.attributes);
      return result;
    } catch (error) {
      // Connection refused: the Primary is awake but Remote Sync is not running there. Waking it cannot help.
      if ((error?.cause?.code || error?.code) === "ECONNREFUSED") {
        return { success: false, status: 503, error: `Remote Sync is not running on the Primary (${pairing.master_agent_url} refused the connection). Check that its integration setup was finished and the integration is enabled.` };
      }
      if (!isTransportError(error) || !pairing.master_mac) return { success: false, status: 503, error: error.message };
      await sendMagicPacket(pairing.master_mac, pairing.master_broadcasts || []);
      let lastError = error;
      const deadline = Date.now() + WAKE_TIMEOUT_MS;
      let index = 0;
      while (Date.now() < deadline) {
        await sleep(WAKE_RETRY_SCHEDULE_MS[Math.min(index++, WAKE_RETRY_SCHEDULE_MS.length - 1)]);
        try {
          const result = await this.#postProxyCommand(pairing.master_agent_url, pairing.master_command_token, sourceEntityId, cmdId, params, entityType, stampedAt);
          if (result.success) this.#updateProxyState(sourceEntityId, result.entity?.attributes);
          return result;
        } catch (retryError) { lastError = retryError; if (!isTransportError(retryError)) break; }
      }
      return { success: false, status: 503, error: lastError.message };
    }
  }

  #updateProxyState(sourceEntityId, attributes) {
    if (!attributes || typeof attributes !== "object") return;
    this.applyProxyStates([{ source_entity_id: sourceEntityId, attributes }]);
  }

  // Satellite: live attributes of proxied entities from the Primary (pushed, pulled or returned by a command).
  applyProxyStates(states, _options = {}) {
    if (!this.config || this.config.role !== "child") return { success: false, status: 409, error: "This node is not a satellite" };
    const bySource = new Map((this.proxyCatalog?.entities || []).map((item) => [String(item.source_entity_id), item]));
    const changed = [];
    for (const state of Array.isArray(states) ? states : []) {
      const descriptor = bySource.get(String(state?.source_entity_id || ""));
      const attributes = proxyAttributes(state?.attributes);
      if (!descriptor || !Object.keys(attributes).length) continue;
      descriptor.attributes = { ...(descriptor.attributes || {}), ...attributes };
      changed.push({ local_id: descriptor.local_id, attributes });
    }
    if (changed.length) {
      this.proxyCatalog.updated_at = utcNow();
      for (const listener of this.proxyStateListeners) {
        try { listener(changed); } catch (error) { log.error("Proxy state listener failed:", error); }
      }
      this.#scheduleProxySave();
    }
    return { success: true, applied: changed.length };
  }

  // Persisting the catalog on every state change would wear the Remote's flash storage; states are written at most
  // every few seconds (and on shutdown) so a restarted driver starts from recent values.
  #scheduleProxySave() {
    if (this.proxySaveTimer) return;
    this.proxySaveTimer = setTimeout(() => this.#flushProxySave(), PROXY_STATE_SAVE_INTERVAL_MS);
    this.proxySaveTimer.unref?.();
  }

  #flushProxySave() {
    if (!this.proxySaveTimer) return;
    clearTimeout(this.proxySaveTimer);
    this.proxySaveTimer = null;
    try { this.proxyStore.save(this.proxyCatalog); } catch (error) { log.warn("Could not persist proxy states:", error.message); }
  }

  #scheduleProxyStateRefresh(delayMs = 0) {
    clearTimeout(this.proxyStateRefreshTimer);
    this.proxyStateRefreshTimer = setTimeout(() => {
      this.proxyStateRefreshTimer = null;
      this.refreshProxyStates().catch((error) => log.debug("Proxy state refresh failed:", error.message));
    }, delayMs);
    this.proxyStateRefreshTimer.unref?.();
  }

  // Satellite: ask the Primary for the current state of every proxied entity (after start-up or standby, when pushed
  // updates may have been missed). The Primary is not woken for this.
  async refreshProxyStates() {
    if (!this.config || this.config.role !== "child" || !this.proxyCatalog?.entities?.length) return { success: false };
    if (this.link?.connected) return { success: true, via: "link" };
    const pairing = this.config.pairing || {};
    if (!pairing.master_agent_url || !pairing.master_command_token) return { success: false };
    const response = await fetch(`${String(pairing.master_agent_url).replace(/\/$/, "")}/v1/proxy/states`, {
      headers: { Authorization: `Bearer ${pairing.master_command_token}` },
      signal: AbortSignal.timeout(15_000)
    });
    if ([404, 405].includes(response.status)) { log.info("The Primary does not serve live proxy states yet; update Remote Sync on the Primary"); return { success: false }; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const result = this.applyProxyStates(body?.states || []);
    log.info(`Refreshed ${result.applied} proxy entity state(s) from the Primary`);
    return result;
  }

  // Primary: proxied source entities before the first snapshot of this run (the snapshot replaces the list).
  async #loadRelaySources() {
    if (!this.client || this.config?.role !== "master" || this.stateRelay.sources.size) return;
    const sections = new Set(this.config.sync.sections || []);
    const items = await this.client.listPaginated("/entities");
    const entities = items.filter((item) => {
      const id = String(item?.entity_id || item?.id || "");
      const type = String(item?.entity_type || "").toLowerCase();
      if (!id || id.startsWith("remote_sync.main.") || ["activity", "macro"].includes(type)) return false;
      return type === "remote" ? sections.has("remotes") : sections.has("entities");
    });
    if (this.stateRelay.sources.size) return;
    this.stateRelay.setSnapshot({ data: { entities: entities.filter((item) => String(item.entity_type).toLowerCase() !== "remote"), remotes: entities.filter((item) => String(item.entity_type).toLowerCase() === "remote").map((item) => ({ source_id: item.entity_id || item.id })) } });
  }

  previewSync(peerId = null) {
    return this.syncNow(true, { dryRun: true, peerId });
  }

  listSatellites(refresh = false) {
    return refresh ? this.satelliteManager.refresh() : this.satelliteManager.list();
  }

  manageSatellite(peerId, action) {
    return this.satelliteManager.action(peerId, action);
  }

  async reconcile() {
    if (!this.config || !this.client) return { success: false, error: "Remote Sync is not configured" };
    if (this.config.role === "master") return this.syncNow(true);
    if (this.config.role === "child" && this.config.pairing?.paired_master_id) {
      this.link?.nudge();
      setTimeout(() => { if (!this.link?.connected) this.#scheduleProxyStateRefresh(0); }, 10_000).unref?.();
    }
    try {
      const { ready, bad } = await this.client.ready();
      this.status.state = ready ? "connected" : `degraded: ${JSON.stringify(bad)}`;
      this.#notify();
      return { success: ready, bad_integration_states: bad };
    } catch (error) { this.status.state = `unreachable: ${error.message}`; this.#notify(); return { success: false, error: error.message }; }
  }

  // -------------------------------------------------------------------------
  // Remote information, PIN verification and dashboard operations
  // -------------------------------------------------------------------------

  setRemoteInfo(info) {
    this.remoteInfo = info || null;
  }

  // Set by the driver: reads the Remote's runtime information over the Integration API.
  setRuntimeInfoProvider(provider) { this.runtimeInfoProvider = provider; }

  // Whether the Remote has an integration instance for Remote Sync. Without one (setup closed before "Done") the Remote
  // stops the driver as soon as the setup session ends, and with it the agent the Satellites talk to.
  async setupFinished() {
    if (!this.runtimeInfoProvider) return null;
    try {
      const runtime = await this.runtimeInfoProvider();
      if (!runtime || !Array.isArray(runtime.intg_ids)) return null;
      return runtime.intg_ids.length > 0;
    } catch { return null; }
  }

  // Verify a Core API key presented by a Primary during IP + PIN pairing. The key must be an admin key of this
  // remote's own Core, which only someone holding the Web Configurator PIN can create. An unassigned installation
  // becomes a Satellite at this point.
  async verifyCoreKey(coreKey) {
    if (!this.config || !["child", "unassigned"].includes(this.config.role)) return false;
    const client = new CoreClient({ ...this.config.remote, api_key: String(coreKey), mac: null, broadcasts: [] }, { requestTimeoutMs: 5000 });
    try {
      await client.getJson("/auth/api_keys", { params: { limit: 1 }, wakeOnUnavailable: false });
      return true;
    } catch (error) {
      if (!(error instanceof CoreApiError) || ![401, 403].includes(error.status)) log.warn("PIN pairing key verification failed:", error.message);
      return false;
    } finally {
      await client.close();
    }
  }

  async pinPair(coreKey) {
    if (!await this.verifyCoreKey(coreKey)) return null;
    log.info("PIN pairing request verified against this remote's Core");
    if (this.config.role === "unassigned") {
      const saved = this.#assignRoleNow("child");
      return { agent_token: saved.agent_token, role: "child", identifier: saved.pairing_identifier, ready_to_pair: true, assigned: true };
    }
    return { agent_token: this.config.agent_token };
  }

  // -------------------------------------------------------------------------
  // Role and settings (configured in the web dashboard)
  // -------------------------------------------------------------------------

  #assignRoleNow(role, { name = null } = {}) {
    if (!this.config) throw new Error("Remote Sync is not set up; run the integration setup with the PIN first");
    if (!["master", "child"].includes(role)) throw new Error("role must be primary or satellite");
    const next = structuredClone(this.config);
    next.role = role;
    if (name) next.node_name = String(name).trim().slice(0, 64) || next.node_name;
    next.peers = role === "master" ? (next.peers || []) : [];
    next.pairing = { ready_to_pair: role === "child", paired_master_id: null, paired_master_name: null, paired_at: null, master_agent_url: null, master_command_token: null, master_mac: null, master_broadcasts: [] };
    if (role === "child") {
      next.pairing_identifier = isPairingIdentifier(next.pairing_identifier) ? next.pairing_identifier : generatePairingIdentifier();
      next.sync = { ...next.sync, auto_sync: false };
    } else {
      next.pairing_identifier = null;
      const hasDockToken = Boolean(next.physical_docks?.default_token || Object.keys(next.physical_docks?.tokens || {}).length);
      const sections = (next.sync?.sections || DEFAULT_SECTIONS).filter((section) => hasDockToken || section !== "docks");
      next.sync = { ...next.sync, sections: sections.length ? sections : DEFAULT_SECTIONS.filter((section) => section !== "docks"), auto_sync: true };
    }
    const saved = this.store.save(next);
    log.info(`Role set to ${role === "master" ? "Primary" : "Satellite"}`);
    this.#deferReconfigure(saved);
    return saved;
  }

  async assignRole(role, options = {}) {
    if (this.config?.role !== "unassigned") throw new Error("A role is already set. Reset the role in Settings first.");
    const normalized = role === "primary" ? "master" : role === "satellite" ? "child" : role;
    const saved = this.#assignRoleNow(normalized, options);
    return { success: true, role: saved.role === "master" ? "primary" : "satellite" };
  }

  async resetRole() {
    if (!this.config || this.config.role === "unassigned") throw new Error("No role is set");
    if (this.config.role === "child" && this.config.pairing?.paired_master_id) {
      log.warn(`Resetting a Satellite that is paired with ${this.config.pairing.paired_master_name || this.config.pairing.paired_master_id}`);
    }
    const next = structuredClone(this.config);
    next.role = "unassigned";
    next.peers = [];
    next.pairing_identifier = null;
    next.pairing = { ready_to_pair: false };
    next.agent_token = secureToken();
    const saved = this.store.save(next);
    this.proxyStore.clear();
    this.#deferReconfigure(saved);
    return { success: true };
  }

  generalSettings() {
    if (!this.config) return null;
    const docks = this.config.physical_docks || {};
    return {
      role: this.config.role === "master" ? "primary" : this.config.role === "child" ? "satellite" : "unassigned",
      node_name: this.config.node_name,
      agent_public_url: this.config.agent_public_url || "",
      remote: { host: this.config.remote.host, port: this.config.remote.port || null, scheme: this.config.remote.scheme },
      network: {
        interface: this.config.remote.interface || null,
        mac: this.config.remote.mac || null,
        broadcasts: this.config.remote.broadcasts || [],
        source: this.config.remote.network_source || null,
        mac_override: this.config.network_overrides?.mac || "",
        broadcast_overrides: (this.config.network_overrides?.broadcasts || []).join(", ")
      },
      docks: { default_token_set: Boolean(docks.default_token), dock_ids: Object.keys(docks.tokens || {}) },
      sync: this.syncSettings()
    };
  }

  async updateGeneralSettings(patch = {}) {
    if (!this.config) throw new Error("Remote Sync is not set up");
    const next = structuredClone(this.config);
    if (patch.node_name !== undefined) {
      const name = String(patch.node_name || "").trim();
      if (!name) throw new Error("The name cannot be empty");
      next.node_name = name.slice(0, 64);
    }
    if (patch.agent_public_url !== undefined) next.agent_public_url = String(patch.agent_public_url || "").trim() || null;
    if (patch.dock_tokens !== undefined && String(patch.dock_tokens).trim()) {
      next.physical_docks = physicalDockTokens(patch.dock_tokens, next.physical_docks);
    }
    if (patch.clear_dock_tokens === true) next.physical_docks = { default_token: "", tokens: {} };
    let redetect = false;
    if (patch.mac_override !== undefined || patch.broadcast_overrides !== undefined) {
      const overrides = networkOverrides({
        network_mac_override: patch.mac_override ?? next.network_overrides?.mac ?? "",
        network_broadcast_overrides: patch.broadcast_overrides ?? (next.network_overrides?.broadcasts || []).join(",")
      });
      next.network_overrides = overrides;
      redetect = true;
    }
    if (redetect) {
      const network = await detectRemoteNetworkIdentity({
        host: next.remote.host,
        fallbackMac: next.remote.mac,
        fallbackBroadcasts: next.remote.broadcasts,
        macOverride: next.network_overrides.mac,
        broadcastsOverride: next.network_overrides.broadcasts,
        preferWireless: true
      });
      Object.assign(next.remote, { mac: network.mac, broadcasts: network.broadcasts, interface: network.interface, network_source: network.source });
    }
    const saved = this.store.save(next);
    this.#deferReconfigure(saved);
    return { success: true, settings: { ...this.generalSettings(), node_name: saved.node_name } };
  }

  async discoverSatellites() {
    if (this.config?.role !== "master") return [];
    const paired = new Set((this.config.peers || []).map((peer) => normalizePairingIdentifier(peer.identifier)));
    let found = [];
    try { found = await this.discovery.discoverReady(); }
    catch (error) { log.warn("Satellite discovery failed:", error.message); }
    return found
      .filter((item) => !paired.has(normalizePairingIdentifier(item.identifier)))
      .map((item) => ({ identifier: item.identifier, name: item.name || item.identifier, address: item.address || item.hostname || null, url: item.url || null, version: item.version || item.protocol?.version || null }));
  }

  async addSatelliteByToken({ address, port = null, token, name = null } = {}) {
    if (!this.config || this.config.role !== "master") throw new Error("Satellites can only be added on a Primary");
    const config = this.config;
    const requiredCapabilities = ["proxy_entities"];
    if (config.sync.sections.includes("docks")) requiredCapabilities.push("dock_tunnel");
    try {
      const satellite = await inspectManualSatellite({
        address, port, token, name,
        masterId: config.node_id,
        masterName: config.node_name,
        requiredCapabilities,
        existingPeers: config.peers
      });
      const peer = await this.#claimSatellite(satellite, String(token).trim(), {});
      return { success: true, peer_id: peer.peer_id, name: peer.name };
    } catch (error) {
      log.warn("Adding a Satellite by token failed:", error.message);
      return { success: false, error: error.message };
    }
  }

  async #claimSatellite(satellite, token, management) {
    const config = this.config;
    const peerId = `rms-${normalizePairingIdentifier(satellite.identifier).toLowerCase()}`;
    const existing = config.peers.find((peer) => peer.peer_id === peerId) || null;
    const commandToken = existing?.command_token || secureToken();
    const client = new PeerAgentClient(satellite.url, token);
    const claimed = await client.claim({
      master_id: config.node_id,
      master_name: config.node_name,
      master_agent_url: reachableAgentUrl(config),
      master_command_token: commandToken,
      master_mac: config.remote.mac || null,
      master_broadcasts: config.remote.broadcasts || []
    });
    const next = structuredClone(config);
    const peer = {
      peer_id: peerId,
      identifier: satellite.identifier,
      name: satellite.name,
      url: satellite.url,
      token,
      mac: claimed.mac || satellite.mac || existing?.mac || null,
      broadcasts: claimed.broadcasts?.length ? claimed.broadcasts : (satellite.broadcasts || []),
      enabled: true,
      child_node_id: claimed.node_id || satellite.node_id || null,
      claimed_at: claimed.paired_at || utcNow(),
      command_token: commandToken,
      protocol: satellite.protocol || null,
      core_api_key: management.coreApiKey || existing?.core_api_key || null,
      core_key_name: management.coreKeyName || (management.coreApiKey ? null : existing?.core_key_name) || null,
      core_host: management.host || existing?.core_host || null,
      core_scheme: management.scheme || existing?.core_scheme || null,
      core_port: management.port || existing?.core_port || null
    };
    // Re-adding a managed Satellite creates a new management key; revoke the previous one.
    if (management.coreApiKey && existing?.core_key_name && existing.core_key_name !== management.coreKeyName) {
      revokeManagementKey(existing, { resolvedUrl: satellite.url }).catch(() => {});
    }
    const index = next.peers.findIndex((item) => item.peer_id === peerId);
    if (index >= 0) next.peers[index] = { ...next.peers[index], ...peer };
    else next.peers.push(peer);
    const saved = this.store.save(next);
    this.#deferReconfigure(saved);
    return peer;
  }

  async verifyUiPin(pin) {
    if (!this.config) return false;
    const remote = this.config.remote;
    return CoreClient.verifyWebConfiguratorPin(remote.host, pin, { scheme: remote.scheme, port: remote.port });
  }

  async wakeOnWlanState() {
    if (!this.client) return null;
    try { return await this.client.wakeOnWlan(); } catch { return null; }
  }

  async enableWakeOnWlan() {
    if (!this.client) throw new Error("Remote Sync is not configured");
    await this.client.setWakeOnWlan(true);
    return { success: true, wake_on_wlan: await this.wakeOnWlanState() };
  }

  syncSettings() {
    if (!this.config) return null;
    return {
      ...structuredClone(this.config.sync),
      available_sections: [...SUPPORTED_SECTIONS],
      available_settings_categories: Object.values(SETTINGS_CATEGORIES).map(({ label }, index) => ({ id: Object.keys(SETTINGS_CATEGORIES)[index], label }))
    };
  }

  async updateSyncSettings(patch = {}) {
    if (!this.config || this.config.role !== "master") throw new Error("Settings can only be changed on a configured Primary");
    const next = structuredClone(this.config);
    const sync = next.sync;
    if (patch.sections !== undefined) {
      if (!Array.isArray(patch.sections)) throw new Error("sections must be a list");
      sync.sections = SUPPORTED_SECTIONS.filter((section) => patch.sections.includes(section));
      if (!sync.sections.length) throw new Error("Enable at least one synchronization section");
      if (sync.sections.includes("docks") && !next.physical_docks?.default_token && !Object.keys(next.physical_docks?.tokens || {}).length) {
        throw new Error("Dock synchronization needs a physical Dock API token; set it in the integration setup first");
      }
    }
    if (patch.settings_categories !== undefined) {
      if (!Array.isArray(patch.settings_categories)) throw new Error("settings_categories must be a list");
      sync.settings_categories = normalizeSettingsCategories(patch.settings_categories);
      if (sync.sections.includes("settings") && !sync.settings_categories.length) throw new Error("Choose at least one kind of device setting, or turn off device settings");
    }
    if (patch.interval_seconds !== undefined) {
      const interval = Number(patch.interval_seconds);
      if (!Number.isFinite(interval) || interval < 300 || interval > 86_400) throw new Error("The interval must be between 300 and 86400 seconds");
      sync.interval_seconds = Math.round(interval);
    }
    for (const key of ["auto_sync", "prune", "use_standby_inhibitor", "verify_existing_resource_hashes", "auto_update_satellites"]) {
      if (patch[key] !== undefined) sync[key] = Boolean(patch[key]);
    }
    const saved = this.store.save(next);
    this.#deferReconfigure(saved);
    return { success: true, sync: saved.sync };
  }

  #deferReconfigure(config) {
    // Dashboard requests are served by the agent server that configure() restarts, so answer first. The saved
    // configuration becomes current at once so a following change in the same request builds on it.
    this.config = config;
    clearTimeout(this.reconfigureTimer);
    this.reconfigureTimer = setTimeout(() => {
      this.reconfigureTimer = null;
      this.configure(this.config).catch((error) => log.error("Reconfiguration failed:", error));
    }, 250);
    this.reconfigureTimer.unref?.();
  }

  provisioningStatus() {
    return [...this.provisioning.values()];
  }

  async addSatelliteByPin({ address, pin, name = null, install = true, httpPort = null, agentPort = null } = {}) {
    if (!this.config || this.config.role !== "master") throw new Error("Satellites can only be added on a configured Primary");
    const key = String(address || "").trim().toLowerCase();
    if (!key) throw new Error("Enter the Satellite address");
    if (this.provisioning.has(key) && this.provisioning.get(key).state === "running") throw new Error("This Satellite is already being added");
    const job = { address: key, state: "running", started_at: utcNow(), steps: [], error: null, peer_id: null };
    this.provisioning.set(key, job);
    this.#notify();
    const progress = (message) => { job.steps.push({ at: utcNow(), message }); log.info(`[${key}] ${message}`); this.#notify(); };
    try {
      const config = this.config;
      const provisioned = await provisionSatelliteByPin({ address, pin, install, httpPort, agentPort, primaryName: config.node_name, onProgress: progress });
      const requiredCapabilities = ["proxy_entities"];
      if (config.sync.sections.includes("docks")) requiredCapabilities.push("dock_tunnel");
      const satellite = await inspectManualSatellite({
        address: provisioned.agentUrl,
        token: provisioned.token,
        name: name || provisioned.deviceName,
        masterId: config.node_id,
        masterName: config.node_name,
        requiredCapabilities,
        existingPeers: config.peers
      });
      progress("Claiming the Satellite");
      const peer = await this.#claimSatellite(satellite, provisioned.token, provisioned);
      const peerId = peer.peer_id;
      Object.assign(job, { state: "done", peer_id: peerId, finished_at: utcNow(), installation: provisioned.installation, wake_on_wlan: provisioned.wakeOnWlan });
      progress(`Added ${peer.name}`);
      return { success: true, peer_id: peerId, name: peer.name, installation: provisioned.installation, wake_on_wlan: provisioned.wakeOnWlan };
    } catch (error) {
      Object.assign(job, { state: "error", error: error.message, finished_at: utcNow() });
      log.warn(`Adding Satellite ${key} failed:`, error.message);
      this.#notify();
      return { success: false, error: error.message };
    }
  }

  // Read-only data for the dashboard's Remote UI preview: what a Satellite will show after the next synchronization,
  // taken from the Primary's latest snapshot (built by a preview or synchronization).
  simulatorModel() {
    const snapshot = this.syncCoordinator.cachedSnapshot();
    const manifest = snapshot?.manifest;
    if (!manifest) return { available: false };
    const data = manifest.data || {};
    const strip = (value) => {
      if (!value || typeof value !== "object") return value;
      const copy = { ...value };
      delete copy.integration_id;
      return copy;
    };
    const internal = (records, type) => (records || []).map((record) => ({ ...strip(record.detail || {}), entity_id: String(record.source_id), entity_type: type }));
    const profiles = (data.profiles?.items || []).map((record) => ({
      profile_id: String(record.source_id),
      name: record.detail?.name || record.source_id,
      icon: record.detail?.icon || null,
      pages: record.pages || [],
      groups: record.groups || []
    }));
    const active = data.profiles?.active;
    return {
      available: true,
      generated_at: manifest.created_at,
      source_name: manifest.source_name,
      sections: manifest.sections,
      active_profile_id: String(active?.profile_id || active?.id || active?.profile?.profile_id || profiles[0]?.profile_id || ""),
      profiles,
      entities: (data.entities || []).map(strip),
      activities: internal(data.activities, "activity"),
      macros: internal(data.macros, "macro"),
      remotes: internal(data.remotes, "remote")
    };
  }

  async primaryResource(type, id) {
    if (!this.client || this.config?.role !== "master") throw new Error("Resources are only available on a Primary");
    return this.client.bytes("GET", `/resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, { expected: [200], timeoutMs: 15_000, wakeOnUnavailable: false });
  }

  async removeSatellite(peerId) {
    return this.satelliteManager.action(peerId, "remove");
  }

  statusPayload() {
    return {
      configured: Boolean(this.config),
      config: redactConfig(this.config),
      status: structuredClone(this.status),
      agent_url: this.agentUrl,
      proxy_count: this.proxyCatalog?.entities?.length || 0,
      applied_change_hash: this.config?.role === "child" ? (this.proxyCatalog?.applied_change_hash || null) : null,
      satellites: this.config?.role === "master" ? this.satelliteManager.list().map((item) => ({ ...item, link: this.linkHub?.status(item.peer_id) || { connected: false } })) : [],
      link: this.config?.role === "child" ? (this.link?.status() || { connected: false }) : null,
      drift: this.config?.role === "child" ? (this.driftGuard?.status() || null) : null,
      hardware: this.hardwareProfile,
      virtual_docks: this.virtualDockServer?.status() || null,
      dock_tunnels: this.dockTunnelSessions.size,
      version: APP_VERSION,
      remote: this.remoteInfo?.version ? { api: this.remoteInfo.version.api || null, core: this.remoteInfo.version.core || null, model: this.remoteInfo.version.model || null } : null,
      runtime: this.remoteInfo?.runtime || null
    };
  }
  get agentUrl() {
    if (!this.config) return null;
    if (this.config.agent_public_url) return this.config.agent_public_url;
    if (this.config.role === "child" && this.config.pairing_identifier) return defaultPairingUrl(this.config.pairing_identifier, this.config.agent_port);
    return reachableAgentUrl(this.config) || `http://${this.config.remote.host}:${this.config.agent_port}`;
  }
  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  #notifyProxy() { for (const listener of this.proxyListeners) { try { listener(this.proxyCatalog); } catch (error) { log.error("Proxy listener failed:", error); } } }
  #notify() { for (const listener of this.listeners) { try { listener(this.status, this.config); } catch (error) { log.error("Status listener failed:", error); } } }
}
