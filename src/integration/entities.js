import crypto from "node:crypto";
import * as uc from "./api.js";
import { ACTIVITY_RELAY_LOCAL_ID } from "../shared/constants.js";
import { logger } from "../shared/logger.js";

const log = logger("entities");

// -----------------------------------------------------------------------------
// Proxy entity factory
// -----------------------------------------------------------------------------

// The Remote waits about 10 seconds for an entity command and then reports a timeout. Forwarding to the Primary can
// take longer (a sleeping Primary is woken first, and the Primary's Core only answers an activity command once the
// activity has run), so commands answer the Remote before that deadline and finish in the background.
export const COMMAND_ANSWER_DEADLINE_MS = 8000;
export const RELAY_ANSWER_DEADLINE_MS = 2500;

export async function answerWithin(promise, deadlineMs, onLate) {
  let timer = null;
  const late = Symbol("late");
  const result = await Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(late), deadlineMs); })
  ]).finally(() => clearTimeout(timer));
  if (result !== late) return result;
  promise.then(onLate, (error) => onLate({ success: false, error: error.message }));
  return { success: true, pending: true };
}

function proxyEntity(descriptor, service) {
  return new uc.Entity(
    descriptor.local_id,
    descriptor.name,
    descriptor.entity_type,
    {
      icon: descriptor.icon,
      description: descriptor.description,
      features: descriptor.features || [],
      attributes: descriptor.attributes || { state: "UNKNOWN" },
      deviceClass: descriptor.device_class,
      options: descriptor.options,
      area: descriptor.area,
      cmdHandler: async (_entity, cmdId, params) => {
        // The Integration API delivers short command ids ("on", "play_pause"); the Primary's Core REST API expects
        // them qualified with the entity type ("media_player.play_pause"). The Primary tries the qualified form first.
        const forwarded = service.forwardProxyCommand(descriptor.source_entity_id, cmdId, params, { entityType: descriptor.entity_type });
        const result = await answerWithin(forwarded, COMMAND_ANSWER_DEADLINE_MS, (late) => {
          if (!late?.success) log.warn(`${cmdId} for ${descriptor.source_entity_id} failed on the Primary after the Remote was answered: ${late?.error || `HTTP ${late?.status}`}`);
        });
        if (result.pending) log.info(`${cmdId} for ${descriptor.source_entity_id} is still running on the Primary; answered the Remote early`);
        else if (!result.success) log.warn(`${cmdId} for ${descriptor.source_entity_id} failed: ${result.error || `HTTP ${result.status}`}`);
        return result.success ? uc.StatusCodes.Ok : (result.status || uc.StatusCodes.ServiceUnavailable);
      }
    }
  );
}

const SATELLITE_ACTIONS = Object.freeze([
  { action: "sync", label: "Synchronize" },
  { action: "preview", label: "Preview" },
  { action: "update", label: "Update Remote Sync", when: (satellite) => satellite.managed },
  { action: "disable", label: "Disable", when: (satellite) => satellite.enabled },
  { action: "enable", label: "Enable", when: (satellite) => !satellite.enabled },
  { action: "rediscover", label: "Rediscover" },
  { action: "rotate", label: "Rotate credentials" },
  { action: "unpair", label: "Unpair" }
]);

function satelliteKey(peerId) {
  return crypto.createHash("sha256").update(String(peerId)).digest("hex").slice(0, 12);
}

// -----------------------------------------------------------------------------
// Entity manager
// -----------------------------------------------------------------------------

export class EntityManager {
  constructor(api, service) {
    this.api = api;
    this.service = service;
    this.registered = false;
    this.proxyIds = new Set();
    this.satelliteIds = new Set();
    service.addStatusListener((status, config) => this.onStatus(status, config));
    service.addProxyListener((catalog) => this.applyProxyCatalog(catalog));
    service.addProxyStateListener?.((changes) => this.applyProxyStates(changes));
  }

  // Live attribute changes of proxy entities; reported to the Remote for subscribed entities.
  applyProxyStates(changes) {
    if (!this.registered) return;
    for (const { local_id: id, attributes } of changes || []) {
      if (!this.proxyIds.has(id)) continue;
      this.api.getAvailableEntities().updateEntityAttributes(id, attributes);
      this.api.updateEntityAttributes(id, attributes);
    }
  }

