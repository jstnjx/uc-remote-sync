import path from "node:path";
import { dataHome } from "./paths.js";
import { DEFAULT_OPERATION_CACHE_SIZE, DEFAULT_OPERATION_TTL_MS } from "./constants.js";
import { atomicWriteJson, readJson } from "./util.js";

export class OperationCache {
  constructor(filePath = path.join(dataHome(), "operations.json"), { ttlMs = DEFAULT_OPERATION_TTL_MS, maxEntries = DEFAULT_OPERATION_CACHE_SIZE } = {}) {
    this.filePath = filePath;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.data = readJson(filePath, {});
    this.prune();
  }
  prune() {
    const cutoff = Date.now() - this.ttlMs;
    const entries = Object.entries(this.data).filter(([, item]) => Number(item.created_at) >= cutoff)
      .sort((a, b) => Number(b[1].created_at) - Number(a[1].created_at)).slice(0, this.maxEntries);
    this.data = Object.fromEntries(entries);
  }
  get(operationId) { this.prune(); return this.data[operationId]?.result || null; }
  put(operationId, result) { this.data[operationId] = { created_at: Date.now(), result }; this.prune(); atomicWriteJson(this.filePath, this.data); }
  count() { this.prune(); return Object.keys(this.data).length; }
}
