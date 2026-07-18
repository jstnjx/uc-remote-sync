import crypto from "node:crypto";
import dgram from "node:dgram";
import os from "node:os";
import { DEFAULT_AGENT_PORT } from "../shared/constants.js";
import { isUsableIpv4Address, normalizeMacAddress } from "../network/identity.js";
import { logger } from "../shared/logger.js";

const log = logger("pairing-mdns");
// -----------------------------------------------------------------------------
// DNS constants
// -----------------------------------------------------------------------------

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE_TYPE = "_uc-remote-sync._tcp.local.";
const REMOTE_SERVICE_TYPE = "_uc-remote._tcp.local.";
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const CLASS_IN = 1;
const IDENTIFIER_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// -----------------------------------------------------------------------------
// Pairing identity
// -----------------------------------------------------------------------------

export function generatePairingIdentifier(length = 8) {
  let value = "";
  while (value.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte >= 248) continue;
      value += IDENTIFIER_ALPHABET[byte % IDENTIFIER_ALPHABET.length];
      if (value.length === length) break;
    }
  }
  return displayPairingIdentifier(value);
}

export function normalizePairingIdentifier(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^RMS/, "").slice(0, 12);
}

export function displayPairingIdentifier(value) {
  const normalized = normalizePairingIdentifier(value);
  if (!normalized) return "";
  return `RMS-${normalized.match(/.{1,4}/g).join("-")}`;
}

export function pairingHostname(identifier) {
  const normalized = normalizePairingIdentifier(identifier).toLowerCase();
  return `remote-sync-${normalized || "child"}.local.`;
}

export function defaultPairingUrl(identifier, port = DEFAULT_AGENT_PORT) {
  return `http://${pairingHostname(identifier).replace(/\.$/, "")}:${port}`;
}

// -----------------------------------------------------------------------------
// DNS encoding and parsing
// -----------------------------------------------------------------------------

