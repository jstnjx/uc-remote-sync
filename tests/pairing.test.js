import test from "node:test";
import assert from "node:assert/strict";
import { formatPeerLines, parsePeerLines } from "../src/pairing/config.js";
import {
  discoverRemoteDevicesFromPacket,
  discoverServicesFromPacket,
  displayPairingIdentifier,
  generatePairingIdentifier,
  isUsableIpv4Address,
  normalizePairingIdentifier,
  parseDnsPacket,
  remoteSyncServiceFromHealth,
  RemoteSyncMdnsPublisher
} from "../src/pairing/mdns.js";

test("pairing identifiers are human readable and normalize consistently", () => {
  for (let index = 0; index < 100; index += 1) {
    const identifier = generatePairingIdentifier();
    assert.match(identifier, /^RMS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(displayPairingIdentifier(normalizePairingIdentifier(identifier)), identifier);
  }
});

test("master pairing input accepts identifier and token only", () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const [peer] = parsePeerLines(`RMS-ABCD-EFGH|${token}`);
  assert.equal(peer.identifier, "RMS-ABCD-EFGH");
  assert.equal(peer.peer_id, "rms-abcdefgh");
  assert.equal(peer.name, "RMS-ABCD-EFGH");
  assert.equal(peer.url, null);
  assert.equal(peer.token, token);
});

test("pairing input supports friendly names and advanced fallbacks", () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const input = `Bedroom|RMS-WXYZ-2345|${token}|http://10.1.1.102:11081|FC:84:A7:66:AE:14|10.1.1.255,10.1.2.255`;
  const [peer] = parsePeerLines(input);
  assert.deepEqual(peer, {
    peer_id: "rms-wxyz2345",
    identifier: "RMS-WXYZ-2345",
    name: "Bedroom",
    url: "http://10.1.1.102:11081",
    token,
    mac: "FC:84:A7:66:AE:14",
    broadcasts: ["10.1.1.255", "10.1.2.255"],
    enabled: true
  });
  assert.equal(formatPeerLines([peer]), input);
});

test("legacy name, URL and token entries remain usable", () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const [peer] = parsePeerLines(`Old Child|http://10.1.1.50:11081|${token}|FC:84:A7:66:AE:15|10.1.1.255`);
  assert.equal(peer.identifier, null);
  assert.equal(peer.url, "http://10.1.1.50:11081");
  assert.equal(peer.token, token);
  assert.equal(peer.mac, "FC:84:A7:66:AE:15");
  assert.deepEqual(peer.broadcasts, ["10.1.1.255"]);
  assert.equal(formatPeerLines([peer]), `Old Child|http://10.1.1.50:11081|${token}|FC:84:A7:66:AE:15|10.1.1.255`);
});

test("pairing mDNS advertisement contains PTR, SRV, TXT and A records", () => {
  const publisher = new RemoteSyncMdnsPublisher({
    identifier: "RMS-ABCD-EFGH",
    port: 11081,
    name: "Bedroom",
    version: "0.3.0",
    nodeId: "child-node",
    ready: true,
    interfaceValue: "10.1.1.102"
  });
  const packet = parseDnsPacket(publisher.packet());
  assert.ok(packet.records.some((record) => record.type === 12 && record.ptr?.includes("RMS-ABCD-EFGH")));
  assert.ok(packet.records.some((record) => record.type === 33 && record.port === 11081));
  assert.ok(packet.records.some((record) => record.type === 16 && record.txt?.id === "RMS-ABCD-EFGH" && record.txt?.name === "Bedroom" && record.txt?.ready === "1" && record.txt?.state === "ready"));
  assert.ok(packet.records.some((record) => record.type === 1 && record.address === "10.1.1.102"));
});


test("paired mDNS advertisements remain discoverable but are not ready", () => {
  const publisher = new RemoteSyncMdnsPublisher({
    identifier: "RMS-PAIR-ED23",
    port: 11081,
    name: "Paired child",
    version: "0.3.0",
    ready: false,
    interfaceValue: "10.1.1.103"
  });
  const packet = parseDnsPacket(publisher.packet());
  const txt = packet.records.find((record) => record.type === 16)?.txt;
  assert.equal(txt.ready, "0");
  assert.equal(txt.state, "paired");
});


