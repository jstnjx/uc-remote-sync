import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
const files = [...walk("src"), ...walk("tools"), ...walk("tests")].filter((file) => file.endsWith(".js"));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
const driver = JSON.parse(fs.readFileSync("driver.json", "utf8"));
if (driver.developer?.name !== "jstnjx") throw new Error("driver.json developer name must be jstnjx");
if (driver.home_page !== "https://github.com/jstnjx/uc-remote-sync") throw new Error("driver.json home_page is incorrect");
if (driver.port !== 11082) throw new Error("driver.json Integration API port must be 11082");
console.log(`Checked ${files.length} JavaScript files and driver metadata.`);