function encodeName(name) {
  const labels = String(name).replace(/\.$/, "").split(".");
  const parts = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length > 63) throw new Error(`DNS label too long: ${label}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function parseName(buffer, startOffset, seen = new Set()) {
  let offset = startOffset;
  let nextOffset = startOffset;
  let jumped = false;
  const labels = [];
  while (offset < buffer.length) {
    if (seen.has(offset)) throw new Error("DNS compression pointer loop");
    seen.add(offset);
    const length = buffer[offset];
    if (length === 0) {
      if (!jumped) nextOffset = offset + 1;
      return { name: `${labels.join(".")}.`, nextOffset };
    }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) throw new Error("Truncated DNS compression pointer");
      const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
      if (!jumped) nextOffset = offset + 2;
      jumped = true;
      const nested = parseName(buffer, pointer, seen);
      labels.push(nested.name.replace(/\.$/, ""));
      return { name: `${labels.join(".")}.`, nextOffset };
    }
    offset += 1;
    if (offset + length > buffer.length) throw new Error("Truncated DNS name");
    labels.push(buffer.subarray(offset, offset + length).toString("utf8"));
    offset += length;
    if (!jumped) nextOffset = offset;
  }
  throw new Error("Unterminated DNS name");
}

function u16(value) { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value); return buffer; }
function u32(value) { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; }
function ipv4Buffer(value) { return Buffer.from(String(value).split(".").map((part) => Number(part))); }

function resourceRecord(name, type, payload, ttl = 120, cacheFlush = false) {
  const klass = cacheFlush ? CLASS_IN | 0x8000 : CLASS_IN;
  return Buffer.concat([encodeName(name), u16(type), u16(klass), u32(ttl), u16(payload.length), payload]);
}

function txtPayload(values) {
  const parts = [];
  for (const [key, value] of Object.entries(values)) {
    const bytes = Buffer.from(`${key}=${String(value)}`, "utf8");
    if (bytes.length <= 255) parts.push(Buffer.from([bytes.length]), bytes);
  }
  return Buffer.concat(parts);
}

function localIpv4Addresses(interfaceValue) {
  const values = [];
  const configured = process.env.UC_MDNS_ADDRESS;
  if (configured) values.push(...configured.split(",").map((item) => item.trim()));
  if (interfaceValue) values.push(String(interfaceValue).trim());
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) if (item.family === "IPv4" && !item.internal) values.push(item.address);
  }
  return [...new Set(values.filter(isUsableIpv4Address))];
}

function queryPacket(name, type = TYPE_PTR) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, encodeName(name), u16(type), u16(CLASS_IN)]);
}

export function parseDnsPacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return { questions: [], records: [] };
  const qd = buffer.readUInt16BE(4);
  const totalRecords = buffer.readUInt16BE(6) + buffer.readUInt16BE(8) + buffer.readUInt16BE(10);
  let offset = 12;
  const questions = [];
  for (let index = 0; index < qd; index += 1) {
    const parsed = parseName(buffer, offset);
    offset = parsed.nextOffset;
    if (offset + 4 > buffer.length) throw new Error("Truncated DNS question");
    questions.push({ name: parsed.name, type: buffer.readUInt16BE(offset), class: buffer.readUInt16BE(offset + 2) & 0x7fff });
    offset += 4;
  }
  const records = [];
  for (let index = 0; index < totalRecords; index += 1) {
    const parsed = parseName(buffer, offset);
    offset = parsed.nextOffset;
    if (offset + 10 > buffer.length) throw new Error("Truncated DNS record");
    const type = buffer.readUInt16BE(offset);
    const klass = buffer.readUInt16BE(offset + 2) & 0x7fff;
    const ttl = buffer.readUInt32BE(offset + 4);
    const length = buffer.readUInt16BE(offset + 8);
    const dataOffset = offset + 10;
    const endOffset = dataOffset + length;
    if (endOffset > buffer.length) throw new Error("Truncated DNS record data");
    const record = { name: parsed.name, type, class: klass, ttl, data: buffer.subarray(dataOffset, endOffset) };
    if (type === TYPE_A && length === 4) record.address = [...record.data].join(".");
    if (type === TYPE_PTR) record.ptr = parseName(buffer, dataOffset).name;
    if (type === TYPE_SRV && length >= 6) {
      record.priority = buffer.readUInt16BE(dataOffset);
      record.weight = buffer.readUInt16BE(dataOffset + 2);
      record.port = buffer.readUInt16BE(dataOffset + 4);
      record.target = parseName(buffer, dataOffset + 6).name;
    }
    if (type === TYPE_TXT) {
      record.txt = {};
      let cursor = dataOffset;
      while (cursor < endOffset) {
        const itemLength = buffer[cursor++];
        if (cursor + itemLength > endOffset) break;
        const item = buffer.subarray(cursor, cursor + itemLength).toString("utf8");
        cursor += itemLength;
        const equals = item.indexOf("=");
        if (equals >= 0) record.txt[item.slice(0, equals)] = item.slice(equals + 1);
        else record.txt[item] = "";
      }
    }
    records.push(record);
    offset = endOffset;
  }
  return { questions, records };
}

function addRecords(recordsByName, records) {
  for (const record of records) {
    const key = record.name.toLowerCase();
    if (!recordsByName.has(key)) recordsByName.set(key, []);
    const values = recordsByName.get(key);
    const signature = `${record.type}|${record.ptr || record.target || record.address || JSON.stringify(record.txt || {})}|${record.port || ""}`;
    if (!values.some((item) => item.signature === signature)) values.push({ ...record, signature });
  }
}

function rememberObservedSources(observedByName, records, sourceAddress) {
  if (!isUsableIpv4Address(sourceAddress)) return;
  for (const record of records) {
    const names = [record.name];
    if (record.ptr) names.push(record.ptr);
    if (record.target) names.push(record.target);
    for (const name of names) {
      if (!name) continue;
      const key = name.toLowerCase();
      if (!observedByName.has(key)) observedByName.set(key, sourceAddress);
    }
  }
}

function addressForService(instanceKey, srv, recordsByName, observedByName) {
  const targetKey = srv?.target?.toLowerCase();
  const addressRecords = targetKey ? recordsByName.get(targetKey) || [] : [];
  return observedByName.get(instanceKey)
    || (targetKey ? observedByName.get(targetKey) : null)
    || addressRecords.find((record) => record.type === TYPE_A && isUsableIpv4Address(record.address))?.address
    || null;
}

function extractServices(recordsByName, observedByName = new Map()) {
  const result = [];
  for (const [key, records] of recordsByName) {
    if (!key.endsWith(SERVICE_TYPE) || key === SERVICE_TYPE) continue;
    const txt = records.find((record) => record.type === TYPE_TXT)?.txt || {};
    const srv = records.find((record) => record.type === TYPE_SRV);
    const identifier = displayPairingIdentifier(txt.id || key.slice(0, -SERVICE_TYPE.length).replace(/\.$/, ""));
    if (!identifier || !srv?.target || !srv.port) continue;
    const address = addressForService(key, srv, recordsByName, observedByName);
    const hostname = srv.target.replace(/\.$/, "");
    result.push({
      identifier,
      name: txt.name || identifier,
      address,
      hostname,
      port: srv.port,
      url: address ? `http://${address}:${srv.port}` : `http://${hostname}:${srv.port}`,
      version: txt.ver || null,
      node_id: txt.node || null,
      ready: txt.ready === "1",
      state: txt.state || (txt.ready === "1" ? "ready" : "paired"),
      mac: normalizeMacAddress(txt.mac),
      broadcasts: String(txt.bcast || "").split(",").map((item) => item.trim()).filter(isUsableIpv4Address),
      protocol: {
        api_version: Number(txt.api || 1),
        protocol_version: Number(txt.proto || 1),
        snapshot_schema: Number(txt.snap || 4),
        capabilities: String(txt.caps || "").split(",").filter(Boolean),
        version: txt.ver || null
      },
      discovery: "remote-sync-mdns"
    });
  }
  return result;
}

