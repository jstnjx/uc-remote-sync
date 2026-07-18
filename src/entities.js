import * as uc from "./integration-api.js";
import { ACTIVITY_RELAY_LOCAL_ID } from "./constants.js";

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

export class EntityManager {
  constructor(api, service) {
    this.api = api;
    this.service = service;
    this.registered = false;
    this.proxyIds = new Set();
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
      this.#sensor("peer_count", "Child peer count", 0, "uc:users"),
      this.#sensor("pending", "Pending configuration changes", "No", "uc:arrow-path"),
      this.#sensor("agent_url", "Remote Sync agent URL", "Not configured", "uc:link"),
      this.#sensor("pairing_identifier", "Remote Sync pairing identifier", "Not configured", "uc:key"),
      this.#sensor("proxy_count", "Mirrored entity count", 0, "uc:squares-plus")
    ];
    for (const entity of sensors) this.api.addAvailableEntity(entity);
    this.api.addAvailableEntity(new uc.Button("sync_now", { en: "Synchronize now" }, { icon: "uc:arrow-path-rounded-square", cmdHandler: async () => (await this.service.syncNow(true)).success ? uc.StatusCodes.Ok : uc.StatusCodes.ServiceUnavailable }));
    this.api.addAvailableEntity(new uc.Button("reconcile", { en: "Reconcile connection" }, { icon: "uc:signal", cmdHandler: async () => (await this.service.reconcile()).success ? uc.StatusCodes.Ok : uc.StatusCodes.ServiceUnavailable }));
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
    return new uc.Sensor(id, { en: name }, { icon, deviceClass: uc.SensorDeviceClasses.Custom, attributes: { [uc.SensorAttributes.State]: uc.SensorStates.On, [uc.SensorAttributes.Value]: value } });
  }

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

  onStatus(status, config) {
    if (!this.registered) return;
    const values = {
      status: status.state,
      role: config?.role || "unconfigured",
      last_sync: status.last_sync_at || "Never",
      last_result: status.last_sync_result,
      peer_count: config ? config.peers.filter((peer) => peer.enabled).length : 0,
      pending: status.pending_changes ? "Yes" : "No",
      agent_url: this.service.agentUrl || "Not configured",
      pairing_identifier: config?.role === "child" ? config.pairing_identifier : "Not applicable",
      proxy_count: this.service.proxyCatalog?.entities?.length || 0
    };
    for (const [id, value] of Object.entries(values)) {
      const attributes = { [uc.SensorAttributes.State]: uc.SensorStates.On, [uc.SensorAttributes.Value]: value };
      this.api.getAvailableEntities().updateEntityAttributes(id, attributes);
      this.api.updateEntityAttributes(id, attributes);
    }
  }

  async refreshSubscribed() {
    this.applyProxyCatalog(this.service.proxyCatalog);
    this.onStatus(this.service.status, this.service.config);
  }
}
