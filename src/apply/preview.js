import { DEFAULT_SECTIONS } from "../shared/constants.js";
import { utcNow } from "../shared/util.js";

// -----------------------------------------------------------------------------
// Snapshot change estimation
// -----------------------------------------------------------------------------

const SECTION_KINDS = Object.freeze({
  entities: "entity",
  activities: "activity",
  activity_groups: "activity_group",
  macros: "macro",
  remotes: "remote",
  profiles: "profile",
  docks: "dock"
});

function recordsForSection(manifest, section) {
  if (section === "profiles") return manifest.data?.profiles?.items || [];
  return manifest.data?.[section] || [];
}

function sourceId(record, section) {
  if (section === "entities") return String(record?.entity_id || record?.id || "");
  if (section === "activity_groups") return String(record?.activity_group_id || record?.group_id || record?.id || "");
  if (section === "profiles") return String(record?.source_id || record?.profile_id || record?.id || "");
  if (section === "docks") return String(record?.source_id || record?.detail?.dock_id || record?.dock_id || record?.id || "");
  return String(record?.source_id || record?.entity_id || record?.id || "");
}

export function buildApplyPreview(manifest, config, mappings, proxyCatalog = null) {
  const counts = { create: 0, update: 0, remove: 0, unchanged: 0 };
  const sections = {};
  const sourceNode = String(manifest.source_node_id || "");

  for (const section of DEFAULT_SECTIONS) {
    if (!manifest.sections?.includes(section)) continue;
    if (section === "resources") {
      const amount = Array.isArray(manifest.resources) ? manifest.resources.length : 0;
      sections.resources = { create_or_update: amount, remove: 0 };
      counts.update += amount;
      continue;
    }

    const records = recordsForSection(manifest, section);
    const kind = SECTION_KINDS[section];
    if (!kind) continue;
    const currentIds = new Set(records.map((record) => sourceId(record, section)).filter(Boolean));
    let create = 0;
    let update = 0;
    for (const id of currentIds) {
      if (mappings.get(sourceNode, kind, id)) update += 1;
      else create += 1;
    }
    let remove = 0;
    if (config.sync?.prune) {
      const existing = mappings.items(sourceNode, kind);
      remove = Object.keys(existing).filter((id) => !currentIds.has(id)).length;
    }
    sections[section] = { create, update, remove };
    counts.create += create;
    counts.update += update;
    counts.remove += remove;
  }

  const currentProxyIds = new Set((proxyCatalog?.entities || []).map((item) => String(item.source_entity_id || "")).filter(Boolean));
  const incomingProxyIds = new Set((manifest.data?.entities || []).map((item) => String(item.entity_id || item.id || "")).filter(Boolean));
  if (manifest.sections?.includes("entities")) {
    const obsolete = [...currentProxyIds].filter((id) => !incomingProxyIds.has(id)).length;
    if (config.sync?.prune && obsolete) {
      counts.remove += obsolete;
      sections.entities ||= { create: 0, update: 0, remove: 0 };
      sections.entities.remove += obsolete;
    }
  }

  return {
    dry_run: true,
    estimated: true,
    operation_id: manifest.operation_id,
    source_node_id: sourceNode,
    source_name: manifest.source_name,
    generated_at: utcNow(),
    counts,
    sections,
    summary: `Create ${counts.create}, update ${counts.update}, remove ${counts.remove}`
  };
}
