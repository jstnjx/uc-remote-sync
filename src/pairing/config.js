import { displayPairingIdentifier, normalizePairingIdentifier } from "./mdns.js";

// -----------------------------------------------------------------------------
// Pairing identifiers
// -----------------------------------------------------------------------------

export function isPairingIdentifier(value) {
  const raw = String(value || "").toUpperCase().replace(/[-\s]/g, "");
  if (!raw.startsWith("RMS")) return false;
  return /^[A-HJ-NP-Z2-9]{8,12}$/.test(raw.slice(3));
}

function peerId(identifier) {
  return `rms-${normalizePairingIdentifier(identifier).toLowerCase()}`;
}

function splitCsv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname);
  } catch { return false; }
}

function isMac(value) {
  return /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(String(value || ""));
}

// -----------------------------------------------------------------------------
// Peer configuration parsing
// -----------------------------------------------------------------------------

export function parsePeerLines(value) {
  return String(value || "")
    .replace(/;/g, "\n")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const parts = entry.split("|").map((item) => item.trim());
      let name;
      let identifier;
      let token;
      let remaining;
      let legacyUrl = null;

      if (isPairingIdentifier(parts[0])) {
        [identifier, token] = parts;
        name = displayPairingIdentifier(identifier);
        remaining = parts.slice(2);
      } else if (isPairingIdentifier(parts[1])) {
        [name, identifier, token] = parts;
        remaining = parts.slice(3);
      } else if (isUrl(parts[1]) && parts.length >= 3) {
        name = parts[0];
        legacyUrl = parts[1].replace(/\/$/, "");
        token = parts[2];
        identifier = null;
        remaining = parts.slice(3);
      } else {
        throw new Error(`Invalid satellite entry ${index + 1}; expected IDENTIFIER|TOKEN or NAME|IDENTIFIER|TOKEN`);
      }

      identifier = identifier ? displayPairingIdentifier(identifier) : null;
      if (!token || token.length < 16) throw new Error(`Invalid token in satellite entry ${index + 1}`);

      let url = legacyUrl;
      let mac = null;
      let broadcasts = [];
      const firstAdvanced = remaining.shift();
      if (firstAdvanced) {
        if (isUrl(firstAdvanced)) url = firstAdvanced.replace(/\/$/, "");
        else if (isMac(firstAdvanced)) mac = firstAdvanced;
        else broadcasts = splitCsv(firstAdvanced);
      }
      const secondAdvanced = remaining.shift();
      if (secondAdvanced) {
        if (!mac && isMac(secondAdvanced)) mac = secondAdvanced;
        else broadcasts.push(...splitCsv(secondAdvanced));
      }
      if (remaining.length) broadcasts.push(...splitCsv(remaining.join("|")));
      broadcasts = [...new Set(broadcasts)];

      return {
        peer_id: identifier ? peerId(identifier) : String(name || `child-${index + 1}`).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase(),
        identifier,
        name: name || identifier,
        url,
        token,
        mac,
        broadcasts,
        enabled: true
      };
    });
}

export function formatPeerLines(peers = []) {
  return peers.map((peer) => {
    const identifier = peer.identifier ? displayPairingIdentifier(peer.identifier) : null;
    if (!identifier && peer.url) {
      return [peer.name || peer.peer_id, peer.url, peer.token, peer.mac || "", (peer.broadcasts || []).join(",")].join("|").replace(/\|+$/, "");
    }
    const values = [];
    if (peer.name && peer.name !== identifier) values.push(peer.name);
    values.push(identifier, peer.token);
    if (peer.url || peer.mac || peer.broadcasts?.length) values.push(peer.url || "");
    if (peer.mac || peer.broadcasts?.length) values.push(peer.mac || "");
    if (peer.broadcasts?.length) values.push(peer.broadcasts.join(","));
    return values.join("|").replace(/\|+$/, "");
  }).join("\n");
}
