import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Build metadata
// -----------------------------------------------------------------------------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(fs.readFileSync(path.join(root, "driver.json"), "utf8"));
const version = process.env.REMOTE_SYNC_VERSION || metadata.version;
if (version !== metadata.version) throw new Error(`REMOTE_SYNC_VERSION ${version} does not match driver.json ${metadata.version}`);
const output = path.join(root, `remote-sync-${version}.tar.gz`);
const packageDir = path.join(root, "package");
fs.rmSync(packageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
fs.mkdirSync(path.join(packageDir, "config"), { recursive: true });
fs.mkdirSync(path.join(packageDir, "data"), { recursive: true });
fs.cpSync(path.join(root, "src"), path.join(packageDir, "bin"), { recursive: true });
fs.writeFileSync(path.join(packageDir, "bin", "package.json"), '{"type":"module"}\n');
fs.chmodSync(path.join(packageDir, "bin", "driver.js"), 0o755);
fs.copyFileSync(path.join(root, "driver.json"), path.join(packageDir, "driver.json"));
fs.copyFileSync(path.join(root, "remote-sync.png"), path.join(packageDir, "remote-sync.png"));

// -----------------------------------------------------------------------------
// Tar archive writer
// -----------------------------------------------------------------------------

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
function walk(directory, prefix = "") {
  const entries = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, item.name); const relative = `${prefix}${item.name}`;
    if (item.isSymbolicLink()) throw new Error(`Symlinks are not permitted: ${relative}`);
    if (item.isDirectory()) { entries.push({ name: `${relative}/`, full, directory: true }); entries.push(...walk(full, `${relative}/`)); }
    else if (item.isFile()) entries.push({ name: relative, full, directory: false });
  }
  return entries;
}
const chunks = [];
for (const entry of walk(packageDir)) {
  const content = entry.directory ? Buffer.alloc(0) : fs.readFileSync(entry.full);
  const executable = entry.name === "bin/driver.js";
  chunks.push(header(entry.name, content.length, entry.directory ? 0o755 : executable ? 0o755 : 0o644, entry.directory ? "5" : "0"));
  if (content.length) { chunks.push(content); const padding = (512 - (content.length % 512)) % 512; if (padding) chunks.push(Buffer.alloc(padding)); }
}
chunks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
if (archive.length >= 100 * 1024 * 1024) throw new Error("Archive exceeds the 100 MB custom-integration limit");
fs.writeFileSync(output, archive);
const digest = crypto.createHash("sha256").update(archive).digest("hex");
fs.writeFileSync(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);
console.log(`Created ${output}`);
console.log(`SHA-256 ${digest}`);
