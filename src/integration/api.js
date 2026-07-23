import dgram from "node:dgram";
import os from "node:os";
import { EventEmitter } from "node:events";
import { createWebSocketHttpServer } from "../transport/websocket.js";
import { logger } from "../shared/logger.js";

const log = logger("integration-api");

// -----------------------------------------------------------------------------
// Protocol constants
// -----------------------------------------------------------------------------

export const DeviceStates = Object.freeze({ Connected: "CONNECTED", Connecting: "CONNECTING", Disconnected: "DISCONNECTED", Error: "ERROR" });
export const StatusCodes = Object.freeze({ Ok: 200, BadRequest: 400, Unauthorized: 401, NotFound: 404, Timeout: 408, Conflict: 409, ServerError: 500, NotImplemented: 501, ServiceUnavailable: 503 });
export const Events = Object.freeze({ SubscribeEntities: "subscribe_entities", UnsubscribeEntities: "unsubscribe_entities", Connect: "connect", Disconnect: "disconnect", EnterStandby: "enter_standby", ExitStandby: "exit_standby", SetupDriverAbort: "setup_driver_abort" });
export const IntegrationSetupError = Object.freeze({ None: "NONE", NotFound: "NOT_FOUND", ConnectionRefused: "CONNECTION_REFUSED", AuthorizationError: "AUTHORIZATION_ERROR", Timeout: "TIMEOUT", Other: "OTHER" });
export const SensorStates = Object.freeze({ Unavailable: "UNAVAILABLE", Unknown: "UNKNOWN", On: "ON" });
export const SensorAttributes = Object.freeze({ State: "state", Value: "value", Unit: "unit" });
export const SensorDeviceClasses = Object.freeze({ Custom: "custom" });
export const ButtonStates = Object.freeze({ Unavailable: "UNAVAILABLE", Available: "AVAILABLE" });

// -----------------------------------------------------------------------------
// Setup messages
// -----------------------------------------------------------------------------

export class SetupDriver {}
export class DriverSetupRequest extends SetupDriver { constructor(reconfigure, setupData) { super(); this.reconfigure = Boolean(reconfigure); this.setupData = setupData || {}; } }
export class UserDataResponse extends SetupDriver { constructor(inputValues) { super(); this.inputValues = inputValues || {}; } }
export class UserConfirmationResponse extends SetupDriver { constructor(confirm) { super(); this.confirm = Boolean(confirm); } }
export class AbortDriverSetup extends SetupDriver { constructor(error) { super(); this.error = error; } }
export class SetupAction {}
export class RequestUserInput extends SetupAction { constructor(title, settings) { super(); this.title = title; this.settings = settings; } }
export class RequestUserConfirmation extends SetupAction { constructor(title, header, image, footer) { super(); this.title = title; this.header = header; this.image = image; this.footer = footer; } }
export class SetupError extends SetupAction { constructor(errorType = IntegrationSetupError.Other) { super(); this.errorType = errorType; } }
export class SetupComplete extends SetupAction {}

function language(value) { return typeof value === "string" ? { en: value } : value; }

// -----------------------------------------------------------------------------
// Entity models
// -----------------------------------------------------------------------------

export class Entity {
  constructor(id, name, entityType, options = {}) {
    this.id = id;
    this.name = language(name);
    this.entity_type = entityType;
    this.icon = options.icon;
    this.description = options.description ? language(options.description) : undefined;
    this.features = options.features || [];
    this.attributes = { ...(options.attributes || {}) };
    this.device_class = options.deviceClass;
    this.options = options.options;
    this.area = options.area;
    this.device_id = options.deviceId;
    this.cmdHandler = options.cmdHandler;
  }
  metadata() {
    return Object.fromEntries(Object.entries({ entity_id: this.id, entity_type: this.entity_type, icon: this.icon, description: this.description, device_id: this.device_id, features: this.features, name: this.name, area: this.area, device_class: this.device_class, options: this.options }).filter(([, value]) => value !== undefined));
  }
  state() { return { entity_id: this.id, entity_type: this.entity_type, device_id: this.device_id, attributes: this.attributes }; }
  async command(cmdId, params) { return this.cmdHandler ? this.cmdHandler(this, cmdId, params) : StatusCodes.NotImplemented; }
}

