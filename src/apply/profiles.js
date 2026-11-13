import { CoreApiError } from "../core/client.js";
import { incrementReport } from "../shared/models.js";
import { editableFields, firstIdentifier } from "../shared/util.js";
import { logger } from "../shared/logger.js";
import { configuredFieldsEqual, referencedMappings } from "./object-state.js";

const log = logger("profile-applier");
const PROFILE_FIELDS = new Set(["profile_id", "name", "icon", "description", "restricted", "settings"]);
const PAGE_FIELDS = new Set(["name", "icon", "image", "grid", "items", "entities", "pos", "order", "options"]);
const PROFILE_GROUP_FIELDS = new Set(["name", "icon", "description", "entities", "entity_ids", "options"]);

// -----------------------------------------------------------------------------
// Profile graph restoration
// -----------------------------------------------------------------------------

export class ProfileApplier {
  constructor({
    client,
    config,
    mappings,
    objectState,
    rewriteConfiguredReferences,
    configuredEntityIds,
    exists,
    pruneMapped,
    responseList,
    webSocketCompatibilityError,
    adaptPage = (page) => page
  }) {
    this.adaptPage = adaptPage;
    this.client = client;
    this.config = config;
    this.mappings = mappings;
    this.objectState = objectState;
    this.rewriteConfiguredReferences = rewriteConfiguredReferences;
    this.configuredEntityIds = configuredEntityIds;
    this.exists = exists;
    this.pruneMapped = pruneMapped;
    this.responseList = responseList;
    this.webSocketCompatibilityError = webSocketCompatibilityError;
  }

