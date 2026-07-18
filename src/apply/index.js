import { CoreApiError } from "../core/client.js";
import { createApplyReport, finishReport, incrementReport } from "../shared/models.js";
import { editableFields, firstIdentifier, rewriteIdentifiers, sha256Bytes, sleep } from "../shared/util.js";
import { logger } from "../shared/logger.js";
import { ACTIVITY_RELAY_ENTITY_ID, ACTIVITY_RELAY_LOCAL_ID } from "../shared/constants.js";
import { ProfileApplier } from "./profiles.js";
import { DockApplier } from "./docks.js";

// -----------------------------------------------------------------------------
// Payload schemas
// -----------------------------------------------------------------------------

const log = logger("applier");

const INTERNAL_CREATE_FIELDS = new Set(["name", "icon", "description"]);
const INTERNAL_UPDATE_FIELDS = new Set(["name", "icon", "description", "options"]);
const PAGE_FIELDS = new Set(["name", "icon", "image", "grid", "items", "entities", "pos", "order", "options"]);
const ACTIVITY_GROUP_FIELDS = new Set(["name", "icon", "description", "activities", "activity_ids", "options"]);
const READ_ONLY_KEYS = new Set(["entity_type", "integration_id", "features", "attributes", "available", "state", "device_state", "driver_state", "entity_commands", "simple_commands", "commands"]);

// -----------------------------------------------------------------------------
// Snapshot application
// -----------------------------------------------------------------------------

export class SnapshotApplier {
  constructor(client, config, operationCache, mappings) {
    this.client = client;
    this.config = config;
    this.operationCache = operationCache;
    this.mappings = mappings;
  }

  // -------------------------------------------------------------------------
  // Operation lifecycle
  // -------------------------------------------------------------------------

  async apply(manifest, resources, proxyCatalog, previousProxyCatalog = null) {
    const cached = this.operationCache.get(manifest.operation_id);
    if (cached) return { ...cached, duplicate: true };
    const report = createApplyReport(manifest.operation_id);
    try {
      const apply = async () => {
        const mapping = await this.#applySnapshot(manifest, resources, proxyCatalog, previousProxyCatalog, report);
        Object.assign(report.mappings, mapping);
      };
      if (this.config.sync.use_standby_inhibitor) {
        const inhibitorId = `remote-sync-${manifest.operation_id.slice(0, 12)}`;
        try { await this.client.withStandbyInhibitor(inhibitorId, "Remote Sync", `Applying proxy snapshot from ${manifest.source_name}`, apply); }
        catch (error) {
          report.warnings.push(`Standby inhibitor unavailable; continuing sync: ${error.message}`);
          await apply();
        }
      } else await apply();
      this.mappings.save();
      finishReport(report, report.errors.length === 0);
    } catch (error) {
      report.errors.push(error.message);
      finishReport(report, false);
    }
    if (report.success) this.operationCache.put(manifest.operation_id, report);
    return report;
  }

