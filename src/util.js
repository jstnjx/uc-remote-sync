import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return Buffer.from(JSON.stringify(normalized(value)));
}

export function sha256Bytes(payload) {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function hmacSignature(token, payload) {
  return crypto.createHmac("sha256", token).update(payload).digest("hex");
}

export function verifyHmac(token, payload, signature) {
  const expected = Buffer.from(hmacSignature(token, payload), "hex");
  let actual;
  try { actual = Buffer.from(signature, "hex"); } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function secureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function utcNow() {
  return new Date().toISOString();
}

export function firstIdentifier(value, ...keys) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

export function rewriteIdentifiers(value, mapping) {
  if (typeof value === "string") return mapping[value] ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteIdentifiers(item, mapping));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteIdentifiers(item, mapping)]));
  }
  return value;
}

export function editableFields(value, allowed) {
  return Object.fromEntries([...allowed].filter((key) => value?.[key] !== undefined && value[key] !== null).map((key) => [key, value[key]]));
}

export function atomicWriteJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temp, filePath);
  try { fs.chmodSync(filePath, mode); } catch { /* Windows */ }
}

export function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransportError(error) {
  const code = error?.cause?.code || error?.code;
  return error?.name === "AbortError" || error instanceof TypeError || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(code);
}

export function usableIpv4(value) {
  const parts = String(value || "").trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const octets = parts.map(Number);
  return octets[0] !== 0 && octets[0] !== 127 && octets[0] < 224 && !octets.every((part) => part === 255);
}

export function firstLanIpv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal && usableIpv4(item.address)) return item.address;
    }
  }
  return null;
}

export function reachableAgentUrl(config) {
  if (!config) return null;
  if (config.agent_public_url) return String(config.agent_public_url).replace(/\/$/, "");
  const host = usableIpv4(config.remote?.host) ? config.remote.host : firstLanIpv4();
  return host ? `http://${host}:${Number(config.agent_port || 11081)}` : null;
}
