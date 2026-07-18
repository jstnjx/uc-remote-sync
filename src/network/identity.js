import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

// -----------------------------------------------------------------------------
// Address normalization
// -----------------------------------------------------------------------------

function ipv4ToInteger(value) {
  const parts = String(value || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function integerToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

export function isUsableIpv4Address(value) {
  const integer = ipv4ToInteger(value);
  if (integer === null) return false;
  const first = integer >>> 24;
  if (first === 0 || first === 127 || first >= 224) return false;
  return integer !== 0xffffffff;
}

export function normalizeMacAddress(value) {
  const cleaned = String(value || "").trim().replace(/[^0-9a-f]/gi, "").toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(cleaned) || cleaned === "000000000000" || cleaned === "ffffffffffff") return null;
  return cleaned.match(/.{2}/g).join(":");
}

export function calculateBroadcastAddress(address, netmask) {
  const ip = ipv4ToInteger(address);
  const mask = ipv4ToInteger(netmask);
  if (ip === null || mask === null) return null;
  return integerToIpv4((ip | (~mask >>> 0)) >>> 0);
}

function sameSubnet(address, target, netmask) {
  const ip = ipv4ToInteger(address);
  const destination = ipv4ToInteger(target);
  const mask = ipv4ToInteger(netmask);
  if (ip === null || destination === null || mask === null) return false;
  return (ip & mask) === (destination & mask);
}

// -----------------------------------------------------------------------------
// Local interface discovery
// -----------------------------------------------------------------------------

function isVirtualInterface(name) {
  return /^(?:lo|docker|br-|veth|virbr|podman|cni|flannel|zt|tailscale|tun|tap|wg)/i.test(String(name || ""));
}

function isWirelessInterface(name) {
  return /^(?:wl|wlan|wifi)/i.test(String(name || "")) || fs.existsSync(`/sys/class/net/${name}/wireless`);
}

function interfaceCandidates() {
  const values = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal || !isUsableIpv4Address(entry.address)) continue;
      const mac = normalizeMacAddress(entry.mac);
      const broadcast = calculateBroadcastAddress(entry.address, entry.netmask);
      values.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        cidr: entry.cidr || null,
        mac,
        broadcast,
        wireless: isWirelessInterface(name),
        virtual: isVirtualInterface(name)
      });
    }
  }
  return values;
}

function configuredInterfaceHints(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectInterface(candidates, { targetAddress = null, interfaceValue = null, preferWireless = false } = {}) {
  if (!candidates.length) return null;
  const hints = configuredInterfaceHints(interfaceValue);
  const exact = candidates.find((candidate) => hints.includes(candidate.name) || hints.includes(candidate.address));
  if (exact) return exact;

  let matching = targetAddress
    ? candidates.filter((candidate) => sameSubnet(candidate.address, targetAddress, candidate.netmask))
    : candidates;
  if (!matching.length) matching = candidates;

  const physical = matching.filter((candidate) => !candidate.virtual);
  if (physical.length) matching = physical;
  if (preferWireless) {
    const wireless = matching.filter((candidate) => candidate.wireless);
    if (wireless.length) matching = wireless;
  }

  return matching.sort((left, right) => {
    if (left.wireless !== right.wireless) return left.wireless ? -1 : 1;
    if (left.virtual !== right.virtual) return left.virtual ? 1 : -1;
    return left.name.localeCompare(right.name);
  })[0] || null;
}

function isLocalHost(host, resolvedAddress, candidates) {
  const value = String(host || "").toLowerCase();
  if (["127.0.0.1", "localhost", "::1"].includes(value)) return true;
  return candidates.some((candidate) => candidate.address === resolvedAddress || candidate.address === host);
}

// -----------------------------------------------------------------------------
// Neighbor discovery
// -----------------------------------------------------------------------------

async function resolveIpv4(host) {
  if (isUsableIpv4Address(host)) return String(host);
  try {
    const result = await dns.lookup(String(host), { family: 4 });
    return isUsableIpv4Address(result.address) ? result.address : null;
  } catch {
    return null;
  }
}

function macFromProcArp(address) {
  try {
    const rows = fs.readFileSync("/proc/net/arp", "utf8").split(/\r?\n/).slice(1);
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      if (fields[0] !== address) continue;
      const flags = Number.parseInt(fields[2], 16);
      const mac = normalizeMacAddress(fields[3]);
      if (mac && (flags & 0x2) !== 0) return mac;
    }
  } catch {
    return null;
  }
  return null;
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 1500 });
  return result.status === 0 ? String(result.stdout || "") : "";
}

function macFromNeighborCommands(address) {
  const outputs = [
    commandOutput("ip", ["neigh", "show", address]),
    commandOutput("arp", ["-n", address]),
    commandOutput("arp", ["-a", address])
  ];
  for (const output of outputs) {
    const match = output.match(/(?:lladdr\s+|\bat\s+|\s)([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})\b/i);
    const mac = normalizeMacAddress(match?.[1]);
    if (mac) return mac;
  }
  return null;
}

function neighborMac(address) {
  if (!address) return null;
  return macFromProcArp(address) || macFromNeighborCommands(address);
}

// -----------------------------------------------------------------------------
// Remote network identity
// -----------------------------------------------------------------------------

function normalizeBroadcasts(values) {
  const items = Array.isArray(values) ? values : String(values || "").split(",");
  return [...new Set(items.map((item) => String(item).trim()).filter(isUsableIpv4Address))];
}

export async function detectRemoteNetworkIdentity({
  host,
  interfaceValue = process.env.UC_MDNS_ADDRESS || process.env.UC_INTEGRATION_INTERFACE || null,
  fallbackMac = null,
  fallbackBroadcasts = [],
  macOverride = null,
  broadcastsOverride = [],
  preferWireless = true
} = {}) {
  const candidates = interfaceCandidates();
  const address = await resolveIpv4(host);
  const local = isLocalHost(host, address, candidates);
  const eligible = !local && address
    ? candidates.filter((candidate) => sameSubnet(candidate.address, address, candidate.netmask))
    : candidates;
  const selected = selectInterface(eligible, {
    targetAddress: local ? null : address,
    interfaceValue,
    preferWireless: local ? preferWireless : false
  });

  const detectedMac = local ? selected?.mac : neighborMac(address);
  const overrideMac = normalizeMacAddress(macOverride);
  const savedMac = normalizeMacAddress(fallbackMac);
  const broadcasts = normalizeBroadcasts(broadcastsOverride);
  if (!broadcasts.length && selected?.broadcast) broadcasts.push(selected.broadcast);
  if (!broadcasts.length) broadcasts.push(...normalizeBroadcasts(fallbackBroadcasts));

  return {
    mac: overrideMac || detectedMac || savedMac || null,
    broadcasts: [...new Set(broadcasts)],
    address: address || selected?.address || null,
    interface: selected?.name || null,
    local,
    source: overrideMac || normalizeBroadcasts(broadcastsOverride).length
      ? "override"
      : detectedMac || selected?.broadcast
        ? "automatic"
        : savedMac || normalizeBroadcasts(fallbackBroadcasts).length
          ? "saved"
          : "unavailable"
  };
}