  async #applySnapshot(manifest, resources, proxyCatalog, previousProxyCatalog, report) {
    const mapping = {};
    Object.assign(mapping, proxyCatalog?.mapping || {});
    const obsoleteProxyIds = await this.#applyProxyEntities(proxyCatalog?.entities || [], previousProxyCatalog?.entities || [], report);
    if (manifest.sections.includes("activities") && (manifest.data.activities || []).length) await this.#ensureActivityRelay(report);
    if (manifest.sections.includes("resources")) await this.#applyResources(manifest, resources, report);
    if (manifest.sections.includes("docks")) Object.assign(mapping, await this.#dockApplier().apply(manifest.source_node_id, manifest.data.docks || [], report));
    let macroStage = null;
    let activityStage = null;
    if (manifest.sections.includes("macros")) {
      macroStage = await this.#stageInternalEntities(manifest.source_node_id, "macros", "macro", manifest.data.macros || [], mapping, report);
      Object.assign(mapping, macroStage.localMap);
    }
    if (manifest.sections.includes("activities")) {
      activityStage = await this.#stageInternalEntities(manifest.source_node_id, "activities", "activity", manifest.data.activities || [], mapping, report);
      Object.assign(mapping, activityStage.localMap);
    }
    const dependencyErrorStart = report.errors.length;
    if (macroStage) await this.#finishInternalEntities(manifest.source_node_id, "macros", "macro", macroStage, mapping, report);
    if (activityStage) await this.#finishInternalEntities(manifest.source_node_id, "activities", "activity", activityStage, mapping, report);
    const dependencyGraphReady = report.errors.length === dependencyErrorStart;
    if (dependencyGraphReady) {
      if (manifest.sections.includes("activity_groups")) Object.assign(mapping, await this.#applyActivityGroups(manifest.source_node_id, manifest.data.activity_groups || [], mapping, report));
      if (manifest.sections.includes("profiles")) Object.assign(mapping, await this.#profileApplier().apply(manifest.source_node_id, manifest.data.profiles || {}, mapping, report));
    } else {
      report.warnings.push("Skipped activity groups and profiles because one or more activity or macro definitions could not be restored");
    }
    if (this.config.sync.prune && obsoleteProxyIds.length) {
      if (report.errors.length === 0) await this.#pruneProxyEntities(obsoleteProxyIds, report);
      else report.warnings.push(`Retained ${obsoleteProxyIds.length} superseded proxy entity/entities because dependent configuration was not fully restored`);
    }
    return mapping;
  }

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  async #applyResources(manifest, resources, report) {
    const byType = new Map();
    for (const item of manifest.resources || []) {
      if (!byType.has(item.type)) byType.set(item.type, []);
      byType.get(item.type).push(item);
    }
    for (const [resourceType, sourceItems] of byType) {
      const existingItems = await this.client.listPaginated(`/resources/${encodeURIComponent(resourceType)}`, { optional: true });
      const existing = new Map(existingItems.map((item) => [String(item.id || item.resource_id || ""), item]));
      for (const item of sourceItems) {
        const resourceId = String(item.id);
        const sourcePayload = resources[item.archive_path];
        const current = existing.get(resourceId);
        if (current) {
          const sameSize = Number(current.size ?? -1) === Number(item.size);
          if (sameSize && !this.config.sync.verify_existing_resource_hashes) { incrementReport(report, "resources_skipped"); continue; }
          if (sameSize) {
            try {
              const targetPayload = await this.client.bytes("GET", `/resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, { expected: [200], timeoutMs: 15_000 });
              if (sha256Bytes(targetPayload) === String(item.sha256)) { incrementReport(report, "resources_skipped"); continue; }
            } catch (error) { report.warnings.push(`Could not verify existing resource ${resourceType}/${resourceId}: ${error.message}`); }
          }
          await this.client.deleteResource(resourceType, resourceId);
        }
        try { await this.client.uploadResource(resourceType, resourceId, sourcePayload); incrementReport(report, "resources_uploaded"); }
        catch (error) { if (error instanceof CoreApiError && error.status === 422) incrementReport(report, "resources_skipped"); else report.errors.push(error.message); }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Proxy entities
  // -------------------------------------------------------------------------

  async #applyProxyEntities(entities, previousEntities, report) {
    const descriptors = (entities || []).filter((item) => item && item.target_entity_id && item.local_id);
    const currentIds = new Set(descriptors.map((item) => String(item.target_entity_id)));
    const configuredIds = await this.#configuredEntityIds();
    const missing = descriptors.filter((descriptor) => !configuredIds.has(String(descriptor.target_entity_id)));

    if (missing.length) {
      const localIds = missing.map((descriptor) => String(descriptor.local_id));
      const result = await this.client.configureEntitiesFromIntegration("remote_sync.main", localIds);
      for (const _descriptor of missing) incrementReport(report, "proxy_entities_advertised");
      await this.#waitForConfiguredProxies(missing.map((descriptor) => String(descriptor.target_entity_id)));
      for (const _descriptor of missing) incrementReport(report, "proxy_entities_configured");
    }

    const failures = [];
    for (const descriptor of descriptors) {
      const payload = this.#proxyEditablePayload(descriptor);
      if (!Object.keys(payload).length) continue;
      try {
        await this.client.json("PATCH", `/entities/${encodeURIComponent(String(descriptor.target_entity_id))}`, { json: payload, expected: [200] });
        incrementReport(report, "proxy_entities_updated");
      } catch (error) {
        failures.push(`${descriptor.source_entity_id}: ${error.message}`);
      }
    }

    if (failures.length) {
      for (const failure of failures.slice(0, 20)) report.errors.push(`Proxy entity ${failure}`);
      throw new Error(`${failures.length} proxy entity/entities could not be updated; activities and pages were not modified`);
    }

    return [...new Set((previousEntities || [])
      .map((descriptor) => String(descriptor?.target_entity_id || ""))
      .filter((entityId) => entityId && !currentIds.has(entityId)))];
  }

  async #ensureActivityRelay(report) {
    const configured = await this.#configuredEntityIds();
    if (configured.has(ACTIVITY_RELAY_ENTITY_ID)) return;
    await this.client.configureEntitiesFromIntegration("remote_sync.main", [ACTIVITY_RELAY_LOCAL_ID]);
    await this.#waitForConfiguredProxies([ACTIVITY_RELAY_ENTITY_ID]);
    incrementReport(report, "activity_relay_configured");
  }

  #activityRelayPayload(updatePayload, sourceActivityId) {
    const payload = updatePayload && typeof updatePayload === "object" ? structuredClone(updatePayload) : {};
    const options = payload.options && typeof payload.options === "object" && !Array.isArray(payload.options)
      ? payload.options
      : {};
    const relayStep = (action) => ({
      type: "command",
      command: {
        entity_id: ACTIVITY_RELAY_ENTITY_ID,
        cmd_id: "button.push",
        params: { source_activity_id: String(sourceActivityId), action }
      }
    });

    options.sequences = {
      ...(options.sequences && typeof options.sequences === "object" && !Array.isArray(options.sequences)
        ? options.sequences
        : {}),
      on: [relayStep("on")],
      off: [relayStep("off")]
    };
    delete options.on_sequence;
    delete options.off_sequence;
    payload.options = options;
    return payload;
  }

  async #pruneProxyEntities(entityIds, report) {
    for (const entityId of entityIds) {
      try {
        await this.client.json("DELETE", `/entities/${encodeURIComponent(entityId)}`, { expected: [200, 204], optionalStatuses: [404] });
        incrementReport(report, "proxy_entities_pruned");
      } catch (error) {
        report.warnings.push(`Could not prune superseded proxy entity ${entityId}: ${error.message}`);
      }
    }
  }

  #proxyEditablePayload(descriptor) {
    return Object.fromEntries(Object.entries({
      name: descriptor.name,
      icon: descriptor.icon,
      description: descriptor.description
    }).filter(([, value]) => value !== undefined));
  }

  async #configuredEntityIds() {
    const items = await this.client.listPaginated("/entities", { pageSize: 100 });
    return new Set(items.map((item) => firstIdentifier(item, "entity_id", "id")).filter(Boolean).map(String));
  }

  async #waitForConfiguredProxies(expectedIds) {
    const expected = new Set(expectedIds.map(String));
    const timeoutMs = Math.max(100, Number(this.config.sync.proxy_activation_timeout_ms || 60_000));
    const deadline = Date.now() + timeoutMs;
    let missing = [...expected];
    while (Date.now() < deadline) {
      const configured = await this.#configuredEntityIds();
      missing = [...expected].filter((entityId) => !configured.has(entityId));
      if (!missing.length) return;
      await sleep(500);
    }
    throw new Error(`Core did not configure ${missing.length} Remote Sync proxy entity/entities: ${missing.slice(0, 8).join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // Activities and macros
  // -------------------------------------------------------------------------

  async #stageInternalEntities(sourceNode, section, kind, records, mapping, report) {
    const currentIds = new Set();
    const localMap = {};
    const prepared = [];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const sourceId = String(record.source_id || "");
      const detail = record.detail || {};
      if (!sourceId) continue;
      currentIds.add(sourceId);
      let targetId = this.mappings.get(sourceNode, kind, sourceId);
      if (!(targetId && await this.#internalExists(section, targetId))) {
        if (await this.#internalExists(section, sourceId)) targetId = sourceId;
        else {
          const createPayload = rewriteIdentifiers(editableFields(detail, INTERNAL_CREATE_FIELDS), mapping);
          try {
            const created = await this.client.json("POST", `/${section}`, { json: createPayload, expected: [200, 201] });
            targetId = firstIdentifier(created, "entity_id", "id");
            if (!targetId) throw new Error("Create response did not contain entity_id");
            incrementReport(report, `${section}_created`);
          } catch (error) { report.errors.push(`Create ${kind} ${sourceId}: ${error.message}`); continue; }
        }
      }
      this.mappings.set(sourceNode, kind, sourceId, targetId);
      localMap[sourceId] = targetId;
      mapping[sourceId] = targetId;
      prepared.push({ record, sourceId, targetId, detail });
    }
    return { currentIds, localMap, prepared };
  }

  async #finishInternalEntities(sourceNode, section, kind, stage, mapping, report) {
    for (const { record, sourceId, targetId, detail } of stage.prepared) {
      const context = `${kind} ${sourceId}`;
      let updatePayload = this.#rewriteConfiguredReferences(this.#cleanPayload(editableFields(detail, INTERNAL_UPDATE_FIELDS)), mapping, report, context);
      if (section === "activities") updatePayload = this.#activityRelayPayload(updatePayload, sourceId);
      const buttonPayload = record.buttons !== undefined
        ? this.#rewriteConfiguredReferences(record.buttons, mapping, report, `${context} buttons`)
        : undefined;
      const uiPayload = record.ui !== undefined
        ? this.#rewriteConfiguredReferences(record.ui || {}, mapping, report, `${context} UI`)
        : undefined;
      try {
        await this.#updateInternalEntity(section, targetId, updatePayload, buttonPayload, uiPayload, context, report);
        if (buttonPayload !== undefined) {
          try {
            await this.client.requestFirst([
              { kind: "json", method: "PATCH", path: `/${section}/${encodeURIComponent(targetId)}/buttons`, options: { json: buttonPayload, expected: [200] } },
              { kind: "json", method: "POST", path: `/${section}/${encodeURIComponent(targetId)}/buttons`, options: { json: buttonPayload, expected: [200] } }
            ]);
          } catch (error) {
            if (!(error instanceof CoreApiError) || ![404, 405].includes(error.status)) throw error;
            report.warnings.push(`Button mappings are not supported for ${section} ${targetId} on this Core API version`);
          }
        }
        if (uiPayload !== undefined) await this.#replaceUi(section, targetId, uiPayload, mapping, report, true);
        incrementReport(report, `${section}_updated`);
      } catch (error) { report.errors.push(`Update ${kind} ${sourceId}: ${error.message}`); }
    }
    if (this.config.sync.prune) await this.#pruneMapped(sourceNode, kind, section, stage.currentIds, report);
  }

  async #updateInternalEntity(section, targetId, updatePayload, buttonPayload, uiPayload, context, report) {
    const endpoint = `/${section}/${encodeURIComponent(targetId)}`;
    if (!updatePayload || !Object.keys(updatePayload).length) return;
    const options = updatePayload.options && typeof updatePayload.options === "object" && !Array.isArray(updatePayload.options)
      ? structuredClone(updatePayload.options)
      : null;
    if (!options || section !== "activities") {
      await this.client.json("PATCH", endpoint, { json: updatePayload, expected: [200] });
      return;
    }

    const membership = this.#activityEntityIds(options, buttonPayload, uiPayload);
    const metadata = { ...updatePayload };
    delete metadata.options;
    const membershipPayload = { ...metadata, options: { entity_ids: membership } };
    await this.client.json("PATCH", endpoint, { json: membershipPayload, expected: [200] });
    incrementReport(report, `${section}_membership_updated`);

    const contentPayload = { options: { ...options, entity_ids: membership } };
    await this.client.json("PATCH", endpoint, { json: contentPayload, expected: [200] });
    log.info(`Restored ${context} in membership-first mode with ${membership.length} assigned entity/entities`);
  }

  #activityEntityIds(options, buttons, ui) {
    const result = [];
    const seen = new Set();
    const add = (value) => {
      const id = String(value || "");
      if (!id || seen.has(id)) return;
      seen.add(id);
      result.push(id);
    };
    const visit = (value, key = null) => {
      if (typeof value === "string") {
        if (key === "entity_id") add(value);
        return;
      }
      if (Array.isArray(value)) {
        if (key === "entity_ids") for (const item of value) add(item);
        else for (const item of value) visit(item, key);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
    };
    visit(options);
    visit(buttons);
    visit(ui);
    return result;
  }

  async #replaceUi(section, targetId, ui, mapping, report, alreadyRewritten = false) {
    const base = `/${section}/${encodeURIComponent(targetId)}/ui`;
    const pages = Array.isArray(ui?.pages) ? ui.pages : [];
    const existingUi = await this.client.getJson(base, { optionalStatuses: [404, 405] });
    const existingPages = this.#responseList(existingUi, "pages");
    let individualDeleteWorked = existingPages.length === 0;
    for (const page of existingPages) {
      const pageId = firstIdentifier(page, "page_id", "id");
      if (!pageId) continue;
      try {
        await this.client.json("DELETE", `${base}/pages/${encodeURIComponent(pageId)}`, { expected: [200, 204], optionalStatuses: [404, 405] });
        individualDeleteWorked = true;
      } catch (error) {
        report.warnings.push(`Could not delete existing ${section} UI page ${pageId}: ${error.message}`);
      }
    }
    if (!individualDeleteWorked) {
      try { await this.client.json("DELETE", base, { expected: [200, 204], optionalStatuses: [404, 405] }); }
      catch (error) { report.warnings.push(`Could not reset ${section} UI for ${targetId}: ${error.message}`); }
    }

    const createdIds = new Set();
    for (const page of pages) {
      const sourcePageId = firstIdentifier(page, "page_id", "id");
      const payload = alreadyRewritten
        ? editableFields(page, PAGE_FIELDS)
        : this.#rewriteConfiguredReferences(editableFields(page, PAGE_FIELDS), mapping, report, `${section} ${targetId} page`);
      try {
        const created = await this.client.json("POST", `${base}/pages`, { json: payload, expected: [200, 201], optionalStatuses: [404, 405] });
        const targetPageId = firstIdentifier(created, "page_id", "id");
        if (targetPageId) createdIds.add(String(targetPageId));
        if (sourcePageId && targetPageId) mapping[sourcePageId] = targetPageId;
      } catch (error) { report.warnings.push(`Could not create ${section} UI page: ${error.message}`); }
    }

    const finalUi = await this.client.getJson(base, { optionalStatuses: [404, 405] });
    const finalPages = this.#responseList(finalUi, "pages");
    if (pages.length > 0 && createdIds.size === pages.length && finalPages.length > pages.length) {
      for (const page of finalPages) {
        const pageId = firstIdentifier(page, "page_id", "id");
        if (!pageId || createdIds.has(String(pageId))) continue;
        const items = Array.isArray(page?.items) ? page.items : [];
        if (items.length) continue;
        try {
          await this.client.json("DELETE", `${base}/pages/${encodeURIComponent(pageId)}`, { expected: [200, 204], optionalStatuses: [404, 405] });
          incrementReport(report, `${section}_blank_pages_removed`);
        } catch (error) { report.warnings.push(`Could not remove generated blank ${section} UI page ${pageId}: ${error.message}`); }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Activity groups
  // -------------------------------------------------------------------------

  async #applyActivityGroups(sourceNode, records, mapping, report) {
    const local = {};
    const currentIds = new Set();
    for (const raw of records) {
      if (!raw || typeof raw !== "object") continue;
      const sourceId = firstIdentifier(raw, "group_id", "id");
      if (!sourceId) continue;
      currentIds.add(sourceId);
      let targetId = this.mappings.get(sourceNode, "activity_group", sourceId);
      const payload = this.#rewriteConfiguredReferences(this.#cleanPayload(editableFields(raw, ACTIVITY_GROUP_FIELDS)), mapping, report, `activity group ${sourceId}`);
      try {
        if (targetId && await this.#exists(`/activity_groups/${encodeURIComponent(targetId)}`)) {
          await this.client.json("PATCH", `/activity_groups/${encodeURIComponent(targetId)}`, { json: payload, expected: [200] });
          incrementReport(report, "activity_groups_updated");
        } else if (await this.#exists(`/activity_groups/${encodeURIComponent(sourceId)}`)) {
          targetId = sourceId;
          await this.client.json("PATCH", `/activity_groups/${encodeURIComponent(targetId)}`, { json: payload, expected: [200] });
          incrementReport(report, "activity_groups_updated");
        } else {
          const created = await this.client.json("POST", "/activity_groups", { json: payload, expected: [200, 201] });
          targetId = firstIdentifier(created, "group_id", "id");
          if (!targetId) throw new Error("Create response did not contain group_id");
          incrementReport(report, "activity_groups_created");
        }
        this.mappings.set(sourceNode, "activity_group", sourceId, targetId);
        local[sourceId] = targetId;
        mapping[sourceId] = targetId;
      } catch (error) { report.errors.push(`Activity group ${sourceId}: ${error.message}`); }
    }
    if (this.config.sync.prune) await this.#pruneMapped(sourceNode, "activity_group", "activity_groups", currentIds, report);
    return local;
  }

  // -------------------------------------------------------------------------
  // Specialized appliers
  // -------------------------------------------------------------------------

  #profileApplier() {
    return new ProfileApplier({
      client: this.client,
      config: this.config,
      mappings: this.mappings,
      rewriteConfiguredReferences: (value, mapping, report, context) => this.#rewriteConfiguredReferences(value, mapping, report, context),
      configuredEntityIds: () => this.#configuredEntityIds(),
      exists: (endpoint) => this.#exists(endpoint),
      pruneMapped: (sourceNode, kind, section, currentIds, report) => this.#pruneMapped(sourceNode, kind, section, currentIds, report),
      responseList: (value, key) => this.#responseList(value, key),
      webSocketCompatibilityError: (error) => this.#webSocketCompatibilityError(error)
    });
  }

  #dockApplier() {
    return new DockApplier({
      client: this.client,
      config: this.config,
      mappings: this.mappings,
      responseList: (value, key) => this.#responseList(value, key)
    });
  }

  #responseList(value, key) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      if (Array.isArray(value[key])) return value[key];
      for (const candidate of ["items", "data", "results"]) if (Array.isArray(value[candidate])) return value[candidate];
    }
    return [];
  }

  #webSocketCompatibilityError(error) {
    return error?.name === "CoreWebSocketError" && [400, 404, 405, 422, 500, 501].includes(Number(error.code));
  }

  // -------------------------------------------------------------------------
  // Pruning and reference rewriting
  // -------------------------------------------------------------------------

  async #pruneMapped(sourceNode, kind, section, currentSourceIds, report) {
    for (const [sourceId, targetId] of Object.entries(this.mappings.items(sourceNode, kind))) {
      if (currentSourceIds.has(sourceId)) continue;
      try {
        await this.client.json("DELETE", `/${section}/${encodeURIComponent(targetId)}`, { expected: [200, 204], optionalStatuses: [404] });
        this.mappings.remove(sourceNode, kind, sourceId);
        incrementReport(report, `${section}_pruned`);
      } catch (error) { report.warnings.push(`Could not prune ${kind} ${targetId}: ${error.message}`); }
    }
  }

  async #internalExists(section, entityId) {
    if (await this.#exists(`/${section}/${encodeURIComponent(entityId)}`)) return true;
    if (section === "macros") return this.#exists(`/entities/${encodeURIComponent(entityId)}`);
    return false;
  }

  async #exists(endpoint) {
    try { return (await this.client.getJson(endpoint, { optionalStatuses: [404] })) !== null; }
    catch (error) { if (error instanceof CoreApiError && error.status === 404) return false; throw error; }
  }


  #rewriteConfiguredReferences(value, mapping, report, context) {
    const targetIds = new Set(Object.values(mapping).map(String));
    const dropped = new Set();
    const isFullEntityId = (candidate) => /^[A-Za-z0-9_:-]+\.main\./.test(String(candidate || ""));
    const isEmptyObject = (candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && Object.keys(candidate).length === 0;
    const rewrite = (item, key = null) => {
      if (typeof item === "string") {
        if (["entity_id", "activity_id", "macro_id", "remote_id"].includes(key)) {
          if (mapping[item]) return mapping[item];
          if (targetIds.has(item)) return item;
          if (isFullEntityId(item)) { dropped.add(item); return undefined; }
        }
        return mapping[item] ?? item;
      }
      if (Array.isArray(item)) {
        return item
          .map((entry) => rewrite(entry, key))
          .filter((entry) => entry !== undefined && !(isEmptyObject(entry) && ["on_sequence", "off_sequence", "sequence", "items"].includes(key)));
      }
      if (item && typeof item === "object") {
        const sourceEntityId = typeof item.entity_id === "string" ? item.entity_id : null;
        if (sourceEntityId && !mapping[sourceEntityId] && !targetIds.has(sourceEntityId) && isFullEntityId(sourceEntityId)) {
          dropped.add(sourceEntityId);
          return undefined;
        }
        const output = {};
        for (const [childKey, childValue] of Object.entries(item)) {
          const rewritten = rewrite(childValue, childKey);
          if (rewritten !== undefined) output[childKey] = rewritten;
        }
        for (const wrapperKey of ["command", "entity"]) {
          if (Object.prototype.hasOwnProperty.call(item, wrapperKey)
            && (!Object.prototype.hasOwnProperty.call(output, wrapperKey) || isEmptyObject(output[wrapperKey]))) return undefined;
        }
        if (["on_sequence", "off_sequence", "sequence", "items"].includes(key) && isEmptyObject(output)) return undefined;
        return output;
      }
      return item;
    };
    const result = rewrite(value);
    if (dropped.size) report.warnings.push(`${context}: removed ${dropped.size} unsupported reference(s): ${[...dropped].slice(0, 5).join(", ")}`);
    return result ?? (Array.isArray(value) ? [] : {});
  }

  #cleanPayload(value) {
    if (Array.isArray(value)) return value.map((item) => this.#cleanPayload(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !READ_ONLY_KEYS.has(key)).map(([key, item]) => [key, this.#cleanPayload(item)]));
    return value;
  }
}
