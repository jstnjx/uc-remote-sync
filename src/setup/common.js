import crypto from "node:crypto";
import * as uc from "../integration/api.js";
import { CoreApiError } from "../core/client.js";
import { normalizeMacAddress } from "../network/identity.js";
import { normalizePairingIdentifier } from "../pairing/mdns.js";

// -----------------------------------------------------------------------------
// Setup parsing and validation
// -----------------------------------------------------------------------------

export function parseRemoteAddress(value, explicitPort = null) {
  const normalized = String(value || "").includes("://") ? String(value).trim() : `http://${String(value).trim()}`;
  const parsed = new URL(normalized);
  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid remote address.");

  const rawPort = String(explicitPort ?? "").trim();
  const selectedPort = rawPort ? Number(rawPort) : (parsed.port ? Number(parsed.port) : null);
  if (selectedPort !== null && (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535)) {
    throw new Error("Remote HTTP port must be an integer between 1 and 65535.");
  }

  return { scheme: parsed.protocol.slice(0, -1), host: parsed.hostname, port: selectedPort };
}

export function nodeId(version, host) {
  return String(version?.address || version?.hostname || host)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || crypto.randomUUID();
}

export function splitCsv(value) {
  return [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

export function physicalDockTokens(value, existing = null) {
  const raw = String(value || "").trim();
  if (!raw) return existing && typeof existing === "object" ? structuredClone(existing) : { default_token: "", tokens: {} };
  if (!raw.includes("=")) return { default_token: raw, tokens: {} };
  const tokens = {};
  for (const entry of raw.split(/[;,\n]+/)) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const dockId = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (dockId && token) tokens[dockId] = token;
  }
  if (!Object.keys(tokens).length) throw new Error("Invalid Dock token mapping. Use DOCK_ID=token separated by commas.");
  return { default_token: "", tokens };
}

export function networkIdentityText(network) {
  if (!network) return "Network identity has not been detected yet.";
  return [
    `Interface: ${network.interface || "unavailable"}`,
    `Address: ${network.address || "unavailable"}`,
    `MAC: ${network.mac || "unavailable"}`,
    `WoWLAN broadcast: ${network.broadcasts?.join(", ") || "unavailable"}`,
    `Source: ${network.source || "unavailable"}`
  ].join(" — ");
}

export function networkOverrides(values, prefix = "network") {
  const macRaw = String(values?.[`${prefix}_mac_override`] || "").trim();
  const mac = macRaw ? normalizeMacAddress(macRaw) : null;
  if (macRaw && !mac) throw new Error("The advanced MAC override is invalid.");
  return { mac, broadcasts: splitCsv(values?.[`${prefix}_broadcast_overrides`] || "") };
}

export function satelliteKey(identifier) {
  return normalizePairingIdentifier(identifier).toLowerCase();
}

export function setupErrorType(error) {
  if (error instanceof CoreApiError && [401, 403].includes(error.status)) return uc.IntegrationSetupError.AuthorizationError;
  if (error.name === "AbortError" || error.code === "ETIMEDOUT") return uc.IntegrationSetupError.Timeout;
  return uc.IntegrationSetupError.Other;
}

export function setupErrorMessage(error) {
  if (error instanceof CoreApiError && [401, 403].includes(error.status)) return "The PIN or API authorization was rejected.";
  if (error.name === "AbortError" || error.code === "ETIMEDOUT") return "The remote did not respond before the setup timeout.";
  return error.message || "Setup failed.";
}

export function approvalPrompt(message = "Approve the Remote Sync API-key request on the remote, then continue.") {
  return new uc.RequestUserConfirmation(
    { en: "Approve API access" },
    { en: message },
    undefined,
    { en: "Continue after approval." }
  );
}