function extractRemoteDevices(recordsByName, observedByName = new Map()) {
  const result = [];
  for (const [key, records] of recordsByName) {
    if (!key.endsWith(REMOTE_SERVICE_TYPE) || key === REMOTE_SERVICE_TYPE) continue;
    const srv = records.find((record) => record.type === TYPE_SRV);
    if (!srv?.target || !srv.port) continue;
    const txt = records.find((record) => record.type === TYPE_TXT)?.txt || {};
    const address = addressForService(key, srv, recordsByName, observedByName);
    const hostname = srv.target.replace(/\.$/, "");
    if (!address && !hostname) continue;
    result.push({
      instance: key.slice(0, -REMOTE_SERVICE_TYPE.length).replace(/\.$/, ""),
      name: txt.name || key.slice(0, -REMOTE_SERVICE_TYPE.length).replace(/\.$/, ""),
      address,
      hostname,
      core_port: srv.port,
      model: txt.model || null,
      api_version: txt.ver_api || null,
      version: txt.ver || null
    });
  }
  const unique = new Map();
  for (const item of result) unique.set(item.address || item.hostname, item);
  return [...unique.values()];
}

// -----------------------------------------------------------------------------
// Discovery records
// -----------------------------------------------------------------------------

export function discoverServicesFromPacket(buffer, sourceAddress = null) {
  const recordsByName = new Map();
  const observedByName = new Map();
  const packet = parseDnsPacket(buffer);
  addRecords(recordsByName, packet.records);
  rememberObservedSources(observedByName, packet.records, sourceAddress);
  return extractServices(recordsByName, observedByName);
}

export function discoverRemoteDevicesFromPacket(buffer, sourceAddress = null) {
  const recordsByName = new Map();
  const observedByName = new Map();
  const packet = parseDnsPacket(buffer);
  addRecords(recordsByName, packet.records);
  rememberObservedSources(observedByName, packet.records, sourceAddress);
  return extractRemoteDevices(recordsByName, observedByName);
}


export function remoteSyncServiceFromHealth(remote, value, agentPort = DEFAULT_AGENT_PORT) {
  if (value?.service !== "remote-sync" || value?.role !== "child") return null;
  const identifier = displayPairingIdentifier(value.identifier);
  if (!identifier) return null;
  const host = remote?.address || remote?.hostname;
  if (!host) return null;
  return {
    identifier,
    name: value.node_name || remote.name || identifier,
    address: remote.address || null,
    hostname: remote.hostname || null,
    port: agentPort,
    url: `http://${host}:${agentPort}`,
    version: value.version || null,
    node_id: value.node_id || null,
    ready: value.ready_to_pair === true,
    state: value.ready_to_pair === true ? "ready" : "paired",
    mac: normalizeMacAddress(value.mac),
    broadcasts: Array.isArray(value.broadcasts) ? value.broadcasts.filter(isUsableIpv4Address) : [],
    protocol: {
      api_version: Number(value.api_version || 1),
      protocol_version: Number(value.protocol_version || 1),
      snapshot_schema: Number(value.snapshot_schema || 4),
      capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(String) : [],
      version: value.version || null
    },
    discovery: "remote-mdns-capabilities"
  };
}

// -----------------------------------------------------------------------------
// Satellite advertisement
// -----------------------------------------------------------------------------

