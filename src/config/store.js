import fs from "node:fs";
import path from "node:path";
import { configHome } from "../shared/paths.js";
import { atomicWriteJson, readJson } from "../shared/util.js";
import { ConfigurationError, normalizeAndValidateConfig, validateConfig } from "./schema.js";

// -----------------------------------------------------------------------------
// Configuration persistence
// -----------------------------------------------------------------------------

export class ConfigStore {
  constructor(filePath = path.join(configHome(), "remote-sync.json")) {
    this.filePath = filePath;
    this.lastError = null;
  }

  load() {
    const raw = readJson(this.filePath, null);
    if (!raw) return null;
    try {
      const result = normalizeAndValidateConfig(raw);
      if (result.migrated) {
        this.backup(`schema-${result.from}-to-${result.to}`);
        atomicWriteJson(this.filePath, result.config);
      }
      this.lastError = null;
      return result.config;
    } catch (error) {
      this.lastError = error instanceof ConfigurationError ? error : new ConfigurationError(error.message, { cause: error });
      throw this.lastError;
    }
  }

  save(config) {
    const normalized = validateConfig(config);
    atomicWriteJson(this.filePath, normalized);
    this.lastError = null;
    return normalized;
  }

  backup(reason = "backup") {
    if (!fs.existsSync(this.filePath)) return null;
    const backupPath = `${this.filePath}.bak`;
    fs.copyFileSync(this.filePath, backupPath);
    const datedPath = `${this.filePath}.${reason}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    try { fs.copyFileSync(this.filePath, datedPath, fs.constants.COPYFILE_EXCL); } catch {}
    return backupPath;
  }

  clear() {
    try {
      fs.unlinkSync(this.filePath);
      this.lastError = null;
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
}

export { ConfigurationError } from "./schema.js";
