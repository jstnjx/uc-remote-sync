import dgram from "node:dgram";
import { sleep } from "../shared/util.js";

// -----------------------------------------------------------------------------
// Wake-on-LAN
// -----------------------------------------------------------------------------

export function normalizeMac(mac) {
  const cleaned = mac.replace(/[:.\-]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(cleaned)) throw new Error(`Invalid MAC address: ${mac}`);
  return Buffer.from(cleaned, "hex");
}

async function sendOne(address, payload) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (error) => { socket.close(); resolve({ error: error.message }); });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(payload, 9, address, (error) => { socket.close(); resolve({ error: error?.message || null }); });
    });
  });
}

export async function sendMagicPacket(mac, broadcasts = [], { packets = 3, intervalMs = 200 } = {}) {
  const macBytes = normalizeMac(mac);
  const payload = Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => macBytes)]);
  const targets = broadcasts.length ? broadcasts : ["255.255.255.255"];
  const results = [];
  for (const address of targets) {
    let sent = 0;
    let error = null;
    for (let index = 0; index < packets; index += 1) {
      const result = await sendOne(address, payload);
      if (result.error) { error = result.error; break; }
      sent += 1;
      if (intervalMs && index + 1 < packets) await sleep(intervalMs);
    }
    results.push({ broadcast: address, sent, error });
  }
  return results;
}
