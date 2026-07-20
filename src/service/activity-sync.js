import crypto from "node:crypto";
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
    this.sourceEpoch = crypto.randomUUID();
    this.stateRevisions = new Map();
    this.appliedStateVersions = new Map();
    this.applyQueues = new Map();
  }

  clear() {
    this.relaySuppressions.clear();
    this.stateRevisions.clear();
    this.appliedStateVersions.clear();
    this.applyQueues.clear();
  }

  #actionFromState(state) {
    const value = String(state || "").trim().toUpperCase();
    if (value === "ON") return "on";
    if (value === "OFF") return "off";
    return null;
  }

  #stateMatchesAction(state, action) {
    const value = String(state || "").trim().toUpperCase();
    if (action === "on") return ["ON", "STARTING"].includes(value);
    if (action === "off") return ["OFF", "STOPPING"].includes(value);
    return false;
  }

  #nextRevision(sourceActivityId) {
    const revision = Number(this.stateRevisions.get(sourceActivityId) || 0) + 1;
    this.stateRevisions.set(sourceActivityId, revision);
    return revision;
  }

  #stateUpdate(sourceActivityId, state) {
    return {
      source_activity_id: sourceActivityId,
      state: String(state),
      source_epoch: this.sourceEpoch,
      revision: this.#nextRevision(sourceActivityId),
      observed_at: new Date().toISOString()
    };
  }

  #isStaleVersion(sourceActivityId, sourceEpoch, revision) {
    const value = Number(revision);
    if (!sourceEpoch || !Number.isSafeInteger(value) || value < 1) return false;
    const current = this.appliedStateVersions.get(sourceActivityId);
    return current?.source_epoch === sourceEpoch && Number(current.revision) >= value;
  }

  #recordVersion(sourceActivityId, sourceEpoch, revision) {
    const value = Number(revision);
    if (!sourceEpoch || !Number.isSafeInteger(value) || value < 1) return;
    this.appliedStateVersions.set(sourceActivityId, { source_epoch: sourceEpoch, revision: value });
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
    const update = this.#stateUpdate(sourceActivityId, state);
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
        await this.#push(peer, this.#stateUpdate(sourceActivityId, state));
      } catch (error) {
        log.warn(`Could not initialize activity state ${sourceActivityId} on ${peer.name}: ${error.message}`);
      }
    }
  }

  async apply(update) {
    const sourceActivityId = String(update?.source_activity_id || "").trim();
    if (!sourceActivityId) return { success: false, status: 400, error: "Unsupported activity state" };

    const previous = this.applyQueues.get(sourceActivityId) || Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#applyStateUpdate({ ...update, source_activity_id: sourceActivityId }));
    this.applyQueues.set(sourceActivityId, current);
    try {
      return await current;
    } finally {
      if (this.applyQueues.get(sourceActivityId) === current) this.applyQueues.delete(sourceActivityId);
    }
  }

  async #applyStateUpdate({ source_activity_id, state, source_epoch = null, revision = null }) {
    const config = this.getConfig();
    const client = this.getClient();
    if (!config || config.role !== "child" || !client) return { success: false, status: 409, error: "This node is not an active satellite" };
    const sourceActivityId = String(source_activity_id || "").trim();
    const action = this.#actionFromState(state);
    if (!sourceActivityId || !action) return { success: false, status: 400, error: "Unsupported activity state" };
    const sourceNode = config.pairing?.paired_master_id;
    const targetActivityId = sourceNode ? this.getMappings().get(sourceNode, "activity", sourceActivityId) : null;
    if (!targetActivityId) return { success: false, status: 404, error: `No satellite activity mapping exists for ${sourceActivityId}` };

    if (this.#isStaleVersion(sourceActivityId, source_epoch, revision)) {
      return { success: true, changed: false, ignored_stale: true, target_activity_id: targetActivityId, action };
    }

    try {
      const current = (await client.getJson(`/entities/${encodeURIComponent(targetActivityId)}`, { optionalStatuses: [404] }))
        || (await client.getJson(`/activities/${encodeURIComponent(targetActivityId)}`, { optionalStatuses: [404] }));
      const currentState = current?.attributes?.state ?? current?.state;
      if (this.#stateMatchesAction(currentState, action)) {
        this.#recordVersion(sourceActivityId, source_epoch, revision);
        return { success: true, changed: false, target_activity_id: targetActivityId, action };
      }
    } catch (error) {
      log.debug(`Could not read satellite activity state for ${targetActivityId}: ${error.message}`);
    }

    const suppressionKey = `${sourceActivityId}|${action}`;
    this.relaySuppressions.set(suppressionKey, Date.now() + 10_000);
    try {
      await client.executeEntityCommand(targetActivityId, `activity.${action}`);
      this.#recordVersion(sourceActivityId, source_epoch, revision);
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
    return this.forwardProxyCommand(source, `activity.${normalizedAction}`);
  }
}