  register() {
    if (this.registered) return;
    const sensors = [
      this.#sensor("status", "Remote Sync status", "unconfigured", "uc:information-circle"),
      this.#sensor("role", "Remote Sync role", "unconfigured", "uc:server-stack"),
      this.#sensor("last_sync", "Last synchronization", "Never", "uc:clock"),
      this.#sensor("last_result", "Last synchronization result", "Never synchronized", "uc:list-bullet"),
      this.#sensor("last_preview", "Last synchronization preview", "Never", "uc:document-magnifying-glass"),
      this.#sensor("peer_count", "Satellite peer count", 0, "uc:users"),
      this.#sensor("pending", "Pending configuration changes", "No", "uc:arrow-path"),
      this.#sensor("agent_url", "Remote Sync agent URL", "Not configured", "uc:link"),
      this.#sensor("pairing_identifier", "Remote Sync pairing identifier", "Not configured", "uc:key"),
      this.#sensor("proxy_count", "Mirrored entity count", 0, "uc:squares-plus")
    ];
    for (const entity of sensors) this.api.addAvailableEntity(entity);
    this.api.addAvailableEntity(new uc.Button("sync_now", { en: "Synchronize now" }, {
      icon: "uc:arrow-path-rounded-square",
      cmdHandler: async () => (await this.service.syncNow(true)).success ? uc.StatusCodes.Ok : uc.StatusCodes.ServiceUnavailable
    }));
    this.api.addAvailableEntity(new uc.Button("preview_sync", { en: "Preview synchronization" }, {
      icon: "uc:document-magnifying-glass",
      cmdHandler: async () => (await this.service.previewSync()).success ? uc.StatusCodes.Ok : uc.StatusCodes.ServiceUnavailable
    }));
    this.api.addAvailableEntity(new uc.Button("reconcile", { en: "Reconcile connection" }, {
      icon: "uc:signal",
      cmdHandler: async () => (await this.service.reconcile()).success ? uc.StatusCodes.Ok : uc.StatusCodes.ServiceUnavailable
    }));
    this.api.addAvailableEntity(new uc.Button(ACTIVITY_RELAY_LOCAL_ID, { en: "Remote Sync activity relay" }, {
      icon: "uc:arrow-right-circle",
      cmdHandler: async (_entity, _cmdId, params) => {
        const sourceActivityId = String(params?.source_activity_id || "").trim();
        const action = String(params?.action || "").trim().toLowerCase();
        if (!sourceActivityId || !["on", "off"].includes(action)) {
          log.warn(`Activity relay received ${_cmdId} without usable parameters (${JSON.stringify(params ?? null)}); the activity sequence on this Satellite may be outdated — run a synchronization from the Primary`);
          return uc.StatusCodes.BadRequest;
        }
        // The Satellite's activity only consists of this relay step, so it must not hold the activity open while the
        // Primary runs its own (often longer) sequence.
        const forwarded = this.service.forwardActivityCommand(sourceActivityId, action);
        const report = (result) => {
          if (result?.success) log.info(`Relayed activity ${sourceActivityId} ${action} to the Primary`);
          else log.warn(`Relaying activity ${sourceActivityId} ${action} to the Primary failed: ${result?.error || `HTTP ${result?.status}`}`);
        };
        const result = await answerWithin(forwarded, RELAY_ANSWER_DEADLINE_MS, report);
        if (!result.pending) report(result);
        return result.success ? uc.StatusCodes.Ok : (result.status || uc.StatusCodes.ServiceUnavailable);
      }
    }));
    this.registered = true;
    this.applyProxyCatalog(this.service.proxyCatalog);
    this.onStatus(this.service.status, this.service.config);
  }

