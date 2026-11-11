import crypto from "node:crypto";
import { PeerAgentClient } from "./peer-agent-client.js";
import fs from "node:fs";
import path from "node:path";
import { dataHome } from "../shared/paths.js";
import { atomicWriteJson, compareVersions, readJson, secureToken, utcNow } from "../shared/util.js";
import { APP_VERSION } from "../shared/constants.js";
import { revokeManagementKey, updateSatellite } from "./satellite-provisioner.js";
import { logger } from "../shared/logger.js";

const log = logger("satellite-manager");

// -----------------------------------------------------------------------------
// Satellite runtime management
// -----------------------------------------------------------------------------

function runtimeDefaults() {
  return {
    online: false,
    version: null,
    protocol: null,
    last_seen_at: null,
    last_error: null,
    mirrored_entities: 0,
    dock_tunnels: 0,
    last_sync_at: null,
    last_sync_result: null,
    last_applied_hash: null, last_applied_change_hash: null, last_attempted_hash: null, consecutive_failures: 0, next_retry_at: null
  };
}

export class SatelliteManager {
  constructor({ getConfig, store, resolvePeer, syncPeer, previewPeer = null, notify, updater = updateSatellite, syncedResources = () => [], clientFactory = (url, token) => new PeerAgentClient(url, token), keyRevoker = revokeManagementKey }) {
    this.getConfig = getConfig;
    this.store = store;
    this.resolvePeer = resolvePeer;
    this.syncPeer = syncPeer;
    this.previewPeer = previewPeer;
    this.notify = notify;
    this.updater = updater;
    this.syncedResources = syncedResources;
    this.clientFactory = clientFactory;
    this.keyRevoker = keyRevoker;
    this.updating = new Set();
    this.runtimeFile = path.join(dataHome(), "peer-runtime.json");
    this.runtime = new Map(Object.entries(readJson(this.runtimeFile, {})));
    this.persistTimer = null;
  }

  record(peerId, values = {}) {
    const current = this.runtime.get(peerId) || runtimeDefaults();
    const next = { ...current, ...values };
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    this.runtime.set(peerId, next);
    clearTimeout(this.persistTimer); this.persistTimer = setTimeout(() => { atomicWriteJson(this.runtimeFile, Object.fromEntries(this.runtime)); }, 250); this.persistTimer.unref?.();
    this.notify?.();
  }

  list() {
    const config = this.getConfig();
    return (config?.peers || []).map((peer) => ({
      peer_id: peer.peer_id,
      identifier: peer.identifier,
      name: peer.name,
      enabled: peer.enabled !== false,
      url: peer.url,
      mac: peer.mac,
      broadcasts: peer.broadcasts || [],
      child_node_id: peer.child_node_id,
      claimed_at: peer.claimed_at,
      managed: Boolean(peer.core_api_key),
      updating: this.updating.has(peer.peer_id),
      ...runtimeDefaults(),
      ...(this.runtime.get(peer.peer_id) || {})
    }));
  }

