import { SnapshotBuilder } from "../protocol/snapshot.js";
import { PeerAgentClient } from "./peer-agent-client.js";
import { isTransportError, reachableAgentUrl, sleep } from "../shared/util.js";
import { sendMagicPacket } from "../network/wol.js";
import { WAKE_RETRY_SCHEDULE_MS, WAKE_TIMEOUT_MS } from "../shared/constants.js";
import { logger } from "../shared/logger.js";

const log = logger("sync-coordinator");

// -----------------------------------------------------------------------------
// Primary-to-Satellite snapshot transport
// -----------------------------------------------------------------------------

export class SyncCoordinator {
  constructor({
    getConfig,
    getClient,
    getStatus,
    discovery,
    setDockCatalog,
    initializeActivityStates
  }) {
    this.getConfig = getConfig;
    this.getClient = getClient;
    this.getStatus = getStatus;
    this.discovery = discovery;
    this.setDockCatalog = setDockCatalog;
    this.initializeActivityStates = initializeActivityStates;
    this.cache = null;
  }

  invalidateCache() { this.cache = null; }

  cachedSnapshot() { return this.cache; }

  async buildSnapshot({ force = false, shouldAbort = null } = {}) {
    if (!force && this.cache) return this.cache;
    const config = this.getConfig();
    const client = this.getClient();
    log.info("Building configuration snapshot");
    const snapshot = await new SnapshotBuilder(client, config, { shouldAbort }).build();
    const docks = new Map((snapshot.manifest.data.docks || [])
      .map((record) => [String(record?.source_id || record?.detail?.dock_id || record?.detail?.id || ""), record?.detail || {}])
      .filter(([dockId]) => dockId));
    this.setDockCatalog(docks);
    log.info(`Snapshot ${snapshot.manifest.operation_id} built (${snapshot.payload.length} bytes, hash ${snapshot.manifest.content_hash.slice(0, 12)})`);
    this.cache = snapshot;
    return snapshot;
  }

  async syncSinglePeer(peer, force = true) {
    const snapshot = await this.buildSnapshot({ force });
    if (!force && snapshot.manifest.content_hash === this.getStatus().last_snapshot_hash) {
      return { success: true, changed: false };
    }
    const result = await this.pushSnapshot(peer, snapshot.payload);
    if (result.success) await this.initializeActivityStates(peer, snapshot.manifest.data.activities || []);
    return result;
  }

  async resolvePeerUrl(peer, force = false) {
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
    throw Object.assign(new Error(`Satellite ${peer.name} has no pairing identifier or URL`), { code: "ENOTFOUND" });
  }

  async postSnapshot(peer, payload, { forceDiscovery = false } = {}) {
    const config = this.getConfig();
    const destination = await this.resolvePeerUrl(peer, forceDiscovery);
    const client = new PeerAgentClient(destination.url, peer.token, { timeoutMs: 180_000 });
    const protocol = await client.capabilities({ requiredCapabilities: ["proxy_entities"] });
    peer.protocol = protocol;
    const body = await client.snapshot(payload, {
      headers: {
        "X-Remote-Sync-Master-Url": reachableAgentUrl(config) || "",
        "X-Remote-Sync-Command-Token": peer.command_token || "",
        "X-Remote-Sync-Master-Mac": config.remote?.mac || "",
        "X-Remote-Sync-Master-Broadcasts": (config.remote?.broadcasts || []).join(",")
      }
    });
    const restartRequired = body.status === 202 && body.restart_required === true;
    const success = [200, 201].includes(body.status) && body.success !== false;
    if (!success && !restartRequired) log.warn(`Snapshot endpoint ${destination.url} returned HTTP ${body.status}:`, body);
    return {
      success,
      restart_required: restartRequired,
      status: body.status,
      report: body,
      destination: destination.url,
      discovered: destination.discovered,
      hostname: destination.hostname,
      protocol
    };
  }

  async previewPeer(peer, payload) {
    try {
      const config = this.getConfig();
      const destination = await this.resolvePeerUrl(peer, false);
      const client = new PeerAgentClient(destination.url, peer.token, { timeoutMs: 180_000 });
      const protocol = await client.capabilities({ requiredCapabilities: ["sync_preview"] });
      peer.protocol = protocol;
      const body = await client.snapshot(payload, {
        preview: true,
        headers: {
          "X-Remote-Sync-Master-Url": reachableAgentUrl(config) || "",
          "X-Remote-Sync-Command-Token": peer.command_token || "",
          "X-Remote-Sync-Master-Mac": config.remote?.mac || "",
          "X-Remote-Sync-Master-Broadcasts": (config.remote?.broadcasts || []).join(",")
        }
      });
      return { success: body.status === 200, status: body.status, preview: body, destination: destination.url, protocol };
    } catch (error) {
      return { success: false, error: error.message, details: error.details || undefined };
    }
  }

  async waitForRestartAndResend(peer, payload, initialResult) {
    log.info(`Satellite ${peer.name} accepted a new proxy catalog and is restarting its integration driver`);
    const deadline = Date.now() + 90_000;
    let lastResult = initialResult;
    let lastError = null;
    let attempt = 0;
    while (Date.now() < deadline) {
      await sleep(Math.min(1500 + attempt * 500, 5000));
      attempt += 1;
      if (peer.identifier) this.discovery.clear(peer.identifier);
      try {
        const result = await this.postSnapshot(peer, payload, { forceDiscovery: true });
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
      error: lastError?.message || lastResult?.report?.error || "Satellite did not return after activating its proxy catalog",
      report: lastResult?.report,
      restarted: true
    };
  }

  async pushSnapshot(peer, payload) {
    try {
      const result = await this.postSnapshot(peer, payload);
      if (result.restart_required) return this.waitForRestartAndResend(peer, payload, result);
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
          const result = await this.postSnapshot(peer, payload, { forceDiscovery: true });
          return result.restart_required
            ? { ...(await this.waitForRestartAndResend(peer, payload, result)), wowlan_sent: false }
            : { ...result, wowlan_sent: false };
        } catch (retryError) {
          return { success: false, error: retryError.message, wowlan_sent: false };
        }
      }

      const deadline = Date.now() + WAKE_TIMEOUT_MS;
      let index = 0;
      let lastError = error;
      while (Date.now() < deadline) {
        await sleep(WAKE_RETRY_SCHEDULE_MS[Math.min(index++, WAKE_RETRY_SCHEDULE_MS.length - 1)]);
        try {
          const result = await this.postSnapshot(peer, payload, { forceDiscovery: true });
          const finalResult = result.restart_required ? await this.waitForRestartAndResend(peer, payload, result) : result;
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
}
