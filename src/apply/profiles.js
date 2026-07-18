import { CoreApiError } from "../core/client.js";
import { incrementReport } from "../shared/models.js";
import { editableFields, firstIdentifier } from "../shared/util.js";
import { logger } from "../shared/logger.js";

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
    rewriteConfiguredReferences,
    configuredEntityIds,
    exists,
    pruneMapped,
    responseList,
    webSocketCompatibilityError
  }) {
    this.client = client;
    this.config = config;
    this.mappings = mappings;
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
      const detail = record.detail || {};
      if (!sourceId) continue;
      currentIds.add(sourceId);
      let targetId = this.mappings.get(sourceNode, "profile", sourceId) || sourceId;
      const profilePayload = this.rewriteConfiguredReferences(editableFields(detail, PROFILE_FIELDS), mapping, report, `profile ${sourceId}`);
      delete profilePayload.profile_id;
      try {
        const exists = await this.#profileExists(targetId);
        let result;
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
        targetId = firstIdentifier(result?.profile || result, "profile_id", "id") || targetId;
        incrementReport(report, exists ? "profiles_updated" : "profiles_created");
        this.mappings.set(sourceNode, "profile", sourceId, targetId);
        local[sourceId] = targetId;
        mapping[sourceId] = targetId;
        await this.#replaceChildren(sourceNode, sourceId, targetId, record, mapping, report);
        if (!(await this.#profileExists(targetId))) throw new Error(`Profile ${targetId} was not visible after apply`);
      } catch (error) {
        report.errors.push(`Profile ${sourceId}: ${error.message}`);
      }
    }
    const profileErrors = report.errors.filter((item) => String(item).startsWith("Profile "));
    if (!profileErrors.length && payload.active !== null && payload.active !== undefined) {
      const activeValue = payload.active?.profile || payload.active;
      const sourceActive = typeof activeValue === "object" ? firstIdentifier(activeValue, "profile_id", "id") : String(activeValue);
      if (sourceActive) await this.#setActive(mapping[sourceActive] || sourceActive, report);
    } else if (profileErrors.length) {
      report.warnings.push("Active profile was not switched because profile restoration was incomplete");
    }
    if (this.config.sync.prune) await this.pruneMapped(sourceNode, "profile", "profiles", currentIds, report);
    return local;
  }

  async #replaceChildren(sourceNode, sourceProfileId, profileId, record, mapping, report) {
    const pages = Array.isArray(record.pages) ? record.pages : [];
    const groups = Array.isArray(record.groups) ? record.groups : [];

    await this.#resetChildren(profileId, "pages", report);
    await this.#resetChildren(profileId, "groups", report);

    for (const group of groups) {
      const sourceGroupId = firstIdentifier(group, "group_id", "id");
      const payload = this.rewriteConfiguredReferences(editableFields(group, PROFILE_GROUP_FIELDS), mapping, report, `profile ${sourceProfileId} group`);
      const result = await this.#createChild(profileId, "group", payload);
      const targetGroupId = firstIdentifier(result?.group || result, "group_id", "id");
      if (!targetGroupId) throw new Error(`Created profile group ${sourceGroupId || "unknown"} did not return group_id`);
      if (sourceGroupId) {
        this.mappings.set(sourceNode, `profile_group:${sourceProfileId}`, sourceGroupId, targetGroupId);
        mapping[sourceGroupId] = targetGroupId;
      }
      incrementReport(report, "profile_groups_created");
    }

    for (const page of pages) {
      const sourcePageId = firstIdentifier(page, "page_id", "id");
      const context = `profile ${sourceProfileId} page ${sourcePageId || "unknown"}`;
      const payload = this.rewriteConfiguredReferences(editableFields(page, PAGE_FIELDS), mapping, report, context);
      const result = await this.#createPage(profileId, payload, report, context);
      const targetPageId = firstIdentifier(result?.page || result, "page_id", "id");
      if (!targetPageId) throw new Error(`Created profile page ${sourcePageId || "unknown"} did not return page_id`);
      if (sourcePageId) {
        this.mappings.set(sourceNode, `profile_page:${sourceProfileId}`, sourcePageId, targetPageId);
        mapping[sourcePageId] = targetPageId;
      }
      incrementReport(report, "profile_pages_created");
    }

    const visiblePages = await this.#listChildren(profileId, "pages");
    const visibleGroups = await this.#listChildren(profileId, "groups");
    if (visiblePages.length !== pages.length) throw new Error(`Profile ${profileId} page verification failed: expected ${pages.length}, found ${visiblePages.length}`);
    if (visibleGroups.length !== groups.length) throw new Error(`Profile ${profileId} group verification failed: expected ${groups.length}, found ${visibleGroups.length}`);
    log.info(`Restored profile ${sourceProfileId} with ${pages.length} page(s) and ${groups.length} group(s)`);
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
    if (!pageId) throw new Error("Created profile page did not return page_id");

    const applyPayload = async (value) => {
      await this.#updatePage(profileId, pageId, value);
      return { ...(created?.page || created || {}), ...value, page_id: pageId };
    };

    try {
      return await applyPayload(sanitized);
    } catch (error) {
      if (!this.#invalidPageEntitiesError(error)) throw error;
      const shell = structuredClone(sanitized);
      let cleared = 0;
      for (const key of ["items", "entities"]) {
        if (Array.isArray(shell[key]) && shell[key].length) {
          cleared += shell[key].length;
          shell[key] = [];
        }
      }
      if (!cleared && Array.isArray(payload.items)) shell.items = [];
      if (!cleared && Array.isArray(payload.entities)) shell.entities = [];
      const result = await applyPayload(shell);
      report.warnings.push(`${context}: Core rejected the page entity layout; created the page shell without ${cleared || "its"} invalid item(s)`);
      return result;
    }
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
        if (this.#invalidPageEntitiesError(error) || !this.webSocketCompatibilityError(error)) throw error;
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
        return;
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
        return;
      } catch (error) {
        if (!(error instanceof CoreApiError) || ![404, 405].includes(error.status)) report.warnings.push(`Set active profile attempt failed: ${error.message}`);
      }
    }
    report.warnings.push("Active profile endpoint was not available on this Core API version");
  }
}
