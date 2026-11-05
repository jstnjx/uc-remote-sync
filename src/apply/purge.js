import { CoreApiError } from "../core/client.js";
import { ACTIVITY_RELAY_ENTITY_ID } from "../shared/constants.js";
import { utcNow } from "../shared/util.js";
import { logger } from "../shared/logger.js";

const log = logger("purge");

// -----------------------------------------------------------------------------
// Satellite purge
//
// Removes everything one Primary synchronized to this Satellite: profiles (with their pages and groups), activity
// groups, activities, macros, proxied Docks, mirrored proxy entities, the activity relay entity and synchronized
// resources. The identifier mappings recorded while applying snapshots are the source of truth, so objects that were
// never synchronized are left alone. An object that already existed with the same identifier before the first
// synchronization was overwritten with the Primary's configuration at that point and is removed as well.
// -----------------------------------------------------------------------------

// Dependents first: profiles reference activities, groups reference activities, activities reference macros.
const DELETE_ORDER = [
  ["profile", "profiles"],
  ["activity_group", "activity_groups"],
  ["activity", "activities"],
  ["macro", "macros"],
  ["remote", "remotes"]
];

function count(report, key, amount = 1) {
  report.counts[key] = (report.counts[key] || 0) + amount;
}

export class SatellitePurger {
  constructor(client, mappings) {
    this.client = client;
    this.mappings = mappings;
  }

  async purge(sourceNode, { proxyCatalog = null, resources = [] } = {}) {
    const report = { source_node_id: sourceNode, started_at: utcNow(), finished_at: null, success: false, counts: {}, warnings: [], errors: [] };
    const kinds = this.mappings.kinds(sourceNode);

    await this.#leaveDeletedProfiles(Object.values(kinds.profile || {}), report);
    for (const [kind, section] of DELETE_ORDER) {
      for (const [sourceId, targetId] of Object.entries(kinds[kind] || {})) {
        if (await this.#delete(`/${section}/${encodeURIComponent(targetId)}`, `${kind} ${targetId}`, report)) {
          this.mappings.remove(sourceNode, kind, sourceId);
          count(report, `${section}_removed`);
        }
      }
    }
    for (const [sourceId, targetId] of Object.entries(kinds.dock || {})) {
      try {
        await this.client.coreMessage("delete_dock", { dock_id: String(targetId) }, 30_000);
        this.mappings.remove(sourceNode, "dock", sourceId);
        count(report, "docks_removed");
      } catch (error) {
        if (error?.code === 404) { this.mappings.remove(sourceNode, "dock", sourceId); continue; }
        report.warnings.push(`Dock ${targetId}: ${error.message}`);
      }
    }

    const entityIds = new Set((proxyCatalog?.entities || []).map((item) => String(item?.target_entity_id || "")).filter(Boolean));
    entityIds.add(ACTIVITY_RELAY_ENTITY_ID);
    for (const entityId of entityIds) {
      if (await this.#delete(`/entities/${encodeURIComponent(entityId)}`, `entity ${entityId}`, report)) count(report, "proxy_entities_removed");
    }

    const resourceIds = new Map();
    for (const [kind, items] of Object.entries(kinds)) {
      if (!kind.startsWith("resource:")) continue;
      const type = kind.slice("resource:".length);
      for (const id of Object.keys(items)) resourceIds.set(`${type}/${id}`, { type, id });
    }
    // The Primary also sends the resources of its current snapshot, which covers resources synchronized by Remote Sync
    // versions that did not record them yet.
    for (const item of resources || []) {
      if (item?.type && item?.id) resourceIds.set(`${item.type}/${item.id}`, { type: String(item.type), id: String(item.id) });
    }
    for (const { type, id } of resourceIds.values()) {
      try {
        await this.client.deleteResource(type, id);
        this.mappings.remove(sourceNode, `resource:${type}`, id);
        count(report, "resources_removed");
      } catch (error) { report.warnings.push(`Resource ${type}/${id}: ${error.message}`); }
    }

    // Profile pages and groups were deleted together with their profiles.
    const remaining = this.mappings.kinds(sourceNode);
    for (const kind of Object.keys(remaining)) {
      if (kind.startsWith("profile_page:") || kind.startsWith("profile_group:")) {
        for (const sourceId of Object.keys(remaining[kind])) this.mappings.remove(sourceNode, kind, sourceId);
      }
    }
    const left = Object.values(this.mappings.kinds(sourceNode)).reduce((total, items) => total + Object.keys(items).length, 0);
    if (left) report.warnings.push(`${left} synchronized object(s) could not be removed and are still tracked; removing again retries them`);
    this.mappings.save();
    report.remaining = left;
    report.removed = Object.values(report.counts).reduce((total, value) => total + value, 0);
    report.success = report.errors.length === 0;
    report.finished_at = utcNow();
    log.info(`Removed ${report.removed} synchronized object(s) of ${sourceNode}${left ? `; ${left} remain` : ""}`);
    return report;
  }

  async #delete(endpoint, label, report) {
    try {
      await this.client.json("DELETE", endpoint, { expected: [200, 204], optionalStatuses: [404], wakeOnUnavailable: false });
      return true;
    } catch (error) {
      report.warnings.push(`${label}: ${error instanceof CoreApiError ? `HTTP ${error.status}` : error.message}`);
      return false;
    }
  }

  // The active profile cannot be deleted; switch to a profile that stays before removing synchronized profiles.
  async #leaveDeletedProfiles(profileIds, report) {
    if (!profileIds.length) return;
    const doomed = new Set(profileIds.map(String));
    let active = null;
    try {
      const value = await this.client.getJson("/profiles/active", { optionalStatuses: [404, 405], wakeOnUnavailable: false });
      active = String(value?.profile_id || value?.id || value?.profile?.profile_id || "") || null;
    } catch {}
    if (!active || !doomed.has(active)) return;
    let profiles = [];
    try { profiles = await this.client.listPaginated("/profiles", { optional: true }); } catch {}
    const keep = profiles.map((item) => String(item?.profile_id || item?.id || "")).find((id) => id && !doomed.has(id));
    if (!keep) {
      report.warnings.push("The active profile was synchronized and no other profile exists; it is kept so the remote still has a profile");
      return;
    }
    try {
      await this.client.coreMessage("switch_profile", { profile_id: keep }, 30_000);
      count(report, "active_profile_switched");
    } catch (error) {
      report.warnings.push(`Could not switch away from the synchronized active profile: ${error.message}`);
    }
  }
}
