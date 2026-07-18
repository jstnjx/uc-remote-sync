import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OperationCache } from "../src/storage/operations.js";
import { MappingStore } from "../src/storage/mappings.js";

test("operation cache persists and deduplicates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-sync-"));
  const file = path.join(dir, "operations.json");
  const cache = new OperationCache(file, { ttlMs: 60_000, maxEntries: 2 });
  cache.put("one", { success: true });
  assert.deepEqual(new OperationCache(file).get("one"), { success: true });
});

test("mapping store persists generated identifiers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-sync-"));
  const file = path.join(dir, "mappings.json");
  const mappings = new MappingStore(file);
  mappings.set("master", "activity", "source", "target");
  mappings.save();
  assert.equal(new MappingStore(file).get("master", "activity", "source"), "target");
});
