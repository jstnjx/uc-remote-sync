import { CoreApiError } from "../core/client.js";
import { createApplyReport, finishReport, incrementReport } from "../shared/models.js";
import { editableFields, firstIdentifier, rewriteIdentifiers, sha256Bytes, sleep } from "../shared/util.js";
import { logger } from "../shared/logger.js";
import { ACTIVITY_RELAY_ENTITY_ID, ACTIVITY_RELAY_LOCAL_ID } from "../shared/constants.js";
import { ProfileApplier } from "./profiles.js";
import { DockApplier } from "./docks.js";
import { HardwareAdapter } from "./hardware.js";
import { applyDeviceSettings } from "./settings.js";
import { AppliedObjectState, configuredFieldsEqual } from "./object-state.js";

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
  constructor(client, config, operationCache, mappings, { hardware = null, appliedObjects = {} } = {}) {
    this.client = client;
    this.config = config;
    this.operationCache = operationCache;
    this.mappings = mappings;
    // Adapts button mappings and UI pages from the Primary's hardware to this remote's (Remote Two ↔ Remote 3).
    this.hardware = hardware || new HardwareAdapter(null, null);
    this.appliedSettings = null;
    this.objectState = new AppliedObjectState(appliedObjects);
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
        let applyStarted = false;
        try {
          await this.client.withStandbyInhibitor(inhibitorId, "Remote Sync", `Applying proxy snapshot from ${manifest.source_name}`, async () => {
            applyStarted = true;
            await apply();
          });
        } catch (error) {
          // If the callback itself failed, rerunning it duplicates destructive
          // writes. Only fall back when acquiring the inhibitor failed.
          if (applyStarted) throw error;
          report.warnings.push(`Standby inhibitor unavailable; continuing sync: ${error.message}`);
          await apply();
        }
      } else await apply();
      this.mappings.save();
      if (this.hardware.adjustments.length) {
        report.hardware_adjustments = [...this.hardware.adjustments];
        report.warnings.push(...this.hardware.adjustments.map((item) => `Hardware: ${item}`));
      }
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
    if (manifest.sections.includes("settings")) {
      this.appliedSettings = await applyDeviceSettings(this.client, manifest.data.settings || {}, report, { adjustments: this.hardware.adjustments });
    }
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
        // Remember every synchronized resource so removing the Satellite can delete it again.
        const remember = () => this.mappings.set(manifest.source_node_id, `resource:${resourceType}`, resourceId, resourceId);
        if (current) {
          const sameSize = Number(current.size ?? -1) === Number(item.size);
          if (sameSize && !this.config.sync.verify_existing_resource_hashes) { remember(); incrementReport(report, "resources_skipped"); continue; }
          if (sameSize) {
            try {
              const targetPayload = await this.client.bytes("GET", `/resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, { expected: [200], timeoutMs: 15_000 });
              if (sha256Bytes(targetPayload) === String(item.sha256)) { remember(); incrementReport(report, "resources_skipped"); continue; }
            } catch (error) { report.warnings.push(`Could not verify existing resource ${resourceType}/${resourceId}: ${error.message}`); }
          }
          await this.client.deleteResource(resourceType, resourceId);
        }
        try { await this.client.uploadResource(resourceType, resourceId, sourcePayload); remember(); incrementReport(report, "resources_uploaded"); }
        catch (error) { if (error instanceof CoreApiError && error.status === 422) { remember(); incrementReport(report, "resources_skipped"); } else report.errors.push(error.message); }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Proxy entities
  // -------------------------------------------------------------------------

  async #applyProxyEntities(entities, previousEntities, report) {
    const descriptors = (entities || []).filter((item) => item && item.target_entity_id && item.local_id);
    const currentIds = new Set(descriptors.map((item) => String(item.target_entity_id)));
    const configuredEntities = await this.client.listPaginated("/entities", { pageSize: 100 });
    const configuredIds = new Set(configuredEntities.map((item) => firstIdentifier(item, "entity_id", "id")).filter(Boolean).map(String));
    const configuredById = new Map(configuredEntities.map((item) => [String(firstIdentifier(item, "entity_id", "id") || ""), item]));
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
      const current = configuredById.get(String(descriptor.target_entity_id));
      const metadataVisible = Object.keys(payload).every((key) => Object.hasOwn(current || {}, key));
      const matchesCore = configuredFieldsEqual(current, payload);
      const matchesRecorded = !metadataVisible && await this.objectState.matches(
        "proxy_metadata", descriptor.source_entity_id, descriptor.target_entity_id, payload);
      if (matchesCore || matchesRecorded) {
        incrementReport(report, "proxy_entities_skipped");
        if (matchesCore) await this.objectState.remember("proxy_metadata", descriptor.source_entity_id, descriptor.target_entity_id, payload);
        continue;
      }
      try {
        await this.client.json("PATCH", `/entities/${encodeURIComponent(String(descriptor.target_entity_id))}`, { json: payload, expected: [200] });
        await this.objectState.remember("proxy_metadata", descriptor.source_entity_id, descriptor.target_entity_id, payload);
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
        ? this.hardware.buttons(this.#rewriteConfiguredReferences(record.buttons, mapping, report, `${context} buttons`), `${context} buttons`)
        : undefined;
      const uiPayload = record.ui !== undefined
        ? this.hardware.ui(this.#rewriteConfiguredReferences(record.ui || {}, mapping, report, `${context} UI`), `${context} UI`)
        : undefined;
      const desired = { detail: updatePayload, buttons: buttonPayload, ui: uiPayload };
      const kindKey = `${section}:${sourceId}`;
      const observe = () => this.#observeInternalEntity(section, targetId);
      try {
        if (await this.objectState.matches("internal", kindKey, targetId, desired, observe)) {
          incrementReport(report, `${section}_skipped`);
          continue;
        }
        const detailDesired = { updatePayload,
          assignedEntityIds: section === "activities"
            ? this.#activityEntityIds(updatePayload?.options || {}, buttonPayload, uiPayload) : null };
        const observeDetail = () => this.#observeInternalPart(section, targetId, "detail");
        const observeButtons = () => this.#observeInternalPart(section, targetId, "buttons");
        const observeUi = () => this.#observeInternalPart(section, targetId, "ui");
        if (!(await this.objectState.matches("internal_detail", kindKey, targetId, detailDesired, observeDetail))) {
          await this.#updateInternalEntity(section, targetId, updatePayload, buttonPayload, uiPayload, context, report);
          await this.objectState.remember("internal_detail", kindKey, targetId, detailDesired, observeDetail);
        } else incrementReport(report, `${section}_metadata_skipped`);
        if (buttonPayload !== undefined) {
          if (await this.objectState.matches("internal_buttons", kindKey, targetId, buttonPayload, observeButtons)) {
            incrementReport(report, `${section}_buttons_skipped`);
          } else {
            try {
              await this.client.requestFirst([
                { kind: "json", method: "PATCH", path: `/${section}/${encodeURIComponent(targetId)}/buttons`, options: { json: buttonPayload, expected: [200] } },
                { kind: "json", method: "POST", path: `/${section}/${encodeURIComponent(targetId)}/buttons`, options: { json: buttonPayload, expected: [200] } }
              ]);
            } catch (error) {
              if (!(error instanceof CoreApiError) || ![404, 405].includes(error.status)) throw error;
              report.warnings.push(`Button mappings are not supported for ${section} ${targetId} on this Core API version`);
            }
            await this.objectState.remember("internal_buttons", kindKey, targetId, buttonPayload, observeButtons);
          }
        }
        if (uiPayload !== undefined) {
          if (await this.objectState.matches("internal_ui", kindKey, targetId, uiPayload, observeUi)) {
            incrementReport(report, `${section}_ui_skipped`);
          } else {
            await this.#replaceUi(section, targetId, uiPayload, mapping, report, true);
            await this.objectState.remember("internal_ui", kindKey, targetId, uiPayload, observeUi);
          }
        }
        await this.objectState.remember("internal", kindKey, targetId, desired, observe);
        incrementReport(report, `${section}_updated`);
      } catch (error) { report.errors.push(`Update ${kind} ${sourceId}: ${error.message}`); }
    }
    if (this.config.sync.prune) await this.#pruneMapped(sourceNode, kind, section, stage.currentIds, report);
  }

  async #observeInternalPart(section, targetId, part) {
    const base = `/${section}/${encodeURIComponent(targetId)}`;
    return this.client.getJson(part === "detail" ? base : `${base}/${part}`, { optionalStatuses: [404, 405] });
  }

  async #observeInternalEntity(section, targetId) {
    const detail = await this.#observeInternalPart(section, targetId, "detail");
    if (!detail) return null;
    const buttons = await this.#observeInternalPart(section, targetId, "buttons");
    const ui = await this.#observeInternalPart(section, targetId, "ui");
    return { detail, buttons, ui };
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

  // Core validates pages only when they are created. Create and validate every
  // replacement before deleting any existing page. Roll back staged pages if
  // validation fails; never report a partial UI replacement as successful.
  async #replaceUi(section, targetId, ui, mapping, report, alreadyRewritten = false) {
    const base = `/${section}/${encodeURIComponent(targetId)}/ui`;
    const pages = Array.isArray(ui?.pages) ? ui.pages : [];
    const existingUi = await this.client.getJson(base, { optionalStatuses: [404, 405] });
    const existingPages = this.#responseList(existingUi, "pages");
    const staged = [];
    try {
      for (const page of pages) {
        const sourcePageId = firstIdentifier(page, "page_id", "id");
        const payload = alreadyRewritten
          ? editableFields(page, PAGE_FIELDS)
          : this.#rewriteConfiguredReferences(editableFields(page, PAGE_FIELDS), mapping, report, `${section} ${targetId} page`);
        const created = await this.client.json("POST", `${base}/pages`, { json: payload, expected: [200, 201] });
        const pageId = firstIdentifier(created, "page_id", "id");
        if (!pageId) throw new Error("Core did not return an ID for the staged UI page; keeping existing pages");
        staged.push({ sourcePageId, targetPageId: String(pageId), payload });
      }
    } catch (error) {
      for (const page of staged) {
        try { await this.client.json("DELETE", `${base}/pages/${encodeURIComponent(page.targetPageId)}`, { expected: [200, 204], optionalStatuses: [404] }); }
        catch (rollbackError) { report.warnings.push(`Could not roll back staged ${section} UI page ${page.targetPageId}: ${rollbackError.message}`); }
      }
      throw new Error(`Rejected ${section} UI replacement for ${targetId}; previous pages preserved: ${error.message}`);
    }
    for (const page of existingPages) {
      const pageId = firstIdentifier(page, "page_id", "id");
      if (!pageId) continue;
      try {
        await this.client.json("DELETE", `${base}/pages/${encodeURIComponent(pageId)}`, { expected: [200, 204], optionalStatuses: [404] });
      } catch (error) {
        throw new Error(`New ${section} pages were staged, but deleting old page ${pageId} failed: ${error.message}`);
      }
    }
    // Some Core versions generate a blank page (or reset the page list) when
    // the last original page disappears. The replacements have already passed
    // Core validation; restore them if the Core discarded them during deletion.
    let finalUi = await this.client.getJson(base, { optionalStatuses: [404, 405] });
    let finalPages = this.#responseList(finalUi, "pages");
    if (finalUi) {
      for (const item of staged) {
        if (finalPages.some((page) => String(firstIdentifier(page, "page_id", "id")) === item.targetPageId)) continue;
        const created = await this.client.json("POST", `${base}/pages`, { json: item.payload, expected: [200, 201] });
        const newId = firstIdentifier(created, "page_id", "id");
        if (!newId) throw new Error(`Core discarded staged ${section} page and did not return an ID when restoring it`);
        item.targetPageId = String(newId);
      }
      finalUi = await this.client.getJson(base, { optionalStatuses: [404, 405] });
      finalPages = this.#responseList(finalUi, "pages");
      for (const page of finalPages) {
        const id = firstIdentifier(page, "page_id", "id");
        if (!id || staged.some((item) => item.targetPageId === String(id))) continue;
        if ((Array.isArray(page.items) && page.items.length) || (Array.isArray(page.entities) && page.entities.length)) continue;
        await this.client.json("DELETE", `${base}/pages/${encodeURIComponent(id)}`, { expected: [200, 204], optionalStatuses: [404] });
        incrementReport(report, `${section}_blank_pages_removed`);
      }
      finalUi = await this.client.getJson(base, { optionalStatuses: [404, 405] });
      finalPages = this.#responseList(finalUi, "pages");
      if (finalPages.length !== staged.length) {
        throw new Error(`UI replacement verification failed for ${targetId}: expected ${staged.length} pages, found ${finalPages.length}`);
      }
    }
    for (const page of staged) if (page.sourcePageId) mapping[page.sourcePageId] = page.targetPageId;
  }

  // -------------------------------------------------------------------------
  // Activity groups
  // -------------------------------------------------------------------------

  // Activity groups. Membership comes from the Primary's group details (`activity_ids`) and is written with the
  // Satellite's own activity ids. It is applied in two passes: first every activity is taken out of groups it must
  // leave, then each group gets its exact list — so an activity is never in two groups at once, and an activity that
  // belongs to the "Schlafzimmer" group on the Primary ends up there and not in whichever group happens to be the
  // Satellite's default.
  async #applyActivityGroups(sourceNode, records, mapping, report) {
    const local = {};
    const currentIds = new Set();
    const plans = [];
    for (const raw of records) {
      if (!raw || typeof raw !== "object") continue;
      const sourceId = firstIdentifier(raw, "group_id", "id");
      if (!sourceId) continue;
      currentIds.add(sourceId);
      const context = `activity group ${sourceId}`;
      const membership = this.#groupMembership(raw);
      let targetActivityIds = null;
      if (membership) {
        targetActivityIds = [];
        const missing = [];
        for (const activityId of membership) {
          const target = mapping[activityId] || this.mappings.get(sourceNode, "activity", activityId);
          if (target) targetActivityIds.push(String(target));
          else missing.push(activityId);
        }
        if (missing.length) report.warnings.push(`${context}: ${missing.length} activity/activities are not synchronized and were left out: ${missing.slice(0, 5).join(", ")}`);
        targetActivityIds = [...new Set(targetActivityIds)];
      }
      const metadata = this.#rewriteConfiguredReferences(this.#cleanPayload(editableFields(raw, ACTIVITY_GROUP_FIELDS)), mapping, report, context);
      delete metadata.activities;
      delete metadata.activity_ids;
      let targetId = this.mappings.get(sourceNode, "activity_group", sourceId);
      try {
        const groupDesired = { metadata, targetActivityIds };
        const observeGroup = () => this.client.getJson(`/activity_groups/${encodeURIComponent(targetId)}`, { optionalStatuses: [404] });
        if (targetId && await this.objectState.matches("activity_group", sourceId, targetId, groupDesired, observeGroup)) {
          local[sourceId] = targetId;
          mapping[sourceId] = targetId;
          incrementReport(report, "activity_groups_skipped");
          continue;
        }
        if (targetId && await this.#exists(`/activity_groups/${encodeURIComponent(targetId)}`)) {
          if (Object.keys(metadata).length) await this.client.json("PATCH", `/activity_groups/${encodeURIComponent(targetId)}`, { json: metadata, expected: [200] });
          incrementReport(report, "activity_groups_updated");
        } else if (await this.#exists(`/activity_groups/${encodeURIComponent(sourceId)}`)) {
          targetId = sourceId;
          if (Object.keys(metadata).length) await this.client.json("PATCH", `/activity_groups/${encodeURIComponent(targetId)}`, { json: metadata, expected: [200] });
          incrementReport(report, "activity_groups_updated");
        } else {
          const created = await this.client.json("POST", "/activity_groups", { json: { ...metadata, activity_ids: [] }, expected: [200, 201] });
          targetId = firstIdentifier(created, "group_id", "id");
          if (!targetId) throw new Error("Create response did not contain group_id");
          incrementReport(report, "activity_groups_created");
        }
        this.mappings.set(sourceNode, "activity_group", sourceId, targetId);
        local[sourceId] = targetId;
        mapping[sourceId] = targetId;
        plans.push({ sourceId, targetId: String(targetId), targetActivityIds, context, metadata });
      } catch (error) { report.errors.push(`Activity group ${sourceId}: ${error.message}`); }
    }

    await this.#applyGroupMembership(plans, report);
    if (!report.errors.length) for (const plan of plans) {
      await this.objectState.remember("activity_group", plan.sourceId, plan.targetId,
        { metadata: plan.metadata, targetActivityIds: plan.targetActivityIds },
        () => this.client.getJson(`/activity_groups/${encodeURIComponent(plan.targetId)}`, { optionalStatuses: [404] }));
    }
    if (this.config.sync.prune) await this.#pruneMapped(sourceNode, "activity_group", "activity_groups", currentIds, report);
    return local;
  }

  #groupMembership(raw) {
    if (Array.isArray(raw.activity_ids)) return raw.activity_ids.map(String).filter(Boolean);
    if (Array.isArray(raw.activities)) {
      const ids = raw.activities.map((item) => (typeof item === "string" ? item : firstIdentifier(item, "entity_id", "id"))).filter(Boolean).map(String);
      return ids;
    }
    return null;
  }

  async #groupActivityIds(groupId) {
    const detail = await this.client.getJson(`/activity_groups/${encodeURIComponent(groupId)}`, { optionalStatuses: [404] });
    if (!detail) return null;
    if (Array.isArray(detail.activity_ids)) return detail.activity_ids.map(String);
    return (Array.isArray(detail.activities) ? detail.activities : []).map((item) => (typeof item === "string" ? item : firstIdentifier(item, "entity_id", "id"))).filter(Boolean).map(String);
  }

  async #setGroupActivities(groupId, activityIds) {
    await this.client.json("PATCH", `/activity_groups/${encodeURIComponent(groupId)}`, { json: { activity_ids: activityIds }, expected: [200] });
  }

  async #applyGroupMembership(plans, report) {
    for (const plan of plans.filter((item) => !item.targetActivityIds)) report.warnings.push(`${plan.context}: membership unknown, left unchanged`);
    const known = plans.filter((plan) => plan.targetActivityIds);
    if (!known.length) return;
    const owner = new Map();
    for (const plan of known) for (const activityId of plan.targetActivityIds) owner.set(activityId, plan.targetId);
    const synchronizedGroups = new Set(plans.map((plan) => plan.targetId));

    // Pass 1: take activities out of every group they do not belong to — synchronized groups, and also groups that only
    // exist on this Satellite, for activities the Primary placed in a synchronized group.
    const current = new Map();
    let allGroups = [];
    try { allGroups = await this.client.listPaginated("/activity_groups", { optional: true }); }
    catch (error) { report.warnings.push(`Could not list this remote's activity groups: ${error.message}`); }
    const groupIds = new Set([...synchronizedGroups, ...allGroups.map((item) => firstIdentifier(item, "group_id", "id")).filter(Boolean).map(String)]);
    for (const groupId of groupIds) {
      let members;
      try { members = await this.#groupActivityIds(groupId); }
      catch (error) { report.warnings.push(`Could not read activity group ${groupId}: ${error.message}`); continue; }
      if (!members) continue;
      const plan = known.find((item) => item.targetId === groupId);
      const keep = plan
        ? members.filter((id) => plan.targetActivityIds.includes(id))
        : members.filter((id) => !owner.has(id));
      current.set(groupId, keep);
      if (keep.length === members.length) continue;
      try {
        await this.#setGroupActivities(groupId, keep);
        incrementReport(report, "activity_group_members_moved", members.length - keep.length);
      } catch (error) { report.errors.push(`Activity group ${groupId}: could not remove activities: ${error.message}`); }
    }

    // Pass 2: give every synchronized group exactly the Primary's activities, in the Primary's order.
    for (const plan of known) {
      const now = current.get(plan.targetId) || [];
      if (now.length === plan.targetActivityIds.length && now.every((id, index) => id === plan.targetActivityIds[index])) continue;
      try {
        await this.#setGroupActivities(plan.targetId, plan.targetActivityIds);
        incrementReport(report, "activity_group_memberships_updated");
      } catch (error) { report.errors.push(`${plan.context}: could not set activities: ${error.message}`); }
    }
  }

  // -------------------------------------------------------------------------
  // Specialized appliers
  // -------------------------------------------------------------------------

  #profileApplier() {
    return new ProfileApplier({
      adaptPage: (page, context) => this.hardware.page(page, context),
      client: this.client,
      config: this.config,
      mappings: this.mappings,
      objectState: this.objectState,
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
