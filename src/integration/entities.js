import crypto from "node:crypto";
import * as uc from "./api.js";
import { ACTIVITY_RELAY_LOCAL_ID } from "../shared/constants.js";

// -----------------------------------------------------------------------------
// Proxy entity factory
// -----------------------------------------------------------------------------

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
        const result = await service.forwardProxyCommand(descriptor.source_entity_id, cmdId, params);
        return result.success ? uc.StatusCodes.Ok : (result.status || uc.StatusCodes.ServiceUnavailable);
      }
    }
  );
}

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
        if (!sourceActivityId || !["on", "off"].includes(action)) return uc.StatusCodes.BadRequest;
        const result = await this.service.forwardActivityCommand(sourceActivityId, action);
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

  #button(id, name, icon, handler) {
    return new uc.Button(id, { en: name }, { icon, cmdHandler: handler });
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
      if (configured) {
        this.api.getConfiguredEntities().upsertEntity(entity);
        this.api.updateEntityAttributes(entity.id, descriptor.attributes || { state: "UNKNOWN" });
      }
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

  #applySatellites(config) {
    const next = new Set();
    if (config?.role !== "master") {
      this.#removeSatelliteEntities(next);
      return;
    }
    for (const satellite of this.service.listSatellites(false)) {
      const key = satelliteKey(satellite.peer_id);
      const prefix = `satellite_${key}`;
      const values = {
        [`${prefix}_status`]: satellite.online ? (satellite.enabled ? "Online" : "Online, disabled") : (satellite.enabled ? "Offline" : "Disabled"),
        [`${prefix}_version`]: satellite.version || satellite.protocol?.version || "Unknown",
        [`${prefix}_last_sync`]: satellite.last_sync_at || "Never",
        [`${prefix}_last_error`]: satellite.last_error || "None",
        [`${prefix}_network`]: `${satellite.mac || "MAC unavailable"} — ${(satellite.broadcasts || []).join(", ") || "broadcast unavailable"}`,
        [`${prefix}_objects`]: `${satellite.mirrored_entities || 0} mirrored entities — ${satellite.dock_tunnels || 0} Dock tunnels`
      };
      for (const [id, value] of Object.entries(values)) {
        const title = id.endsWith("_status") ? `${satellite.name} status`
          : id.endsWith("_version") ? `${satellite.name} version`
            : id.endsWith("_last_sync") ? `${satellite.name} last synchronization`
              : id.endsWith("_last_error") ? `${satellite.name} last error`
                : id.endsWith("_network") ? `${satellite.name} network`
                  : `${satellite.name} synchronized objects`;
        const entity = this.#sensor(id, title, value, "uc:server");
        next.add(entity.id);
        this.api.upsertAvailableEntity(entity);
        this.#updateValue(entity.id, value);
      }
      const actions = [
        ["sync", "Synchronize", "uc:arrow-path", "sync"],
        ["preview", "Preview", "uc:document-magnifying-glass", "preview"],
        ["toggle", satellite.enabled ? "Disable" : "Enable", "uc:power", satellite.enabled ? "disable" : "enable"],
        ["rediscover", "Rediscover", "uc:signal", "rediscover"],
        ["rotate", "Rotate credentials", "uc:key", "rotate"],
        ["unpair", "Unpair", "uc:link-slash", "unpair"],
        ["remove", "Remove", "uc:trash", "remove"]
      ];
      for (const [suffix, actionName, icon, action] of actions) {
        const entity = this.#button(`${prefix}_${suffix}`, `${actionName} ${satellite.name}`, icon, async () => {
          try {
            const result = await this.service.manageSatellite(satellite.peer_id, action);
            return result?.success === false ? uc.StatusCodes.ServiceUnavailable : uc.StatusCodes.Ok;
          } catch {
            return uc.StatusCodes.ServiceUnavailable;
          }
        });
        next.add(entity.id);
        this.api.upsertAvailableEntity(entity);
      }
    }
    this.#removeSatelliteEntities(next);
    this.satelliteIds = next;
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
      role: config?.role === "master" ? "primary" : config?.role === "child" ? "satellite" : "unconfigured",
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