  async apply(sourceNode, payload, mapping, report) {
    const local = {};
    const currentIds = new Set();
    for (const record of payload.items || []) {
      const sourceId = String(record.source_id || "");
      if (!sourceId) continue;
      currentIds.add(sourceId);
      let targetId = this.mappings.get(sourceNode, "profile", sourceId) || sourceId;
      const profilePayload = this.rewriteConfiguredReferences(editableFields(record.detail || {}, PROFILE_FIELDS), mapping, report, `profile ${sourceId}`);
      delete profilePayload.profile_id;
      const desired = { detail: profilePayload, pages: record.pages || [], groups: record.groups || [],
        mapped_references: referencedMappings({ pages: record.pages || [], groups: record.groups || [] }, mapping) };
      const observe = () => this.#observeProfile(targetId);
      try {
        if (await this.objectState?.matches("profile", sourceId, targetId, desired, observe)) {
          local[sourceId] = targetId;
          mapping[sourceId] = targetId;
          incrementReport(report, "profiles_skipped");
          continue;
        }
        const exists = await this.#profileExists(targetId);
        const current = exists ? await this.#profileDetail(targetId) : null;
        let result;
        if (!exists || !configuredFieldsEqual(current, profilePayload)) {
          if (typeof this.client.coreMessage === "function") {
            try {
              result = await this.client.coreMessage(exists ? "update_profile" : "add_profile", { ...profilePayload, profile_id: targetId }, 30_000);
            } catch (error) {
              if (!this.webSocketCompatibilityError(error)) throw error;
              result = null;
            }
          }
          if (result === null || result === undefined) {
            if (exists) await this.client.json("PATCH", `/profiles/${encodeURIComponent(targetId)}`, { json: profilePayload, expected: [200] });
            else result = await this.client.json("POST", "/profiles", { json: { ...profilePayload, profile_id: targetId }, expected: [200, 201] });
          }
          incrementReport(report, exists ? "profiles_updated" : "profiles_created");
        } else incrementReport(report, "profile_metadata_skipped");
        targetId = firstIdentifier(result?.profile || result, "profile_id", "id") || targetId;
        this.mappings.set(sourceNode, "profile", sourceId, targetId);
        local[sourceId] = targetId;
        mapping[sourceId] = targetId;
        await this.#replaceChildren(sourceNode, sourceId, targetId, record, mapping, report);
        if (!(await this.#profileExists(targetId))) throw new Error(`Profile ${targetId} was not visible after apply`);
        await this.objectState?.remember("profile", sourceId, targetId, desired, () => this.#observeProfile(targetId));
      } catch (error) {
        report.errors.push(`Profile ${sourceId}: ${error.message}`);
      }
    }
    const profileErrors = report.errors.filter((item) => String(item).startsWith("Profile "));
    if (!profileErrors.length && payload.active !== null && payload.active !== undefined) {
      const activeValue = payload.active?.profile || payload.active;
      const sourceActive = typeof activeValue === "object" ? firstIdentifier(activeValue, "profile_id", "id") : String(activeValue);
      if (sourceActive) {
        const target = mapping[sourceActive] || sourceActive;
        if (!(await this.objectState?.matches("active_profile", sourceNode, target, { profile_id: target }))) {
          if (await this.#setActive(target, report)) {
            await this.objectState?.remember("active_profile", sourceNode, target, { profile_id: target });
          }
        } else incrementReport(report, "active_profile_skipped");
      }
    } else if (profileErrors.length) report.warnings.push("Active profile was not switched because profile restoration was incomplete");
    if (this.config.sync.prune) await this.pruneMapped(sourceNode, "profile", "profiles", currentIds, report);
    return local;
  }

  async #profileDetail(profileId) {
    if (typeof this.client.coreMessage === "function") {
      try {
        const result = await this.client.coreMessage("get_profile", { profile_id: String(profileId) }, 15_000);
        return result?.profile || result;
      }
      catch (error) { if (!this.webSocketCompatibilityError(error)) throw error; }
    }
    return this.client.getJson(`/profiles/${encodeURIComponent(profileId)}`, { optionalStatuses: [404] });
  }

  async #observeProfile(profileId) {
    const detail = await this.#profileDetail(profileId);
    if (!detail) return null;
    const pages = await this.#listChildren(profileId, "pages");
    const groups = await this.#listChildren(profileId, "groups");
    return { detail, pages, groups };
  }

  async #replaceChildren(sourceNode, sourceProfileId, profileId, record, mapping, report) {
    const groups = Array.isArray(record.groups) ? record.groups : [];
    const pages = Array.isArray(record.pages) ? record.pages : [];
    await this.#syncChildren(sourceNode, sourceProfileId, profileId, "groups", groups, mapping, report);
    await this.#syncChildren(sourceNode, sourceProfileId, profileId, "pages", pages, mapping, report);
    log.info(`Reconciled profile ${sourceProfileId} with ${pages.length} page(s) and ${groups.length} group(s)`);
  }