export class Sensor extends Entity {
  constructor(id, name, { icon, description, attributes, deviceClass, options, area } = {}) { super(id, name, "sensor", { icon, description, attributes, deviceClass, options, area }); }
}
export class Button extends Entity {
  constructor(id, name, { icon, description, state = ButtonStates.Available, area, cmdHandler } = {}) { super(id, name, "button", { icon, description, features: ["press"], attributes: { state }, area, cmdHandler }); }
}

class EntityStore {
  constructor(onUpdate = null) { this.entities = new Map(); this.onUpdate = onUpdate; }
  addAvailableEntity(entity) { if (this.entities.has(entity.id)) return false; this.entities.set(entity.id, entity); return true; }
  upsertEntity(entity) {
    const existing = this.entities.get(entity.id);
    if (existing) {
      Object.assign(existing, entity);
      return false;
    }
    this.entities.set(entity.id, entity);
    return true;
  }
  getEntity(id) { return this.entities.get(id) || null; }
  contains(id) { return this.entities.has(id); }
  removeEntity(id) { return this.entities.delete(id); }
  clear() { this.entities.clear(); }
  updateEntityAttributes(id, attributes) {
    const entity = this.entities.get(id);
    if (!entity) return false;
    const changed = Object.entries(attributes).some(([key, value]) => {
      const current = entity.attributes[key];
      if (Object.is(current, value)) return false;
      if (current && value && typeof current === "object" && typeof value === "object") {
        try { return JSON.stringify(current) !== JSON.stringify(value); } catch { return true; }
      }
      return true;
    });
    if (!changed) return false;
    Object.assign(entity.attributes, attributes);
    this.onUpdate?.(entity, attributes);
    return true;
  }
  getEntities() { return [...this.entities.values()].map((entity) => entity.metadata()); }
  getStates() { return [...this.entities.values()].map((entity) => entity.state()); }
}

// -----------------------------------------------------------------------------
// Integration advertisement
// -----------------------------------------------------------------------------