  async refresh(peerId = null) {
    const config = this.getConfig();
    const peers = (config?.peers || []).filter((peer) => !peerId || peer.peer_id === peerId);
    let configChanged = false;
    for (let start = 0; start < peers.length; start += 2) await Promise.all(peers.slice(start, start + 2).map(async (peer) => {
      try {
        const destination = await this.resolvePeer(peer, true);
        const client = new PeerAgentClient(destination.url, peer.token);
        const protocol = await client.capabilities();
        const status = await client.status();
        if (JSON.stringify(peer.protocol) !== JSON.stringify(protocol)) { peer.protocol = protocol; configChanged = true; }
        const remoteConfig = status?.config?.remote || {};
        if (remoteConfig.mac && peer.mac !== String(remoteConfig.mac)) { peer.mac = String(remoteConfig.mac); configChanged = true; }
        if (Array.isArray(remoteConfig.broadcasts) && remoteConfig.broadcasts.length) { const nextBroadcasts = remoteConfig.broadcasts.map(String); if (JSON.stringify(peer.broadcasts || []) !== JSON.stringify(nextBroadcasts)) { peer.broadcasts = nextBroadcasts; configChanged = true; } }
        this.record(peer.peer_id, {
          online: true,
          version: protocol.version,
          protocol,
          last_seen_at: utcNow(),
          last_error: null,
          mirrored_entities: Number(status?.proxy_count || status?.status?.proxy_count || status?.proxy_catalog?.entities || status?.config?.proxy_count || 0),
          dock_tunnels: Number(status?.dock_tunnels || 0),
          last_sync_at: status?.status?.last_sync_at || null,
          last_sync_result: status?.status?.last_sync_result || null,
          url: destination.url,
          last_applied_hash: status?.status?.last_snapshot_hash || null,
          last_applied_change_hash: status?.applied_change_hash || null
        });
      } catch (error) {
        this.record(peer.peer_id, { online: false, last_error: error.message });
      }
    }));
    if (config && configChanged) this.store.save(config);
    if (config?.sync?.auto_update_satellites !== false) await this.autoUpdate(peers);
    return this.list();
  }

  // Satellites paired by address and PIN keep a management key, which lets the Primary install its own version on
  // them. This replaces the manual "update Satellites before the Primary" rolling-upgrade procedure.
  async autoUpdate(peers = null) {
    const config = this.getConfig();
    const candidates = (peers || config?.peers || []).filter((peer) => {
      if (!peer.enabled || !peer.core_api_key || this.updating.has(peer.peer_id)) return false;
      const runtime = this.runtime.get(peer.peer_id) || {};
      if (runtime.update_attempted_version === APP_VERSION) return false;
      const version = runtime.version || peer.protocol?.version;
      return version && version !== "legacy" && compareVersions(version, APP_VERSION) < 0;
    });
    const results = [];
    for (const peer of candidates) {
      log.info(`Satellite ${peer.name} runs Remote Sync ${(this.runtime.get(peer.peer_id) || {}).version}; updating to ${APP_VERSION}`);
      results.push(await this.update(peer).catch((error) => ({ success: false, error: error.message })));
    }
    return results;
  }

  async update(peer) {
    if (this.updating.has(peer.peer_id)) return { success: false, error: "An update is already running" };
    this.updating.add(peer.peer_id);
    this.record(peer.peer_id, { last_update_result: `Updating to ${APP_VERSION}` });
    this.notify?.();
    try {
      const runtime = this.runtime.get(peer.peer_id) || {};
      const result = await this.updater(peer, { resolvedUrl: runtime.url || peer.url });
      this.record(peer.peer_id, {
        last_update_at: utcNow(),
        last_update_result: result.action === "current" ? `Already on ${result.version}` : `${result.action === "installed" ? "Installed" : "Updated to"} ${result.version}`,
        update_attempted_version: APP_VERSION,
        version: result.version || runtime.version
      });
      return { success: true, ...result };
    } catch (error) {
      log.warn(`Updating ${peer.name} failed:`, error.message);
      this.record(peer.peer_id, { last_update_at: utcNow(), last_update_result: `Update failed: ${error.message}`, update_attempted_version: APP_VERSION });
      return { success: false, error: error.message };
    } finally {
      this.updating.delete(peer.peer_id);
      this.notify?.();
    }
  }

