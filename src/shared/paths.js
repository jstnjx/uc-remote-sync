import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------------------------
// Runtime paths
// -----------------------------------------------------------------------------

function ensureDirectory(value) {
  fs.mkdirSync(value, { recursive: true });
  return value;
}

export function configHome() {
  return ensureDirectory(process.env.UC_CONFIG_HOME || process.env.HOME || path.resolve("config"));
}

export function dataHome() {
  return ensureDirectory(process.env.STATE_DIRECTORY || process.env.UC_DATA_HOME || path.resolve("data"));
}

export function driverJsonPath() {
  if (process.env.UC_DRIVER_JSON) return process.env.UC_DRIVER_JSON;
  const candidates = [
    path.resolve("driver.json"),
    path.resolve(path.dirname(process.execPath), "..", "driver.json"),
    path.resolve(path.dirname(process.execPath), "driver.json"),
    path.resolve(moduleDir, "..", "driver.json")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}
