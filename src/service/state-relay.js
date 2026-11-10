import { logger } from "../shared/logger.js";
import { firstIdentifier } from "../shared/util.js";

const log = logger("state-relay");

const FLUSH_DELAY_MS = 250;
const PUSH_TIMEOUT_MS = 5000;
const READ_CONCURRENCY = 4;

// Attribute values a proxy entity can carry (the same rule the proxy catalog applies to snapshot attributes).
export function proxyAttributes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["string", "number", "boolean"].includes(typeof item)) result[key] = item;
    else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) result[key] = [...item];
  }
  return result;
}

// Source entity ids a snapshot turns into proxy entities on the Satellites.
export function proxiedSourceIds(manifest) {
  const ids = new Set();
  for (const entity of manifest?.data?.entities || []) {
    const id = firstIdentifier(entity, "entity_id", "id");
    if (id) ids.add(String(id));
  }
  for (const record of manifest?.data?.remotes || []) {
    if (record?.source_id) ids.add(String(record.source_id));
  }
  return ids;
}

// -----------------------------------------------------------------------------
// Live state relay (Primary)
// -----------------------------------------------------------------------------
//
// Snapshots only carry the attributes an entity had when the snapshot was built, and automatic synchronization
// ignores live state on purpose. This relay forwards the Primary's entity_change events for proxied entities to every
// enabled Satellite, coalesced per entity, so proxy entities show and follow the Primary's real state.

export class ProxyStateRelay {
  constructor({ getConfig, getClient, resolvePeerUrl, fetchImpl = (...args) => fetch(...args), flushDelayMs = FLUSH_DELAY_MS, publish = null, linkedPeer = () => false }) {
    this.publish = publish;
    this.linkedPeer = linkedPeer;
    this.getConfig = getConfig;
    this.getClient = getClient;
    this.resolvePeerUrl = resolvePeerUrl;
    this.fetchImpl = fetchImpl;
    this.flushDelayMs = flushDelayMs;
    this.sources = new Set();
    this.known = new Map();
    this.pending = new Map();
    this.timer = null;
    this.flushing = null;
    this.unsupportedPeers = new Set();
    this.failingPeers = new Set();
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.known.clear();
    this.unsupportedPeers.clear();
    this.failingPeers.clear();
  }

  // Called with every snapshot the Primary builds.
  setSnapshot(manifest) {
    this.sources = proxiedSourceIds(manifest);
    for (const id of [...this.known.keys()]) if (!this.sources.has(id)) this.known.delete(id);
    for (const entity of manifest?.data?.entities || []) {
      const id = firstIdentifier(entity, "entity_id", "id");
      if (id && !this.known.has(String(id))) {
        const attributes = proxyAttributes(entity.attributes);
        if (Object.keys(attributes).length) this.known.set(String(id), attributes);
      }
    }
    // A new snapshot may have updated older Satellites; probe them again.
    this.unsupportedPeers.clear();
  }

  // Record attributes without scheduling a push (for example after a proxied command, which the Core reports too).
  observe(entityId, attributes) {
    const id = String(entityId || "");
    if (!this.sources.has(id)) return;
    const clean = proxyAttributes(attributes);
    if (Object.keys(clean).length) this.known.set(id, { ...(this.known.get(id) || {}), ...clean });
  }

  // Core entity_change event: { entity_id, attributes | null }.
  handle(event) {
    const config = this.getConfig();
    if (!config || config.role !== "master") return false;
    const id = String(event?.entity_id || "");
    if (!id || !this.sources.has(id)) return false;
    const attributes = event.attributes ? proxyAttributes(event.attributes) : null;
    const previous = this.pending.get(id);
    if (attributes === null || previous === null) this.pending.set(id, null);
    else this.pending.set(id, { ...(previous || {}), ...attributes });
    if (attributes) this.known.set(id, { ...(this.known.get(id) || {}), ...attributes });
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush().catch((error) => log.warn("State relay flush failed:", error.message)); }, this.flushDelayMs);
      this.timer.unref?.();
    }
    return true;
  }

  async flush() {
    if (this.flushing) {
      await this.flushing;
      if (this.pending.size && !this.timer) return this.flush();
      return;
    }
    if (!this.pending.size) return;
    const batch = new Map(this.pending);
    this.pending.clear();
    this.flushing = this.#flushBatch(batch).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async #flushBatch(batch) {
    const states = [];
    const unresolved = [];
    for (const [id, attributes] of batch) {
      if (attributes && Object.keys(attributes).length) states.push({ source_entity_id: id, attributes });
      else unresolved.push(id);
    }
    states.push(...await this.#read(unresolved));
    if (!states.length) return;
    await this.#pushAll(states);
  }

  async #read(ids) {
    const client = this.getClient();
    if (!client || !ids.length) return [];
    const result = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(READ_CONCURRENCY, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try {
          const detail = await client.getJson(`/entities/${encodeURIComponent(id)}`, { optionalStatuses: [404], wakeOnUnavailable: false });
          const attributes = proxyAttributes(detail?.attributes);
          if (!Object.keys(attributes).length) continue;
          this.known.set(id, attributes);
          result.push({ source_entity_id: id, attributes });
        } catch (error) {
          log.debug(`Could not read state of ${id}: ${error.message}`);
        }
      }
    });
    await Promise.all(workers);
    return result;
  }

  async #pushAll(states) {
    // Linked Satellites get the states over the persistent link (and catch up on reconnect); HTTP is only used for
    // Satellites that cannot hold a link.
    this.publish?.(states);
    const config = this.getConfig();
    const peers = (config?.peers || []).filter((peer) => peer.enabled && !this.unsupportedPeers.has(peer.peer_id) && !this.linkedPeer(peer));
    await Promise.all(peers.map((peer) => this.push(peer, states)));
  }

  // Sends states to one Satellite. Sleeping Satellites are not woken for state changes; they ask the Primary for
  // the current states when they come back.
  async push(peer, states) {
    if (!states?.length) return true;
    try {
      const destination = await this.resolvePeerUrl(peer, false);
      const response = await this.fetchImpl(`${String(destination.url).replace(/\/$/, "")}/v1/proxy/state`, {
        method: "POST",
        headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ states }),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
      });
      if ([404, 405].includes(response.status)) {
        this.unsupportedPeers.add(peer.peer_id);
        log.info(`${peer.name} does not accept live proxy states yet (Remote Sync update pending)`);
        return false;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      if (this.failingPeers.delete(peer.peer_id)) log.info(`Live proxy states reach ${peer.name} again`);
      return true;
    } catch (error) {
      if (!this.failingPeers.has(peer.peer_id)) log.warn(`Could not send live proxy states to ${peer.name}: ${error.message}`);
      else log.debug(`Could not send live proxy states to ${peer.name}: ${error.message}`);
      this.failingPeers.add(peer.peer_id);
      return false;
    }
  }

  // Current attributes of every proxied entity, read from the Core for entities without a recent event.
  async currentStates() {
    const missing = [...this.sources].filter((id) => !this.known.has(id));
    await this.#read(missing);
    return [...this.sources]
      .filter((id) => this.known.has(id))
      .map((id) => ({ source_entity_id: id, attributes: { ...this.known.get(id) } }));
  }

  // After a snapshot reached a Satellite: bring its proxy states up to date (the cached snapshot can be older).
  async initialize(peer) {
    if (!this.known.size || this.linkedPeer(peer)) return;
    const states = [...this.known].filter(([id]) => this.sources.has(id)).map(([id, attributes]) => ({ source_entity_id: id, attributes: { ...attributes } }));
    await this.push(peer, states);
  }
}