function encodeName(name) {
  const labels = name.replace(/\.$/, "").split(".");
  const parts = [];
  for (const label of labels) { const value = Buffer.from(label); parts.push(Buffer.from([value.length]), value); }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
function u16(value) { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function record(name, type, data, ttl = 120) { return Buffer.concat([encodeName(name), u16(type), u16(1), u32(ttl), u16(data.length), data]); }
function txtRecord(values) { return Buffer.concat(Object.entries(values).map(([key, value]) => { const data = Buffer.from(`${key}=${value}`); return Buffer.concat([Buffer.from([data.length]), data]); })); }
function ipv4Buffer(ip) { return Buffer.from(ip.split(".").map(Number)); }
function usableIpv4(value) {
  const parts = String(value || "").trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const octets = parts.map(Number);
  return octets[0] !== 0 && octets[0] !== 127 && octets[0] < 224 && !octets.every((part) => part === 255);
}
function localIpv4(interfaceValue) {
  const values = [];
  const configured = process.env.UC_MDNS_ADDRESS;
  if (configured) values.push(...configured.split(",").map((item) => item.trim()));
  if (interfaceValue) values.push(String(interfaceValue).trim());
  for (const entries of Object.values(os.networkInterfaces())) for (const item of entries || []) if (item.family === "IPv4" && !item.internal) values.push(item.address);
  return [...new Set(values.filter(usableIpv4))];
}

class MdnsPublisher {
  constructor(driverInfo, port, interfaceValue) {
    this.driverInfo = driverInfo;
    this.port = port;
    this.interfaceValue = interfaceValue;
    this.socket = null;
    this.serviceType = "_uc-integration._tcp.local.";
    this.instance = `${driverInfo.driver_id}.${this.serviceType}`;
    this.addresses = localIpv4(interfaceValue);
    const advertisedHost = String(process.env.UC_MDNS_HOSTNAME || driverInfo.driver_id.replaceAll("_", "-")).replace(/\.local\.?$/i, "").replace(/[^a-zA-Z0-9-]/g, "-");
    this.hostname = `${advertisedHost || "remote-sync"}.local.`;
  }
  packet() {
    const answers = [record(this.serviceType, 12, encodeName(this.instance))];
    const srvData = Buffer.concat([u16(0), u16(0), u16(this.port), encodeName(this.hostname)]);
    const additionals = [
      record(this.instance, 33, srvData),
      record(this.instance, 16, txtRecord({ name: language(this.driverInfo.name).en || "Remote Sync", ver: this.driverInfo.version, developer: this.driverInfo.developer?.name || "" })),
      ...this.addresses.map((ip) => record(this.hostname, 1, ipv4Buffer(ip)))
    ];
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0, 0); header.writeUInt16BE(0x8400, 2);
    header.writeUInt16BE(0, 4); header.writeUInt16BE(answers.length, 6); header.writeUInt16BE(0, 8); header.writeUInt16BE(additionals.length, 10);
    return Buffer.concat([header, ...answers, ...additionals]);
  }
  async start() {
    if (!this.addresses.length) log.warn("No non-loopback IPv4 address found for mDNS advertisement");
    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket.on("error", (error) => log.warn("mDNS error:", error.message));
    this.socket.on("message", (message) => this.#query(message));
    await new Promise((resolve, reject) => {
      const error = (err) => { this.socket.off("listening", listening); reject(err); };
      const listening = () => { this.socket.off("error", error); resolve(); };
      this.socket.once("error", error); this.socket.once("listening", listening); this.socket.bind(5353, "0.0.0.0");
    });
    try { this.socket.addMembership("224.0.0.251"); } catch (error) { log.warn("Unable to join mDNS multicast group:", error.message); }
    this.socket.setMulticastTTL(255);
    this.#announce(); setTimeout(() => this.#announce(), 1000).unref?.();
  }
  #query(message) {
    if (message.length < 12 || (message.readUInt16BE(2) & 0x8000)) return;
    const text = message.toString("latin1").toLowerCase();
    if (text.includes("_uc-integration") || text.includes(this.driverInfo.driver_id.toLowerCase())) this.#announce();
  }
  #announce() { if (this.socket) this.socket.send(this.packet(), 5353, "224.0.0.251", () => {}); }
  close() { try { this.socket?.close(); } catch {} this.socket = null; }
}

// -----------------------------------------------------------------------------
// Integration API server
// -----------------------------------------------------------------------------

export class IntegrationAPI extends EventEmitter {
  constructor() {
    super();
    this.driverInfo = null;
    this.state = DeviceStates.Disconnected;
    this.clients = new Set();
    this.setupHandler = null;
    this.availableEntities = new EntityStore((entity, attrs) => this.#broadcast("entity_change", { entity_id: entity.id, entity_type: entity.entity_type, attributes: attrs }, "ENTITY"));
    this.configuredEntities = new EntityStore((entity, attrs) => this.#broadcast("entity_change", { entity_id: entity.id, entity_type: entity.entity_type, attributes: attrs }, "ENTITY"));
    this.wsServer = null;
    this.mdns = null;
  }

  async init(driverConfig, setupHandler = null) {
    this.setupHandler = setupHandler;
    this.driverInfo = typeof driverConfig === "string" ? JSON.parse(await (await import("node:fs/promises")).readFile(driverConfig, "utf8")) : structuredClone(driverConfig);
    const port = Number(process.env.UC_INTEGRATION_HTTP_PORT || this.driverInfo.port || 9090);
    const host = process.env.UC_INTEGRATION_INTERFACE || "0.0.0.0";
    this.wsServer = createWebSocketHttpServer({ host, port, onConnection: (peer) => this.#connection(peer) });
    await this.wsServer.listen();
    if (String(process.env.UC_DISABLE_MDNS_PUBLISH || "false").toLowerCase() !== "true") {
      this.mdns = new MdnsPublisher(this.driverInfo, port, process.env.UC_INTEGRATION_INTERFACE);
      await this.mdns.start();
    }
    log.info(`Driver is up: ${this.driverInfo.driver_id}, version: ${this.driverInfo.version}, listening on: ${host}:${port}`);
  }

  async close() { this.mdns?.close(); this.mdns = null; for (const client of this.clients) client.close(); this.clients.clear(); await this.wsServer?.close(); this.wsServer = null; }
  refreshConnections() {
    for (const client of [...this.clients]) {
      try { client.close(); } catch {}
    }
  }
  getAvailableEntities() { return this.availableEntities; }
  getConfiguredEntities() { return this.configuredEntities; }
  addAvailableEntity(entity) { return this.availableEntities.addAvailableEntity(entity); }
  upsertAvailableEntity(entity) { return this.availableEntities.upsertEntity(entity); }
  removeAvailableEntity(id) { return this.availableEntities.removeEntity(id); }
  removeConfiguredEntity(id) { return this.configuredEntities.removeEntity(id); }
  clearAvailableEntities() { this.availableEntities.clear(); }
  clearConfiguredEntities() { this.configuredEntities.clear(); }
  updateEntityAttributes(id, attrs) { return this.configuredEntities.updateEntityAttributes(id, attrs); }
  async setDeviceState(state) { this.state = state; this.#broadcast("device_state", { state }, "DEVICE"); }

  #connection(peer) {
    this.clients.add(peer);
    peer.on("message", (raw) => this.#message(peer, raw.toString()).catch((error) => log.error("Integration message failed:", error)));
    peer.on("close", () => this.clients.delete(peer));
    peer.on("error", (error) => { log.warn("Integration WebSocket error:", error.message); this.clients.delete(peer); });
    this.#response(peer, 0, "authentication", {}, StatusCodes.Ok);
  }
  #send(peer, value) { try { peer.send(JSON.stringify(value)); } catch (error) { log.warn("Integration response failed:", error.message); } }
  #response(peer, reqId, msg, msgData = {}, code = 200) { this.#send(peer, { kind: "resp", req_id: reqId, msg, code, msg_data: msgData }); }
  #event(peer, msg, msgData, cat = "DEVICE") { this.#send(peer, { kind: "event", msg, msg_data: msgData, cat }); }
  #broadcast(msg, msgData, cat) { for (const peer of this.clients) this.#event(peer, msg, msgData, cat); }
  #version() { return { name: language(this.driverInfo.name).en || "Remote Sync", version: { api: this.driverInfo.min_core_api, driver: this.driverInfo.version } }; }

  async #message(peer, text) {
    let value; try { value = JSON.parse(text); } catch { return; }
    if (value.kind === "event") {
      const mapping = { connect: Events.Connect, disconnect: Events.Disconnect, enter_standby: Events.EnterStandby, exit_standby: Events.ExitStandby, abort_driver_setup: Events.SetupDriverAbort };
      const event = mapping[value.msg]; if (event) this.emit(event, value.msg_data);
      if (value.msg === "abort_driver_setup" && this.setupHandler) await this.setupHandler(new AbortDriverSetup(value.msg_data?.error));
      return;
    }
    if (value.kind !== "req") return;
    const id = value.id;
    const data = value.msg_data || {};
    switch (value.msg) {
      case "get_driver_version": this.#response(peer, id, "driver_version", this.#version()); break;
      case "get_driver_metadata": this.#response(peer, id, "driver_metadata", this.driverInfo); break;
      case "get_device_state": this.#response(peer, id, "device_state", { state: this.state }); break;
      case "get_available_entities": {
        const entities = this.availableEntities.getEntities();
        const proxyCount = entities.filter((entity) => String(entity.entity_id || "").startsWith("proxy_")).length;
        log.info(`Serving ${entities.length} available entity/entities (${proxyCount} proxy entities)`);
        this.#response(peer, id, "available_entities", { available_entities: entities });
        break;
      }
      case "get_entity_states": this.#response(peer, id, "entity_states", this.configuredEntities.getStates()); break;
      case "subscribe_events": {
        for (const entityId of data.entity_ids || []) { const entity = this.availableEntities.getEntity(entityId); if (entity) this.configuredEntities.addAvailableEntity(entity); }
        this.emit(Events.SubscribeEntities, data.entity_ids || []); this.#response(peer, id, "result"); break;
      }
      case "unsubscribe_events": {
        for (const entityId of data.entity_ids || []) this.configuredEntities.removeEntity(entityId);
        this.emit(Events.UnsubscribeEntities, data.entity_ids || []); this.#response(peer, id, "result"); break;
      }
      case "entity_command": {
        const entity = this.configuredEntities.getEntity(data.entity_id);
        if (!entity) this.#response(peer, id, "result", {}, StatusCodes.NotFound);
        else this.#response(peer, id, "result", {}, await entity.command(data.cmd_id, data.params));
        break;
      }
      case "setup_driver": {
        log.info(`Setup request received (reconfigure=${Boolean(data.reconfigure)})`);
        await this.#setup(peer, id, new DriverSetupRequest(Boolean(data.reconfigure), data.setup_data || {}));
        break;
      }
      case "set_driver_user_data": {
        const hasInput = Boolean(data.input_values);
        const msg = hasInput ? new UserDataResponse(data.input_values) : new UserConfirmationResponse(Boolean(data.confirm));
        log.info(`Setup user response received (${hasInput ? `fields=${Object.keys(data.input_values).join(",")}` : `confirm=${Boolean(data.confirm)}`})`);
        this.#response(peer, id, "result");
        await new Promise((resolve) => setTimeout(resolve, 500));
        this.#setupEvent(peer, "SETUP", "SETUP");
        await this.#setup(peer, id, msg, false, false);
        break;
      }
      default: this.#response(peer, id, "result", { message: `Unsupported request ${value.msg}` }, StatusCodes.NotImplemented);
    }
  }

  async #setup(peer, id, message, acknowledge = true, emitProgressForAction = true) {
    if (acknowledge) this.#response(peer, id, "result");
    if (!this.setupHandler) { this.#setupEvent(peer, "STOP", "ERROR", { error: IntegrationSetupError.Other }); return; }
    try {
      const action = await this.setupHandler(message);
      log.info(`Setup action: ${action?.constructor?.name || "unknown"}`);
      if (action instanceof RequestUserInput) {
        if (emitProgressForAction) this.#setupEvent(peer, "SETUP", "SETUP");
        this.#setupEvent(peer, "SETUP", "WAIT_USER_ACTION", { require_user_action: { input: { title: language(action.title), settings: action.settings } } });
      } else if (action instanceof RequestUserConfirmation) {
        if (emitProgressForAction) this.#setupEvent(peer, "SETUP", "SETUP");
        this.#setupEvent(peer, "SETUP", "WAIT_USER_ACTION", { require_user_action: { confirmation: { title: language(action.title), message1: action.header ? language(action.header) : undefined, image: action.image, message2: action.footer ? language(action.footer) : undefined } } });
      } else if (action instanceof SetupComplete) this.#setupEvent(peer, "STOP", "OK");
      else if (action instanceof SetupError) this.#setupEvent(peer, "STOP", "ERROR", { error: action.errorType });
      else this.#setupEvent(peer, "STOP", "ERROR", { error: IntegrationSetupError.Other });
    } catch (error) { log.error("Setup handler failed:", error); this.#setupEvent(peer, "STOP", "ERROR", { error: IntegrationSetupError.Other }); }
  }
  #setupEvent(peer, eventType, state, extra = {}) { this.#event(peer, "driver_setup_change", { event_type: eventType, state, ...extra }, "DEVICE"); }
}