test("loopback addresses are never treated as reachable child endpoints", () => {
  assert.equal(isUsableIpv4Address("127.0.0.1"), false);
  assert.equal(isUsableIpv4Address("0.0.0.0"), false);
  assert.equal(isUsableIpv4Address("224.0.0.251"), false);
  assert.equal(isUsableIpv4Address("10.1.1.102"), true);

  const publisher = new RemoteSyncMdnsPublisher({
    identifier: "RMS-LOOP-BACK",
    port: 11081,
    name: "Loopback child",
    version: "0.3.2",
    ready: true,
    interfaceValue: "127.0.0.1"
  });
  const packet = parseDnsPacket(publisher.packet());
  assert.equal(packet.records.some((record) => record.type === 1 && record.address === "127.0.0.1"), false);
});

test("discovery prefers the mDNS packet source address over advertised A records", () => {
  const publisher = new RemoteSyncMdnsPublisher({
    identifier: "RMS-SRCE-ADDR",
    port: 11081,
    name: "Bedroom",
    version: "0.3.2",
    ready: true,
    interfaceValue: "10.1.1.102"
  });
  const [service] = discoverServicesFromPacket(publisher.packet(), "10.1.1.170");
  assert.equal(service.address, "10.1.1.170");
  assert.equal(service.url, "http://10.1.1.170:11081");
  assert.equal(service.hostname, "remote-sync-srceaddr.local");
});


function dnsName(name) {
  const parts = [];
  for (const label of String(name).replace(/\.$/, "").split(".")) {
    const bytes = Buffer.from(label);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
function be16(value) { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }
function be32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function rr(name, type, data) { return Buffer.concat([dnsName(name), be16(type), be16(1), be32(120), be16(data.length), data]); }
function txt(values) {
  return Buffer.concat(Object.entries(values).flatMap(([key, value]) => {
    const bytes = Buffer.from(`${key}=${value}`);
    return [Buffer.from([bytes.length]), bytes];
  }));
}
function remoteAdvertisementPacket({ address = "10.1.1.102", hostname = "Remote3-1234.local.", instance = "Remote 3._uc-remote._tcp.local." } = {}) {
  const service = "_uc-remote._tcp.local.";
  const answers = [rr(service, 12, dnsName(instance))];
  const additionals = [
    rr(instance, 33, Buffer.concat([be16(0), be16(0), be16(80), dnsName(hostname)])),
    rr(instance, 16, txt({ model: "UCR3", ver: "2.9.7", ver_api: "0.17.6" })),
    rr(hostname, 1, Buffer.from(address.split(".").map(Number)))
  ];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([header, ...answers, ...additionals]);
}

test("system Remote advertisements provide candidates for child health probing", () => {
  const packet = remoteAdvertisementPacket({ address: "10.1.1.102" });
  const [remote] = discoverRemoteDevicesFromPacket(packet, "10.1.1.170");
  assert.equal(remote.address, "10.1.1.170");
  assert.equal(remote.hostname, "Remote3-1234.local");
  assert.equal(remote.model, "UCR3");
});

test("a ready child health response becomes a master setup discovery result", () => {
  const remote = { address: "10.1.1.102", hostname: "Remote3-1234.local", name: "Remote 3" };
  const child = remoteSyncServiceFromHealth(remote, {
    service: "remote-sync",
    role: "child",
    version: "0.3.3",
    node_id: "child-node",
    node_name: "Bedroom Remote",
    identifier: "RMS-T7NH-URAX",
    ready_to_pair: true
  });
  assert.deepEqual(child, {
    identifier: "RMS-T7NH-URAX",
    name: "Bedroom Remote",
    address: "10.1.1.102",
    hostname: "Remote3-1234.local",
    port: 11081,
    url: "http://10.1.1.102:11081",
    version: "0.3.3",
    node_id: "child-node",
    ready: true,
    state: "ready",
    discovery: "remote-mdns-capabilities",
    mac: null,
    broadcasts: [],
    protocol: {
      version: "0.3.3",
      api_version: 1,
      protocol_version: 1,
      snapshot_schema: 4,
      capabilities: []
    }
  });
});

test("non-child health responses are excluded from pairing discovery", () => {
  assert.equal(remoteSyncServiceFromHealth({ address: "10.1.1.170" }, { service: "remote-sync", role: "master", identifier: "RMS-ABCD-EFGH", ready_to_pair: true }), null);
  assert.equal(remoteSyncServiceFromHealth({ address: "10.1.1.170" }, { service: "other", role: "child", identifier: "RMS-ABCD-EFGH", ready_to_pair: true }), null);
});
