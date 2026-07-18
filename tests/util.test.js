import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, hmacSignature, rewriteIdentifiers, verifyHmac } from "../src/shared/util.js";

test("canonical JSON sorts object keys", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }).toString(), '{"a":{"c":3,"d":4},"b":2}');
});

test("HMAC signatures verify", () => {
  const payload = Buffer.from("snapshot");
  const signature = hmacSignature("token", payload);
  assert.equal(verifyHmac("token", payload, signature), true);
  assert.equal(verifyHmac("wrong", payload, signature), false);
});

test("identifier rewriting is recursive", () => {
  assert.deepEqual(rewriteIdentifiers({ id: "a", list: ["b", { x: "a" }] }, { a: "A", b: "B" }), { id: "A", list: ["B", { x: "A" }] });
});