  async action(peerId, action) {
    const config = this.getConfig();
    if (!config || config.role !== "master") throw new Error("Satellite management is only available on a primary");
    const index = config.peers.findIndex((peer) => peer.peer_id === peerId);
    if (index < 0) throw new Error(`Unknown satellite ${peerId}`);
    const peer = config.peers[index];

    if (action === "sync") {
      const result = await this.syncPeer(peer, true);
      this.record(peer.peer_id, {
        online: Boolean(result?.success),
        last_seen_at: result?.success ? utcNow() : null,
        last_error: result?.success ? null : (result?.error || "Synchronization failed"),
        last_sync_at: utcNow(),
        last_sync_result: result?.success ? "Synchronized" : (result?.error || "Synchronization failed")
      });
      return result;
    }
    if (action === "preview") {
      if (!this.previewPeer) throw new Error("Synchronization preview is unavailable");
      return this.previewPeer(peer);
    }
    if (action === "update") {
      const result = await this.update(peer);
      if (result.success) await this.refresh(peerId).catch(() => {});
      return result;
    }
    if (action === "enable" || action === "disable") {
      peer.enabled = action === "enable";
      this.store.save(config);
      this.notify?.();
      return { success: true, enabled: peer.enabled };
    }
    if (action === "rediscover") {
      const destination = await this.resolvePeer(peer, true);
      if (!peer.identifier) peer.url = destination.url;
      this.store.save(config);
      await this.refresh(peerId);
      return { success: true, url: destination.url };
    }
    if (action === "rotate") {
      const destination = await this.resolvePeer(peer, true);
      const nextCommandToken = secureToken();
      const client = new PeerAgentClient(destination.url, peer.token);
      await client.capabilities({ requiredCapabilities: ["credential_rotation"] });
      const result = await client.rotate({
        master_id: config.node_id,
        master_command_token: nextCommandToken,
        nonce: crypto.randomUUID()
      });
      peer.token = String(result.agent_token || "");
      peer.command_token = nextCommandToken;
      if (!peer.token) throw new Error("Satellite did not return its rotated credential");
      this.store.save(config);
      this.record(peer.peer_id, { last_error: null, last_seen_at: utcNow() });
      return { success: true };
    }
    if (action === "unpair" || action === "remove") {
      let purge = null;
      try {
        const destination = await this.resolvePeer(peer, true);
        const client = this.clientFactory(destination.url, peer.token);
        if (action === "remove") {
          // Removing a Satellite deletes everything this Primary synchronized to it before unpairing.
          const protocol = await client.capabilities().catch(() => null);
          if (protocol && !protocol.capabilities.includes("purge_on_remove")) {
            purge = { success: false, skipped: true, error: `The Satellite runs Remote Sync ${protocol.version}, which cannot remove synchronized configuration; update it first or remove the objects manually` };
          } else {
            try {
              purge = await client.purge({ master_id: config.node_id, resources: this.syncedResources() });
            } catch (error) {
              purge = { success: false, error: `Synchronized configuration was not removed: ${error.message}` };
            }
          }
          log.info(`Removing ${peer.name}: ${purge?.success ? `deleted ${purge.removed} synchronized object(s)` : purge?.error || "purge failed"}`);
        }
        await client.unpair({ master_id: config.node_id });
      } catch (error) {
        if (action === "unpair") throw error;
        purge ||= { success: false, error: `The Satellite was not reachable, so its synchronized configuration was not removed: ${error.message}` };
      }
      if (action === "remove") {
        // The management key this Primary created on the Satellite is no longer needed.
        try { await this.keyRevoker(peer, { resolvedUrl: (this.runtime.get(peer.peer_id) || {}).url || peer.url }); }
        catch (error) { log.warn(`Could not revoke the management key on ${peer.name}:`, error.message); }
        config.peers.splice(index, 1);
        this.runtime.delete(peer.peer_id);
      } else {
        peer.claimed_at = null;
        peer.child_node_id = null;
        peer.enabled = false;
      }
      this.store.save(config);
      this.notify?.();
      return action === "remove"
        ? { success: true, removed: true, purge, warning: purge && !purge.success ? purge.error : (purge?.remaining ? `${purge.remaining} object(s) could not be removed` : null) }
        : { success: true, removed: false };
    }
    throw new Error(`Unsupported satellite action ${action}`);
  }
}
