import crypto from "node:crypto";
import { PeerAgentClient } from "./peer-agent-client.js";
import { secureToken, utcNow } from "../shared/util.js";

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
    last_sync_result: null
  };
}

export class SatelliteManager {
  constructor({ getConfig, store, resolvePeer, syncPeer, previewPeer = null, notify }) {
    this.getConfig = getConfig;
    this.store = store;
    this.resolvePeer = resolvePeer;
    this.syncPeer = syncPeer;
    this.previewPeer = previewPeer;
    this.notify = notify;
    this.runtime = new Map();
  }

  record(peerId, values = {}) {
    const current = this.runtime.get(peerId) || runtimeDefaults();
    this.runtime.set(peerId, { ...current, ...values });
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
      ...runtimeDefaults(),
      ...(this.runtime.get(peer.peer_id) || {})
    }));
  }

  async refresh(peerId = null) {
    const config = this.getConfig();
    const peers = (config?.peers || []).filter((peer) => !peerId || peer.peer_id === peerId);
    await Promise.all(peers.map(async (peer) => {
      try {
        const destination = await this.resolvePeer(peer, true);
        const client = new PeerAgentClient(destination.url, peer.token);
        const protocol = await client.capabilities();
        const status = await client.status();
        peer.protocol = protocol;
        const remoteConfig = status?.config?.remote || {};
        if (remoteConfig.mac) peer.mac = String(remoteConfig.mac);
        if (Array.isArray(remoteConfig.broadcasts) && remoteConfig.broadcasts.length) peer.broadcasts = remoteConfig.broadcasts.map(String);
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
          url: destination.url
        });
      } catch (error) {
        this.record(peer.peer_id, { online: false, last_error: error.message });
      }
    }));
    if (config) this.store.save(config);
    return this.list();
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
      try {
        const destination = await this.resolvePeer(peer, true);
        const client = new PeerAgentClient(destination.url, peer.token);
        await client.unpair({ master_id: config.node_id });
      } catch (error) {
        if (action === "unpair") throw error;
      }
      if (action === "remove") {
        config.peers.splice(index, 1);
        this.runtime.delete(peer.peer_id);
      } else {
        peer.claimed_at = null;
        peer.child_node_id = null;
        peer.enabled = false;
      }
      this.store.save(config);
      this.notify?.();
      return { success: true, removed: action === "remove" };
    }
    throw new Error(`Unsupported satellite action ${action}`);
  }
}
