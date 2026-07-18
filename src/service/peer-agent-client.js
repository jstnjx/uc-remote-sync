import { AGENT_API_VERSION, MAX_SNAPSHOT_BYTES, PROTOCOL_VERSION, SNAPSHOT_SCHEMA_VERSION } from "../shared/constants.js";
import { assertProtocolCompatibility, normalizeProtocolDescriptor } from "../protocol/index.js";
import { hmacSignature } from "../shared/util.js";

// -----------------------------------------------------------------------------
// Agent transport
// -----------------------------------------------------------------------------

export class PeerAgentClient {
  constructor(baseUrl, token, { timeoutMs = 10_000 } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
    this.token = String(token || "");
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = "GET", body = null, headers = {}, timeoutMs = this.timeoutMs, expected = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...headers
        },
        body,
        signal: controller.signal
      });
      const text = await response.text();
      let value = {};
      try { value = text ? JSON.parse(text) : {}; }
      catch { value = { error: text.slice(0, 4096) }; }
      if (expected ? !expected.includes(response.status) : !response.ok) {
        const detail = value.error || value.message || (Array.isArray(value.errors) ? value.errors.join("; ") : null);
        const error = new Error(detail || `Remote Sync agent returned HTTP ${response.status}`);
        error.status = response.status;
        error.response = value;
        throw error;
      }
      return { status: response.status, value };
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(new Error(`Timed out contacting ${this.baseUrl}`), { code: "ETIMEDOUT" });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async json(path, options = {}) {
    const payload = options.json === undefined ? null : JSON.stringify(options.json);
    const result = await this.request(path, {
      ...options,
      body: payload,
      headers: payload === null ? options.headers : { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    return result.value;
  }

  async capabilities({ requiredCapabilities = [] } = {}) {
    try {
      const value = await this.json(`/v${AGENT_API_VERSION}/capabilities`);
      return assertProtocolCompatibility(value, { requiredCapabilities });
    } catch (error) {
      if (![400, 404, 405, 422, 501].includes(error.status)) throw error;
      const legacy = normalizeProtocolDescriptor({ service: "remote-sync", api_version: 1, protocol_version: 1, snapshot_schema: 5, version: "legacy", capabilities: [] });
      return assertProtocolCompatibility(legacy, { requiredCapabilities });
    }
  }

  status() {
    return this.json(`/v${AGENT_API_VERSION}/status`);
  }

  validatePairing(payload = {}) {
    return this.json(`/v${AGENT_API_VERSION}/pairing/validate`, { method: "POST", json: payload });
  }

  claim(payload) {
    return this.json(`/v${AGENT_API_VERSION}/pairing/claim`, { method: "POST", json: payload });
  }

  rotate(payload) {
    return this.json(`/v${AGENT_API_VERSION}/pairing/rotate`, { method: "POST", json: payload });
  }

  unpair(payload) {
    return this.json(`/v${AGENT_API_VERSION}/pairing/unpair`, { method: "POST", json: payload });
  }

  async snapshot(payload, { preview = false, headers = {} } = {}) {
    if (!Buffer.isBuffer(payload) || payload.length > MAX_SNAPSHOT_BYTES) throw new Error("Invalid snapshot payload");
    const path = preview ? `/v${AGENT_API_VERSION}/snapshots/preview` : `/v${AGENT_API_VERSION}/snapshots`;
    const result = await this.request(path, {
      method: "POST",
      body: payload,
      timeoutMs: 180_000,
      expected: preview ? [200] : [200, 201, 202, 422],
      headers: {
        "Content-Type": "application/gzip",
        "X-Remote-Sync-Signature": hmacSignature(this.token, payload),
        "X-Remote-Sync-Protocol": String(PROTOCOL_VERSION),
        "X-Remote-Sync-Snapshot-Schema": String(SNAPSHOT_SCHEMA_VERSION),
        ...headers
      }
    });
    return { status: result.status, ...result.value };
  }
}
