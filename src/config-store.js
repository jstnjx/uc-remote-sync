import fs from "node:fs";
import path from "node:path";
import { configHome } from "./paths.js";
import { atomicWriteJson, readJson } from "./util.js";
import { normalizeConfig } from "./models.js";

export class ConfigStore {
  constructor(filePath = path.join(configHome(), "remote-sync.json")) { this.filePath = filePath; }
  load() { const value = readJson(this.filePath, null); return value ? normalizeConfig(value) : null; }
  save(config) { atomicWriteJson(this.filePath, config); }
  clear() { try { fs.unlinkSync(this.filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
}
