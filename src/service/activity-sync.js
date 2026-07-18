import { logger } from "../shared/logger.js";

const log = logger("activity-sync");

// -----------------------------------------------------------------------------
// Activity state synchronization
// -----------------------------------------------------------------------------

export class ActivitySyncManager {
  constructor({ getConfig, getClient, getMappings, resolvePeerUrl, forwardProxyCommand }) {
    this.getConfig = getConfig;
    this.getClient = getClient;
    this.getMappings = getMappings;
    this.resolvePeerUrl = resolvePeerUrl;
    this.forwardProxyCommand = forwardProxyCommand;
    this.relaySuppressions = new Map();
    this.commandIntents = new Map();
  }

  clear() {
    this.relaySuppressions.clear();
    this.commandIntents.clear();
  }

  #actionFromState(state) {
    const value = String(state || "").trim().toUpperCase();
    if (value === "ON") return "on";
    if (value === "OFF") return "off";
    return null;
  }

  async #push(peer, event) {
    const destination = await this.resolvePeerUrl(peer, false);
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
    } finally {
      clearTimeout(timer);
    }
  }

  async broadcast(event) {
    const config = this.getConfig();
    const client = this.getClient();
    if (!config || config.role !== "master" || !client) return;
    const sourceActivityId = String(event?.source_activity_id || "").trim();
    if (!sourceActivityId) return;
    let state = typeof event?.state === "string" ? event.state : null;
    let entityType = String(event?.entity_type || "").toLowerCase();
    if (!state || entityType !== "activity") {
      let detail = null;
      try {
        const activityDetail = await client.getJson(`/activities/${encodeURIComponent(sourceActivityId)}`, { optionalStatuses: [404] });
        if (activityDetail) {
          detail = activityDetail;
          entityType = "activity";
        } else {
          detail = await client.getJson(`/entities/${encodeURIComponent(sourceActivityId)}`, { optionalStatuses: [404] });
        }
      } catch (error) {
        log.debug(`Could not resolve activity event ${sourceActivityId}: ${error.message}`);
      }
      if (!detail) return;
      entityType = String(detail.entity_type || entityType).toLowerCase();
      state = detail.attributes?.state ?? detail.state ?? state;
    }
    if (entityType !== "activity" || !this.#actionFromState(state)) return;
    const update = { source_activity_id: sourceActivityId, state: String(state) };
    const peers = config.peers.filter((peer) => peer.enabled);
    await Promise.allSettled(peers.map(async (peer) => {
      try {
        await this.#push(peer, update);
      } catch (error) {
        log.warn(`Could not synchronize activity state ${sourceActivityId} to ${peer.name}: ${error.message}`);
      }
    }));
  }

  async initialize(peer, activities) {
    for (const record of activities || []) {
      const sourceActivityId = String(record?.source_id || "");
      const state = record?.detail?.attributes?.state ?? record?.detail?.state;
      if (!sourceActivityId || typeof state !== "string" || !this.#actionFromState(state)) continue;
      try {
        await this.#push(peer, { source_activity_id: sourceActivityId, state });
      } catch (error) {
        log.warn(`Could not initialize activity state ${sourceActivityId} on ${peer.name}: ${error.message}`);
      }
    }
  }

  async apply({ source_activity_id, state }) {
    const config = this.getConfig();
    const client = this.getClient();
    if (!config || config.role !== "child" || !client) return { success: false, status: 409, error: "This node is not an active satellite" };
    const sourceActivityId = String(source_activity_id || "").trim();
    const action = this.#actionFromState(state);
    if (!sourceActivityId || !action) return { success: false, status: 400, error: "Unsupported activity state" };
    const sourceNode = config.pairing?.paired_master_id;
    const targetActivityId = sourceNode ? this.getMappings().get(sourceNode, "activity", sourceActivityId) : null;
    if (!targetActivityId) return { success: false, status: 404, error: `No satellite activity mapping exists for ${sourceActivityId}` };

    const pendingIntent = this.commandIntents.get(sourceActivityId);
    if (pendingIntent) {
      if (Number(pendingIntent.expires_at || 0) <= Date.now()) this.commandIntents.delete(sourceActivityId);
      else if (pendingIntent.action !== action) {
        log.info(`Ignoring stale primary activity ${action.toUpperCase()} state for ${sourceActivityId}; satellite requested ${pendingIntent.action.toUpperCase()}`);
        return { success: true, changed: false, ignored_stale: true, target_activity_id: targetActivityId, action };
      } else this.commandIntents.delete(sourceActivityId);
    }

    try {
      const current = (await client.getJson(`/entities/${encodeURIComponent(targetActivityId)}`, { optionalStatuses: [404] }))
        || (await client.getJson(`/activities/${encodeURIComponent(targetActivityId)}`, { optionalStatuses: [404] }));
      const currentState = current?.attributes?.state ?? current?.state;
      if (this.#actionFromState(currentState) === action) return { success: true, changed: false, target_activity_id: targetActivityId };
    } catch (error) {
      log.debug(`Could not read satellite activity state for ${targetActivityId}: ${error.message}`);
    }

    const suppressionKey = `${sourceActivityId}|${action}`;
    this.relaySuppressions.set(suppressionKey, Date.now() + 10_000);
    try {
      await client.executeEntityCommand(targetActivityId, `activity.${action}`);
      return { success: true, changed: true, target_activity_id: targetActivityId, action };
    } catch (error) {
      this.relaySuppressions.delete(suppressionKey);
      return { success: false, status: error.status || 502, error: error.message, target_activity_id: targetActivityId };
    }
  }

  async forward(sourceActivityId, action) {
    const source = String(sourceActivityId || "").trim();
    const normalizedAction = String(action || "").trim().toLowerCase();
    if (!source || !["on", "off"].includes(normalizedAction)) return { success: false, status: 400, error: "Invalid activity relay command" };
    const key = `${source}|${normalizedAction}`;
    const expiresAt = Number(this.relaySuppressions.get(key) || 0);
    if (expiresAt > Date.now()) {
      this.relaySuppressions.delete(key);
      return { success: true, suppressed: true, source_entity_id: source, cmd_id: `activity.${normalizedAction}` };
    }
    this.relaySuppressions.delete(key);
    const intent = { action: normalizedAction, expires_at: Date.now() + 360_000 };
    this.commandIntents.set(source, intent);
    const result = await this.forwardProxyCommand(source, `activity.${normalizedAction}`);
    if (!result.success && this.commandIntents.get(source) === intent) this.commandIntents.delete(source);
    return result;
  }
}