  async #syncChildren(sourceNode, sourceProfileId, profileId, childName, desired, mapping, report) {
    const isPage = childName === "pages";
    const kind = isPage ? "page" : "group";
    const idField = isPage ? "page_id" : "group_id";
    const mappingKind = `profile_${kind}:${sourceProfileId}`;
    const existing = await this.#listChildren(profileId, childName);
    const used = new Set();
    const staged = [];
    // Empty collections can be reset without affecting the UI, retaining API
    // compatibility with Cores that create an implicit blank page/group.
    if (existing.length === 0) await this.#resetChildren(profileId, childName, report);
    try {
      for (const [index, item] of desired.entries()) {
        const sourceId = firstIdentifier(item, idField, "id") || `index:${index}`;
        const context = `profile ${sourceProfileId} ${kind} ${sourceId}`;
        const raw = editableFields(item, isPage ? PAGE_FIELDS : PROFILE_GROUP_FIELDS);
        const payload = this.rewriteConfiguredReferences(raw, mapping, report, context);
        const adapted = isPage ? this.adaptPage(payload, context) : payload;
        const mappedId = this.mappings.get(sourceNode, mappingKind, sourceId);
        const candidate = existing.find((entry) => firstIdentifier(entry, idField, "id") === mappedId)
          || existing.find((entry) => firstIdentifier(entry, idField, "id") === sourceId)
          || (!mappedId && existing[index] && !used.has(String(firstIdentifier(existing[index], idField, "id"))) ? existing[index] : null);
        const targetId = candidate ? firstIdentifier(candidate, idField, "id") : null;
        const observe = async () => (await this.#listChildren(profileId, childName))
          .find((entry) => firstIdentifier(entry, idField, "id") === targetId) || null;
        if (targetId && await this.objectState?.matches(mappingKind, sourceId, targetId, adapted, observe)) {
          used.add(String(targetId));
          incrementReport(report, `profile_${childName}_skipped`);
        } else if (targetId && configuredFieldsEqual(candidate, adapted)) {
          used.add(String(targetId));
          incrementReport(report, `profile_${childName}_skipped`);
          await this.objectState?.remember(mappingKind, sourceId, targetId, adapted, observe);
        } else if (targetId) {
          if (isPage) await this.#updatePage(profileId, targetId, adapted);
          else await this.#updateGroup(profileId, targetId, adapted);
          used.add(String(targetId));
          incrementReport(report, `profile_${childName}_updated`);
          await this.objectState?.remember(mappingKind, sourceId, targetId, adapted, observe);
        } else {
          const created = isPage
            ? await this.#createPage(profileId, adapted, report, context)
            : await this.#createChild(profileId, "group", adapted);
          const newId = firstIdentifier(created?.[kind] || created, idField, "id");
          if (!newId) throw new Error(`${context}: Core did not return ${idField}`);
          staged.push(String(newId));
          used.add(String(newId));
          incrementReport(report, `profile_${childName}_created`);
          await this.objectState?.remember(mappingKind, sourceId, newId, adapted, async () =>
            (await this.#listChildren(profileId, childName)).find((entry) => firstIdentifier(entry, idField, "id") === newId) || null);
        }
        if (!sourceId.startsWith("index:")) {
          const id = targetId || staged[staged.length - 1];
          this.mappings.set(sourceNode, mappingKind, sourceId, id);
          mapping[sourceId] = id;
        }
      }
    } catch (error) {
      // A validation failure must not destroy the previous layout. Delete only
      // pages created by this attempt; existing pages remain in place.
      for (const id of staged) {
        try { await this.#deleteChild(profileId, kind, id); }
        catch (rollbackError) { report.warnings.push(`Could not roll back ${kind} ${id}: ${rollbackError.message}`); }
      }
      throw error;
    }
    for (const item of existing) {
      const id = firstIdentifier(item, idField, "id");
      if (id && !used.has(String(id))) await this.#deleteChild(profileId, kind, id);
    }
    const visible = await this.#listChildren(profileId, childName);
    if (visible.length !== desired.length) throw new Error(`Profile ${profileId} ${childName} verification failed: expected ${desired.length}, found ${visible.length}`);
  }

  async #deleteChild(profileId, kind, id) {
    if (typeof this.client.coreMessage === "function") {
      try {
        await this.client.coreMessage(kind === "page" ? "delete_page" : "delete_group", {
          profile_id: String(profileId), [`${kind}_id`]: String(id)
        }, 30_000);
        return;
      } catch (error) { if (!this.webSocketCompatibilityError(error)) throw error; }
    }
    await this.client.json("DELETE", `/profiles/${encodeURIComponent(profileId)}/${kind}s/${encodeURIComponent(id)}`, { expected: [200, 204], optionalStatuses: [404] });
  }

  async #updateGroup(profileId, groupId, payload) {
    if (typeof this.client.coreMessage === "function") {
      try {
        await this.client.coreMessage("update_group", { profile_id: String(profileId), group_id: String(groupId), ...payload }, 30_000);
        return;
      } catch (error) { if (!this.webSocketCompatibilityError(error)) throw error; }
    }
    await this.client.json("PATCH", `/profiles/${encodeURIComponent(profileId)}/groups/${encodeURIComponent(groupId)}`, { json: payload, expected: [200] });
  }

  async #profileExists(profileId) {
    if (typeof this.client.coreMessage === "function") {
      try {
        return Boolean(await this.client.coreMessage("get_profile", { profile_id: String(profileId) }, 15_000));
      } catch (error) {
        if (!this.webSocketCompatibilityError(error) && Number(error?.code) !== 404) throw error;
      }
    }
    return this.exists(`/profiles/${encodeURIComponent(profileId)}`);
  }