export class RemoteSyncMdnsPublisher {
  constructor({ identifier, port = DEFAULT_AGENT_PORT, name = "Remote Sync satellite", version = "unknown", nodeId = null, ready = true, interfaceValue = null, mac = null, broadcasts = [], protocol = null }) {
    this.identifier = displayPairingIdentifier(identifier);
    this.normalizedIdentifier = normalizePairingIdentifier(identifier);
    this.port = port;
    this.name = name;
    this.version = version;
    this.nodeId = nodeId;
    this.ready = Boolean(ready);
    this.interfaceValue = interfaceValue;
    this.mac = normalizeMacAddress(mac);
    this.broadcasts = Array.isArray(broadcasts) ? broadcasts.filter(isUsableIpv4Address) : [];
    this.protocol = protocol && typeof protocol === "object" ? protocol : {};
    this.hostname = pairingHostname(identifier);
    this.instance = `${this.identifier}.${SERVICE_TYPE}`;
    this.addresses = localIpv4Addresses(interfaceValue);
    this.socket = null;
  }

  packet() {
    const answers = [resourceRecord(SERVICE_TYPE, TYPE_PTR, encodeName(this.instance))];
    const additionals = [
      resourceRecord(this.instance, TYPE_SRV, Buffer.concat([u16(0), u16(0), u16(this.port), encodeName(this.hostname)]), 120, true),
      resourceRecord(this.instance, TYPE_TXT, txtPayload({ id: this.identifier, role: "child", name: this.name, ver: this.version, node: this.nodeId || "", ready: this.ready ? "1" : "0", state: this.ready ? "ready" : "paired", mac: this.mac || "", bcast: this.broadcasts.join(","), api: this.protocol.api_version || 1, proto: this.protocol.protocol_version || 1, snap: this.protocol.snapshot_schema || 4, caps: Array.isArray(this.protocol.capabilities) ? this.protocol.capabilities.join(",") : "" }), 120, true),
      ...this.addresses.map((address) => resourceRecord(this.hostname, TYPE_A, ipv4Buffer(address), 120, true))
    ];
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x8400, 2);
    header.writeUInt16BE(answers.length, 6);
    header.writeUInt16BE(additionals.length, 10);
    return Buffer.concat([header, ...answers, ...additionals]);
  }

  async start() {
    if (this.socket || !this.normalizedIdentifier) return;
    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket.on("error", (error) => log.warn("Pairing mDNS publisher error:", error.message));
    this.socket.on("message", (message) => {
      try {
        const packet = parseDnsPacket(message);
        const relevant = packet.questions.some((question) => {
          const name = question.name.toLowerCase();
          return name === SERVICE_TYPE || name === this.instance.toLowerCase() || name === this.hostname.toLowerCase();
        });
        if (relevant) this.announce();
      } catch { /* ignore malformed multicast traffic */ }
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.socket.off("listening", onListening); reject(error); };
      const onListening = () => { this.socket.off("error", onError); resolve(); };
      this.socket.once("error", onError);
      this.socket.once("listening", onListening);
      this.socket.bind(MDNS_PORT, "0.0.0.0");
    });
    try { this.socket.addMembership(MDNS_ADDRESS); } catch (error) { log.warn("Unable to join pairing mDNS group:", error.message); }
    this.socket.setMulticastTTL(255);
    this.announce();
    setTimeout(() => this.announce(), 750).unref?.();
    const advertised = this.addresses.length ? this.addresses.join(", ") : this.hostname.replace(/\.$/, "");
    log.info(`Advertising satellite ${this.identifier} (${this.ready ? "ready" : "paired"}) on ${advertised}:${this.port}`);
  }

  setReady(ready) {
    this.ready = Boolean(ready);
    this.announce();
    setTimeout(() => this.announce(), 250).unref?.();
  }

  announce() {
    if (this.socket) this.socket.send(this.packet(), MDNS_PORT, MDNS_ADDRESS, () => {});
  }

  close() {
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
  }
}

// -----------------------------------------------------------------------------
// Discovery service
// -----------------------------------------------------------------------------

export class RemoteSyncDiscovery {
  constructor({ timeoutMs = 2500, cacheTtlMs = 5 * 60 * 1000, fetchImpl = globalThis.fetch, agentPort = DEFAULT_AGENT_PORT, probeTimeoutMs = 1500 } = {}) {
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.fetchImpl = fetchImpl;
    this.agentPort = agentPort;
    this.probeTimeoutMs = probeTimeoutMs;
    this.cache = new Map();
  }

  clear(identifier = null) {
    if (identifier) this.cache.delete(normalizePairingIdentifier(identifier));
    else this.cache.clear();
  }

