import assert from "node:assert/strict";
import test from "node:test";
import { calculateBroadcastAddress, normalizeMacAddress } from "../src/network/identity.js";
import { networkIdentityText, networkOverrides } from "../src/setup/common.js";

test("directed WoWLAN broadcasts are calculated from IPv4 netmasks", () => {
  assert.equal(calculateBroadcastAddress("10.1.1.102", "255.255.255.0"), "10.1.1.255");
  assert.equal(calculateBroadcastAddress("10.1.5.42", "255.255.252.0"), "10.1.7.255");
});

test("network identity is displayed with source and supports validated overrides", () => {
  const overrides = networkOverrides({
    network_mac_override: "FC-84-A7-66-AE-14",
    network_broadcast_overrides: "10.1.1.255, 10.1.2.255"
  });
  assert.equal(overrides.mac, normalizeMacAddress("FC-84-A7-66-AE-14"));
  assert.deepEqual(overrides.broadcasts, ["10.1.1.255", "10.1.2.255"]);
  assert.match(networkIdentityText({
    address: "10.1.1.102",
    interface: "wlan0",
    mac: overrides.mac,
    broadcasts: overrides.broadcasts,
    source: "override"
  }), /wlan0.*fc:84:a7:66:ae:14.*10\.1\.1\.255.*override/i);
});
