import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { driverJsonPath } from "./paths.js";

// -----------------------------------------------------------------------------
// Custom-integration archive builder
//
// Used by tools/build-embedded.js to produce the release archive and by a Primary at runtime to install or update
// Remote Sync on Satellites through `POST /api/intg/install`. Layout (see the Core-API install requirements):
//   driver.json, remote-sync.png, bin/driver.js (+ sources), config/, data/
// -----------------------------------------------------------------------------

export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function octal(value, length) { return `${Math.max(0, value).toString(8).padStart(length - 1, "0")}\0`; }

function header(name, size, mode, type) {
  const value = Buffer.alloc(512, 0);
  const write = (text, offset, length) => Buffer.from(text).copy(value, offset, 0, length);
  if (Buffer.byteLength(name) > 100) throw new Error(`Archive path is too long: ${name}`);
  write(name, 0, 100); write(octal(mode, 8), 100, 8); write(octal(0, 8), 108, 8); write(octal(0, 8), 116, 8);
  write(octal(size, 12), 124, 12); write(octal(0, 12), 136, 12); value.fill(0x20, 148, 156); value[156] = type.charCodeAt(0);
  write("ustar\0", 257, 6); write("00", 263, 2); write("root", 265, 32); write("root", 297, 32);
  let sum = 0; for (const byte of value) sum += byte;
  write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return value;
}

function walk(directory, prefix, entries, exclude) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, item.name);
    const relative = `${prefix}${item.name}`;
    if (exclude(relative)) continue;
    if (item.isSymbolicLink()) throw new Error(`Symlinks are not permitted: ${relative}`);
    if (item.isDirectory()) { entries.push({ name: `${relative}/`, directory: true }); walk(full, `${relative}/`, entries, exclude); }
    else if (item.isFile()) entries.push({ name: relative, full, directory: false });
  }
}

export function tarGzip(entries) {
  const chunks = [];
  for (const entry of entries) {
    const content = entry.directory ? Buffer.alloc(0) : (entry.content ?? fs.readFileSync(entry.full));
    const executable = entry.name === "bin/driver.js";
    chunks.push(header(entry.name, content.length, entry.directory || executable ? 0o755 : 0o644, entry.directory ? "5" : "0"));
    if (content.length) {
      chunks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  if (archive.length >= MAX_ARCHIVE_BYTES) throw new Error("Archive exceeds the 100 MB custom-integration limit");
  return archive;
}

// Build the installation archive from the running code. `binDir` is `src/` in a source or Docker deployment and
// `bin/` when running on a Remote; both contain driver.js and the module tree.
export function buildDriverArchive({ binDir = sourceDir, metadataPath = driverJsonPath(), iconPath = null } = {}) {
  const metadata = fs.readFileSync(metadataPath);
  JSON.parse(metadata.toString("utf8"));
  const icon = iconPath || path.join(path.dirname(metadataPath), "remote-sync.png");
  if (!fs.existsSync(path.join(binDir, "driver.js"))) throw new Error(`driver.js was not found in ${binDir}`);
  const entries = [
    { name: "bin/", directory: true },
    { name: "config/", directory: true },
    { name: "data/", directory: true },
    { name: "driver.json", content: metadata, directory: false }
  ];
  if (fs.existsSync(icon)) entries.push({ name: "remote-sync.png", full: icon, directory: false });
  const binEntries = [];
  walk(binDir, "bin/", binEntries, (relative) => relative === "bin/package.json" || relative.endsWith(".test.js"));
  entries.push(...binEntries);
  entries.push({ name: "bin/package.json", content: Buffer.from('{"type":"module"}\n'), directory: false });
  const order = (name) => (name === "driver.json" ? 0 : name === "remote-sync.png" ? 1 : 2);
  entries.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
  return tarGzip(entries);
}
