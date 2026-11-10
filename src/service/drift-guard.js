import fs from "node:fs";
import path from "node:path";
import { dataHome } from "../shared/paths.js";
import { atomicWriteJson } from "../shared/util.js";
import { logger } from "../shared/logger.js";
import { extractSettings, settingsDifferences } from "../settings/catalog.js";
import { stableConfiguration } from "../protocol/snapshot.js";
import { canonicalJson, sha256Bytes } from "../shared/util.js";

const log = logger("drift-guard");

const REPORT_DELAY_MS = 5000;
const APPLY_GRACE_MS = 30_000;
const MAX_BACKUPS = 100;
const SETTINGS_RESTORE_INTERVAL_MS = 60_000;

const CHILD_LISTS = Object.freeze({ profile: ["pages", "groups"] });

const DETAIL_PATHS = Object.freeze({
  activity: (id) => `/activities/${encodeURIComponent(id)}`,
  macro: (id) => `/macros/${encodeURIComponent(id)}`,
  activity_group: (id) => `/activity_groups/${encodeURIComponent(id)}`,
  profile: (id) => `/profiles/${encodeURIComponent(id)}`
});

function firstString(data, keys) {
  for (const key of keys) {
    const value = data?.[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Drift guard (Satellite)
// -----------------------------------------------------------------------------
//
// The Primary is the master of everything it synchronizes. When an activity, macro, activity group, profile or page
// that came from the Primary is edited or deleted directly on this Satellite, the guard keeps a backup of the edited
// object and asks the Primary for a forced synchronization, which restores the Primary's version. Objects that only
// exist on this Satellite are never touched.

export class DriftGuard {
  constructor({ getClient, getMappings, getSourceNode, report, restoreSettings = null, appliedSettings = {}, backupDir = path.join(dataHome(), "drift-backups"), reportDelayMs = REPORT_DELAY_MS, applyGraceMs = APPLY_GRACE_MS, settingsRestoreIntervalMs = SETTINGS_RESTORE_INTERVAL_MS }) {
    this.restoreSettings = restoreSettings;
    this.appliedSettings = appliedSettings || {};
    this.settingsRestoreIntervalMs = settingsRestoreIntervalMs;
    this.settingsTimer = null;
    this.lastSettingsRestore = 0;
    this.pendingSettings = null;
    this.settingsRestored = 0;
    // Fingerprints of synchronized objects as Remote Sync left them (live state removed). Events only make the guard
    // look again; an object counts as edited only when its configuration really differs from its fingerprint.
    this.fingerprints = new Map();
    this.verified = 0;
    this.getClient = getClient;
    this.getMappings = getMappings;
    this.getSourceNode = getSourceNode;
    this.report = report;
    this.backupDir = backupDir;
    this.reportDelayMs = reportDelayMs;
    this.applyGraceMs = applyGraceMs;
    this.applying = 0;
    this.quietUntil = 0;
    this.pending = new Map();
    this.unsent = [];
    this.timer = null;
    this.lastDrift = null;
    this.reverted = 0;
  }

  stop() { clearTimeout(this.timer); this.timer = null; clearTimeout(this.settingsTimer); this.settingsTimer = null; }

  // Device settings this remote holds for the Primary (category → field → value).
  setAppliedSettings(settings) { this.appliedSettings = settings && typeof settings === "object" ? settings : {}; }

  // Changes made while (and shortly after) Remote Sync applies a snapshot are its own.
  beginApply() { this.applying += 1; }
  endApply() { this.applying = Math.max(0, this.applying - 1); this.quietUntil = Date.now() + this.applyGraceMs; }
  get suppressed() { return this.applying > 0 || Date.now() < this.quietUntil; }

  status() { return { last_drift: this.lastDrift, reverted_objects: this.reverted, restored_settings: this.settingsRestored, checks: this.verified, pending: this.pending.size + this.unsent.length }; }

  #mapped(kinds) {
    const sourceNode = this.getSourceNode();
    const mappings = this.getMappings();
    if (!sourceNode || !mappings) return new Map();
    const result = new Map();
    for (const kind of kinds) {
      for (const [kindName, items] of Object.entries(mappings.kinds(sourceNode))) {
        if (kindName !== kind && !kindName.startsWith(`${kind}:`)) continue;
        for (const targetId of Object.values(items)) result.set(String(targetId), kind);
      }
    }
    return result;
  }

  // Configuration event from this Satellite's own Core (name + data as the Core sent it).
  note(name, data) {
    if (this.suppressed) return false;
    if (name === "configuration_change") return this.#settingsChanged(data?.new_state);
    const object = this.#classify(String(name || ""), data || {});
    if (!object) return false;
    this.pending.set(`${object.kind}|${object.id}`, { ...object, event: name, detected_at: new Date().toISOString() });
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush().catch((error) => log.warn("Drift report failed:", error.message)); }, this.reportDelayMs);
      this.timer.unref?.();
    }
    return true;
  }

  #classify(name, data) {
    const eventType = String(data.event_type || "").toUpperCase();
    if (name === "entity_change") {
      const id = firstString(data, ["entity_id"]) || firstString(data.entity, ["entity_id"]);
      if (!id || eventType === "CREATE" || eventType === "NEW") return null;
      const kind = this.#mapped(["activity", "macro"]).get(id);
      return kind ? { kind, id } : null;
    }
    if (name === "activity_group_change") {
      if (eventType === "CREATE" || eventType === "NEW") return null;
      const mapped = this.#mapped(["activity_group"]);
      const id = firstString(data, ["group_id", "activity_group_id", "id", "entity_id"]);
      if (id) return mapped.has(id) ? { kind: "activity_group", id } : null;
      return mapped.size ? { kind: "activity_group", id: null } : null;
    }
    if (name === "profile_change") {
      if ((eventType === "CREATE" || eventType === "NEW") && !data.page_id && !data.group_id) return null;
      const mapped = this.#mapped(["profile", "profile_page", "profile_group"]);
      const pageId = firstString(data, ["page_id"]);
      const groupId = firstString(data, ["group_id"]);
      const profileId = firstString(data, ["profile_id", "id"]);
      for (const candidate of [pageId, groupId]) if (candidate && mapped.has(candidate)) return { kind: "profile", id: profileId || candidate };
      if (profileId) return mapped.has(profileId) ? { kind: "profile", id: profileId } : null;
      return mapped.size ? { kind: "profile", id: null } : null;
    }
    return null;
  }

  // Settings the Primary synchronizes were changed on this remote: put the Primary's values back. The Satellite holds
  // them already, so it restores them itself (at most once a minute, so it can never fight another writer quickly).
  #settingsChanged(cfgAll) {
    const categories = Object.keys(this.appliedSettings || {});
    if (!categories.length || !cfgAll || !this.restoreSettings) return false;
    const differences = settingsDifferences(this.appliedSettings, extractSettings(cfgAll, categories));
    if (!differences.length) return false;
    this.pendingSettings = differences;
    if (!this.settingsTimer) {
      const wait = Math.max(this.reportDelayMs, this.lastSettingsRestore + this.settingsRestoreIntervalMs - Date.now());
      this.settingsTimer = setTimeout(() => { this.settingsTimer = null; this.#restoreSettingsNow().catch((error) => log.warn("Restoring device settings failed:", error.message)); }, wait);
      this.settingsTimer.unref?.();
    }
    return true;
  }

  async #restoreSettingsNow() {
    const differences = this.pendingSettings || [];
    this.pendingSettings = null;
    if (!differences.length || this.suppressed) return;
    this.lastSettingsRestore = Date.now();
    const detectedAt = new Date().toISOString();
    await this.#backup({ kind: "settings", id: "device", event: "configuration_change", detected_at: detectedAt, detail_override: differences });
    const restore = {};
    for (const { category, field, applied } of differences) (restore[category] ||= {})[field] = applied;
    log.warn(`Device settings changed on this remote (${differences.map((item) => `${item.category}.${item.field}`).join(", ")}); restoring the Primary's values`);
    this.beginApply();
    try { await this.restoreSettings(restore); this.settingsRestored += differences.length; }
    finally { this.endApply(); }
    this.lastDrift = { detected_at: detectedAt, objects: differences.map(({ category, field }) => ({ kind: "setting", id: `${category}.${field}` })) };
  }

  // Fingerprint of one object's configuration, or null when it no longer exists.
  async #fingerprint(kind, id) {
    const client = this.getClient();
    if (!client || !DETAIL_PATHS[kind]) return undefined;
    const detail = await client.getJson(DETAIL_PATHS[kind](id), { optionalStatuses: [404] });
    if (!detail) return null;
    const parts = { detail: stableConfiguration(detail) };
    for (const child of CHILD_LISTS[kind] || []) {
      try { parts[child] = stableConfiguration(await client.listPaginated(`${DETAIL_PATHS[kind](id)}/${child}`, { optional: true })); }
      catch { parts[child] = null; }
    }
    return sha256Bytes(canonicalJson(parts));
  }

  // After every successful synchronization: remember how each synchronized object looks.
  async captureFingerprints() {
    const next = new Map();
    for (const [id, kind] of this.#mapped(["activity", "macro", "activity_group", "profile"])) {
      try {
        const fingerprint = await this.#fingerprint(kind, id);
        if (fingerprint) next.set(`${kind}|${id}`, fingerprint);
      } catch (error) { log.debug(`Could not fingerprint ${kind} ${id}: ${error.message}`); }
    }
    this.fingerprints = next;
    return Object.fromEntries(next);
  }

  restoreFingerprints(value) {
    this.fingerprints = new Map(Object.entries(value && typeof value === "object" ? value : {}));
  }

  // Candidates from events → objects whose configuration really changed.
  async #verify(candidates) {
    const confirmed = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const ids = candidate.id ? [candidate.id] : [...this.#mapped([candidate.kind])].filter(([, kind]) => kind === candidate.kind).map(([id]) => id);
      for (const id of ids) {
        const key = `${candidate.kind}|${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const expected = this.fingerprints.get(key);
        let actual;
        try { actual = await this.#fingerprint(candidate.kind, id); }
        catch (error) { log.debug(`Could not check ${key}: ${error.message}`); continue; }
        this.verified += 1;
        if (actual === undefined) continue;
        if (!expected) { if (actual) this.fingerprints.set(key, actual); continue; }
        if (actual === expected) continue;
        confirmed.push({ ...candidate, id, deleted: actual === null });
      }
    }
    return confirmed;
  }

  async flush() {
    const candidates = [...this.pending.values()];
    this.pending.clear();
    const objects = this.suppressed ? [] : await this.#verify(candidates);
    if (objects.length) {
      for (const object of objects) await this.#backup(object);
      this.lastDrift = { detected_at: objects[0].detected_at, objects: objects.map(({ kind, id }) => ({ kind, id })) };
      log.warn(`Detected ${objects.length} local edit(s) of synchronized configuration (${objects.map((item) => `${item.kind} ${item.id || "?"}`).join(", ")}); restoring the Primary's version`);
      this.unsent.push(...objects.map(({ kind, id, event, detected_at }) => ({ kind, id, event, detected_at })));
    }
    if (!this.unsent.length) return true;
    const batch = this.unsent.splice(0);
    let sent = false;
    try { sent = await this.report(batch); } catch (error) { log.debug("Drift report could not be sent:", error.message); }
    if (!sent) { this.unsent.unshift(...batch); return false; }
    this.reverted += batch.length;
    return true;
  }

  async #backup(object) {
    const client = this.getClient();
    let detail = object.detail_override ?? null;
    if (detail === null && object.id && client && DETAIL_PATHS[object.kind]) {
      try { detail = await client.getJson(DETAIL_PATHS[object.kind](object.id), { optionalStatuses: [404] }); }
      catch (error) { log.debug(`Could not read ${object.kind} ${object.id} for backup: ${error.message}`); }
    }
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const stamp = object.detected_at.replace(/[:.]/g, "-");
      const file = path.join(this.backupDir, `${stamp}_${object.kind}_${String(object.id || "unknown").replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
      const { detail_override: _ignored, ...record } = object;
      atomicWriteJson(file, { ...record, detail, deleted: object.kind !== "settings" && object.id ? detail === null : null });
      const files = fs.readdirSync(this.backupDir).filter((item) => item.endsWith(".json")).sort();
      for (const old of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) fs.rmSync(path.join(this.backupDir, old), { force: true });
    } catch (error) { log.warn("Could not write drift backup:", error.message); }
  }
}