  #sensor(id, name, value, icon) {
    return new uc.Sensor(id, { en: name }, {
      icon,
      deviceClass: uc.SensorDeviceClasses.Custom,
      attributes: {
        [uc.SensorAttributes.State]: uc.SensorStates.On,
        [uc.SensorAttributes.Value]: value
      }
    });
  }

  // -------------------------------------------------------------------------
  // Proxy catalog
  // -------------------------------------------------------------------------

  applyProxyCatalog(catalog) {
    if (!this.registered) return;
    const next = new Set();
    for (const descriptor of catalog?.entities || []) {
      const entity = proxyEntity(descriptor, this.service);
      next.add(entity.id);
      this.api.upsertAvailableEntity(entity);
      const configured = this.api.getConfiguredEntities().getEntity(entity.id);
      if (configured) this.api.getConfiguredEntities().upsertEntity(proxyEntity(descriptor, this.service));
    }
    for (const id of this.proxyIds) {
      if (next.has(id)) continue;
      this.api.removeAvailableEntity(id);
      this.api.removeConfiguredEntity(id);
    }
    this.proxyIds = next;
    this.onStatus(this.service.status, this.service.config);
  }

  // -------------------------------------------------------------------------
  // Satellite management entities
  // -------------------------------------------------------------------------

  // One status sensor and one action select per Satellite. Detailed information (version, network, errors, preview
  // results) lives in the web dashboard; previous releases exposed six sensors and seven buttons per Satellite.
  #applySatellites(config) {
    const next = new Set();
    if (config?.role !== "master") {
      this.#removeSatelliteEntities(next);
      return;
    }
    for (const satellite of this.service.listSatellites(false)) {
      const key = satelliteKey(satellite.peer_id);
      const prefix = `satellite_${key}`;
      const state = satellite.updating ? "Updating"
        : satellite.online ? (satellite.enabled ? "Online" : "Online, disabled") : (satellite.enabled ? "Offline" : "Disabled");
      const summary = [
        state,
        satellite.version || satellite.protocol?.version || null,
        satellite.last_sync_at ? `synced ${satellite.last_sync_at}` : "never synced",
        satellite.last_error ? `error: ${satellite.last_error}` : null
      ].filter(Boolean).join(" — ");
      const sensor = this.#sensor(`${prefix}_status`, `${satellite.name} status`, summary, "uc:server");
      next.add(sensor.id);
      this.api.upsertAvailableEntity(sensor);
      this.#updateValue(sensor.id, summary);

      const actions = SATELLITE_ACTIONS.filter((item) => !item.when || item.when(satellite));
      const options = actions.map((item) => item.label);
      const select = new uc.Select(`${prefix}_action`, { en: `${satellite.name} action`, de: `${satellite.name} Aktion` }, {
        icon: "uc:server",
        options,
        currentOption: "",
        cmdHandler: async (_entity, cmdId, params) => {
          if (cmdId !== "select_option") return uc.StatusCodes.NotImplemented;
          const selected = actions.find((item) => item.label === String(params?.option || ""));
          if (!selected) return uc.StatusCodes.BadRequest;
          this.#updateSelect(`${prefix}_action`, { current_option: selected.label });
          try {
            const result = await this.service.manageSatellite(satellite.peer_id, selected.action);
            return result?.success === false ? uc.StatusCodes.ServiceUnavailable : uc.StatusCodes.Ok;
          } catch {
            return uc.StatusCodes.ServiceUnavailable;
          } finally {
            this.#updateSelect(`${prefix}_action`, { current_option: "" });
          }
        }
      });
      next.add(select.id);
      this.api.upsertAvailableEntity(select);
      this.#updateSelect(select.id, { options, state: uc.SelectStates.On });
    }
    this.#removeSatelliteEntities(next);
    this.satelliteIds = next;
  }

  #updateSelect(id, attributes) {
    this.api.getAvailableEntities().updateEntityAttributes(id, attributes);
    this.api.updateEntityAttributes(id, attributes);
  }

  #removeSatelliteEntities(next) {
    for (const id of this.satelliteIds) {
      if (next.has(id)) continue;
      this.api.removeAvailableEntity(id);
      this.api.removeConfiguredEntity(id);
    }
    this.satelliteIds = next;
  }

  // -------------------------------------------------------------------------
  // Status updates
  // -------------------------------------------------------------------------

  #updateValue(id, value) {
    const attributes = {
      [uc.SensorAttributes.State]: uc.SensorStates.On,
      [uc.SensorAttributes.Value]: value
    };
    this.api.getAvailableEntities().updateEntityAttributes(id, attributes);
    this.api.updateEntityAttributes(id, attributes);
  }

  onStatus(status, config) {
    if (!this.registered) return;
    const values = {
      status: status.state,
      role: config?.role === "master" ? "primary" : config?.role === "child" ? "satellite" : config?.role === "unassigned" ? "role not chosen" : "unconfigured",
      last_sync: status.last_sync_at || "Never",
      last_result: status.last_sync_result,
      last_preview: status.last_preview_result || "Never",
      peer_count: config ? config.peers.filter((peer) => peer.enabled).length : 0,
      pending: status.pending_changes ? "Yes" : "No",
      agent_url: this.service.agentUrl || "Not configured",
      pairing_identifier: config?.role === "child" ? config.pairing_identifier : "Not applicable",
      proxy_count: this.service.proxyCatalog?.entities?.length || 0
    };
    for (const [id, value] of Object.entries(values)) this.#updateValue(id, value);
    this.#applySatellites(config);
  }

  async refreshSubscribed() {
    this.applyProxyCatalog(this.service.proxyCatalog);
    this.onStatus(this.service.status, this.service.config);
  }
}