  async #resetChildren(profileId, childName, report) {
    const singular = childName === "pages" ? "page" : "group";
    if (typeof this.client.coreMessage === "function") {
      try {
        await this.client.coreMessage(childName === "pages" ? "delete_pages_in_profile" : "delete_groups_in_profile", { profile_id: String(profileId) }, 30_000);
        return;
      } catch (error) {
        if (!this.webSocketCompatibilityError(error)) throw error;
        report.warnings.push(`Core WebSocket profile ${childName} reset unavailable; using REST compatibility path: ${error.message}`);
      }
    }
    await this.client.json("DELETE", `/profiles/${encodeURIComponent(profileId)}/${childName}`, { expected: [200, 204], optionalStatuses: [404, 405] });
    const remaining = await this.#listChildren(profileId, childName);
    if (remaining.length) throw new Error(`Could not reset profile ${singular}s for ${profileId}`);
  }

  async #createPage(profileId, payload, report, context) {
    const configured = await this.configuredEntityIds();
    const { payload: sanitized, removed } = this.#sanitizePagePayload(payload, configured);
    if (removed > 0) report.warnings.push(`${context}: removed ${removed} structurally invalid or unavailable page item(s)`);
    const created = await this.#createPageShell(profileId, sanitized);
    const pageId = firstIdentifier(created?.page || created, "page_id", "id");
    if (!pageId) throw new Error(`${context}: Core did not return a page ID`);
    try {
      await this.#updatePage(profileId, pageId, sanitized);
    } catch (error) {
      // Never treat a rejected page as a successfully applied blank page.
      // Remove the new shell and keep all pre-existing pages untouched.
      try { await this.#deleteChild(profileId, "page", pageId); }
      catch (rollbackError) { report.warnings.push(`${context}: could not remove rejected page shell ${pageId}: ${rollbackError.message}`); }
      throw new Error(`${context}: Core rejected page content; old pages were preserved: ${error.message}`);
    }
    return { ...(created?.page || created || {}), ...sanitized, page_id: pageId };
  }

  async #createPageShell(profileId, payload) {
    const shell = Object.fromEntries(Object.entries({ name: payload?.name, pos: payload?.pos ?? payload?.order }).filter(([, value]) => value !== undefined));
    if (typeof this.client.coreMessage === "function") {
      try {
        return await this.client.coreMessage("add_page", { profile_id: String(profileId), ...shell }, 30_000);
      } catch (error) {
        if (!this.webSocketCompatibilityError(error)) throw error;
      }
    }
    return this.client.json("POST", `/profiles/${encodeURIComponent(profileId)}/pages`, { json: payload, expected: [200, 201] });
  }

  async #updatePage(profileId, pageId, payload) {
    if (typeof this.client.coreMessage === "function") {
      try {
        return await this.client.coreMessage("update_page", { profile_id: String(profileId), page_id: String(pageId), ...payload }, 30_000);
      } catch (error) {
        if (this.#invalidPageEntitiesError(error) || this.#pageValidationError(error) || !this.webSocketCompatibilityError(error)) throw error;
      }
    }
    const endpoints = [
      `/profiles/${encodeURIComponent(profileId)}/pages/${encodeURIComponent(pageId)}`,
      `/pages/${encodeURIComponent(pageId)}`
    ];
    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        return await this.client.json("PATCH", endpoint, { json: payload, expected: [200] });
      } catch (error) {
        lastError = error;
        if (this.#invalidPageEntitiesError(error)) throw error;
        if (!(error instanceof CoreApiError) || ![404, 405].includes(error.status)) throw error;
      }
    }
    throw lastError || new Error(`Profile page ${pageId} could not be updated`);
  }

  #pageValidationError(error) {
    const message = `${error?.message || ""} ${JSON.stringify(error?.body || {})}`;
    return Number(error?.code || error?.status) === 400
      && /validation|invalid .*widget|invalid .*config|feature not found|number_id|entity_id/i.test(message);
  }

  #invalidPageEntitiesError(error) {
    const text = `${error?.message || ""} ${JSON.stringify(error?.body || {})}`.toLowerCase();
    return text.includes("invalid page entities") || (/items\[\d+\]\.(position|pos)/.test(text) && text.includes("validation"));
  }

  #sanitizePagePayload(payload, configuredIds) {
    const known = new Set([...configuredIds].map(String));
    const fullId = /^[A-Za-z0-9_:-]+\.main\./;
    const result = structuredClone(payload);
    let removed = 0;
    for (const key of ["items", "entities"]) {
      if (!Array.isArray(result[key])) continue;
      const sanitized = [];
      for (const raw of result[key]) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          removed += 1;
          continue;
        }
        const item = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null && value !== undefined));
        const nestedEntity = item.entity && typeof item.entity === "object" ? item.entity : null;
        const nestedGroup = item.group && typeof item.group === "object" ? item.group : null;
        const entityValue = item.entity_id ?? nestedEntity?.entity_id;
        const groupValue = item.group_id ?? nestedGroup?.group_id;
        const entityId = typeof entityValue === "string" && entityValue.trim() ? entityValue.trim() : null;
        const groupId = typeof groupValue === "string" && groupValue.trim() ? groupValue.trim() : null;
        const normalized = {};
        if (entityId && (!fullId.test(entityId) || known.has(entityId) || entityId.startsWith("uc.main."))) normalized.entity_id = entityId;
        else if (groupId) normalized.group_id = groupId;
        else {
          removed += 1;
          continue;
        }
        normalized.pos = sanitized.length + 1;
        sanitized.push(normalized);
      }
      result[key] = sanitized;
    }
    return { payload: result, removed };
  }

  async #createChild(profileId, kind, payload) {
    if (typeof this.client.coreMessage === "function") {
      try {
        return await this.client.coreMessage(kind === "page" ? "add_page" : "add_group", { profile_id: String(profileId), ...payload }, 30_000);
      } catch (error) {
        if (!this.webSocketCompatibilityError(error)) throw error;
      }
    }
    return this.client.json("POST", `/profiles/${encodeURIComponent(profileId)}/${kind}s`, { json: payload, expected: [200, 201] });
  }

  async #listChildren(profileId, childName) {
    if (typeof this.client.coreMessage === "function") {
      try {
        const response = await this.client.coreMessage(childName === "pages" ? "get_pages" : "get_groups", { profile_id: String(profileId) }, 30_000);
        return this.responseList(response, childName);
      } catch (error) {
        if (!this.webSocketCompatibilityError(error)) throw error;
      }
    }
    return this.client.listPaginated(`/profiles/${encodeURIComponent(profileId)}/${childName}`, { optional: true });
  }

  async #setActive(profileId, report) {
    if (typeof this.client.coreMessage === "function") {
      try {
        await this.client.coreMessage("switch_profile", { profile_id: String(profileId) }, 30_000);
        incrementReport(report, "active_profile_updated");
        return true;
      } catch (error) {
        if (!this.webSocketCompatibilityError(error)) report.warnings.push(`Set active profile through Core WebSocket failed: ${error.message}`);
      }
    }
    const attempts = [
      ["PUT", "/profiles", undefined, { active_profile_id: profileId }],
      ["PUT", "/profiles/active", { profile_id: profileId }, undefined],
      ["PATCH", "/profiles/active", { profile_id: profileId }, undefined],
      ["PUT", `/profiles/${encodeURIComponent(profileId)}/active`, undefined, undefined]
    ];
    for (const [method, endpoint, body, params] of attempts) {
      try {
        await this.client.json(method, endpoint, { json: body, params, expected: [200, 204] });
        incrementReport(report, "active_profile_updated");
        return true;
      } catch (error) {
        if (!(error instanceof CoreApiError) || ![404, 405].includes(error.status)) report.warnings.push(`Set active profile attempt failed: ${error.message}`);
      }
    }
    report.warnings.push("Active profile endpoint was not available on this Core API version");
    return false;
  }
}