  async discoverReady({ timeoutMs = this.timeoutMs } = {}) {
    const values = await this.#discoverAll(timeoutMs);
    return values.filter((item) => item.ready).sort((a, b) => String(a.name || a.identifier).localeCompare(String(b.name || b.identifier)));
  }

  async resolve(identifier, { timeoutMs = this.timeoutMs, force = false } = {}) {
    const normalized = normalizePairingIdentifier(identifier);
    if (!normalized) throw new Error("Invalid satellite identifier");
    const cached = this.cache.get(normalized);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
    const values = await this.#discoverAll(timeoutMs);
    const value = values.find((item) => normalizePairingIdentifier(item.identifier) === normalized);
    if (!value) {
      const error = new Error(`Satellite ${displayPairingIdentifier(identifier)} was not discovered over mDNS`);
      error.code = "ENOTFOUND";
      throw error;
    }
    this.cache.set(normalized, { value, expiresAt: Date.now() + this.cacheTtlMs });
    return value;
  }

  async #discoverAll(timeoutMs) {
    const { recordsByName, observedByName } = await this.#browse([SERVICE_TYPE, REMOTE_SERVICE_TYPE], timeoutMs);
    const direct = extractServices(recordsByName, observedByName);
    const remoteDevices = extractRemoteDevices(recordsByName, observedByName);
    const probed = await this.#probeRemoteAgents(remoteDevices);
    const merged = new Map();
    for (const item of direct) merged.set(normalizePairingIdentifier(item.identifier), item);
    for (const item of probed) merged.set(normalizePairingIdentifier(item.identifier), item);
    const values = [...merged.values()].filter((item) => normalizePairingIdentifier(item.identifier));
    log.info(`Discovered ${values.length} Remote Sync satellite service(s): ${values.map((item) => `${item.identifier}@${item.address || item.hostname}`).join(", ") || "none"}`);
    return values;
  }

  async #probeRemoteAgents(remoteDevices) {
    if (typeof this.fetchImpl !== "function") return [];
    const attempts = remoteDevices.map(async (remote) => {
      const host = remote.address || remote.hostname;
      if (!host) return null;
      const baseUrl = `http://${host}:${this.agentPort}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs);
      try {
        const response = await this.fetchImpl(`${baseUrl}/v1/capabilities`, { signal: controller.signal });
        if (!response.ok) return null;
        const value = await response.json();
        return remoteSyncServiceFromHealth(remote, value, this.agentPort);
      } catch (error) {
        if (error?.name !== "AbortError") log.debug(`Remote Sync capability probe failed for ${baseUrl}:`, error.message);
        return null;
      } finally {
        clearTimeout(timer);
      }
    });
    return (await Promise.all(attempts)).filter(Boolean);
  }

  async #browse(serviceTypes, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      const recordsByName = new Map();
      const observedByName = new Map();
      const queried = new Set();
      let done = false;
      const sendQuery = (name, type) => {
        const key = `${String(name).toLowerCase()}|${type}`;
        if (done || queried.has(key)) return;
        queried.add(key);
        socket.send(queryPacket(name, type), MDNS_PORT, MDNS_ADDRESS, () => {});
      };
      const finish = (error = null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* ignored */ }
        if (error) reject(error);
        else resolve({ recordsByName, observedByName });
      };
      const timer = setTimeout(() => finish(), timeoutMs);
      socket.on("message", (message, rinfo) => {
        try {
          const packet = parseDnsPacket(message);
          addRecords(recordsByName, packet.records);
          rememberObservedSources(observedByName, packet.records, rinfo?.address);
          for (const record of packet.records) {
            if (record.type === TYPE_PTR && serviceTypes.includes(record.name.toLowerCase()) && record.ptr) {
              sendQuery(record.ptr, TYPE_SRV);
              sendQuery(record.ptr, TYPE_TXT);
            }
            if (record.type === TYPE_SRV && record.target) sendQuery(record.target, TYPE_A);
          }
        } catch { /* ignore malformed traffic */ }
      });
      socket.on("error", finish);
      socket.bind(MDNS_PORT, "0.0.0.0", () => {
        try { socket.addMembership(MDNS_ADDRESS); } catch { /* receiving unicast may still work */ }
        for (const serviceType of serviceTypes) {
          const packet = queryPacket(serviceType, TYPE_PTR);
          for (const delay of [0, 250, 750]) setTimeout(() => { if (!done) socket.send(packet, MDNS_PORT, MDNS_ADDRESS, () => {}); }, delay).unref?.();
        }
      });
    });
  }
}

export { isUsableIpv4Address } from "../network/identity.js";
