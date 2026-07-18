import path from "node:path";
import { dataHome } from "../shared/paths.js";
import { atomicWriteJson, readJson } from "../shared/util.js";

// -----------------------------------------------------------------------------
// Identifier mapping persistence
// -----------------------------------------------------------------------------

export class MappingStore {
  constructor(filePath = path.join(dataHome(), "id-mappings.json")) {
    this.filePath = filePath;
    this.data = readJson(filePath, {});
  }
  key(sourceNode, kind, sourceId) { return `${sourceNode}|${kind}|${sourceId}`; }
  save() { atomicWriteJson(this.filePath, this.data); }
  get(sourceNode, kind, sourceId) { return this.data[this.key(sourceNode, kind, sourceId)] || null; }
  set(sourceNode, kind, sourceId, targetId) { this.data[this.key(sourceNode, kind, sourceId)] = targetId; }
  remove(sourceNode, kind, sourceId) { delete this.data[this.key(sourceNode, kind, sourceId)]; }
  items(sourceNode, kind) {
    const prefix = `${sourceNode}|${kind}|`;
    return Object.fromEntries(Object.entries(this.data).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
  }
}
