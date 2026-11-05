import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDriverArchive } from "../src/shared/package.js";

// -----------------------------------------------------------------------------
// Build metadata
// -----------------------------------------------------------------------------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadataPath = path.join(root, "driver.json");
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const version = process.env.REMOTE_SYNC_VERSION || metadata.version;
if (version !== metadata.version) throw new Error(`REMOTE_SYNC_VERSION ${version} does not match driver.json ${metadata.version}`);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.version !== metadata.version) throw new Error(`package.json version ${packageJson.version} does not match driver.json ${metadata.version}`);
const output = path.join(root, `remote-sync-${version}.tar.gz`);

// -----------------------------------------------------------------------------
// Archive
// -----------------------------------------------------------------------------

// The same builder is used at runtime by a Primary to install or update Satellites.
const archive = buildDriverArchive({ binDir: path.join(root, "src"), metadataPath, iconPath: path.join(root, "remote-sync.png") });
fs.writeFileSync(output, archive);
const digest = crypto.createHash("sha256").update(archive).digest("hex");
fs.writeFileSync(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);
console.log(`Created ${output}`);
console.log(`SHA-256 ${digest}`);
