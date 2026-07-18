import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMac } from "../src/network/wol.js";

test("MAC normalization", () => {
  assert.equal(normalizeMac("FC:84:A7:66:AE:14").toString("hex"), "fc84a766ae14");
  assert.throws(() => normalizeMac("invalid"));
});
