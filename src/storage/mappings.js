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
  // Every kind recorded for one source node, e.g. { activity: {...}, "resource:icon": {...} }.
  kinds(sourceNode) {
    const prefix = `${sourceNode}|`;
    const result = {};
    for (const [key, value] of Object.entries(this.data)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const separator = rest.indexOf("|");
      if (separator < 0) continue;
      const kind = rest.slice(0, separator);
      (result[kind] ||= {})[rest.slice(separator + 1)] = value;
    }
    return result;
  }
  clearNode(sourceNode) {
    const prefix = `${sourceNode}|`;
    for (const key of Object.keys(this.data)) if (key.startsWith(prefix)) delete this.data[key];
  }
  items(sourceNode, kind) {
    const prefix = `${sourceNode}|${kind}|`;
    return Object.fromEntries(Object.entries(this.data).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
  }
}
