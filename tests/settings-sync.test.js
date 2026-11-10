import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDeviceSettings } from "../src/apply/settings.js";
import { hardwareFromResponses } from "../src/apply/hardware.js";
import { CoreApiError } from "../src/core/client.js";
import { CoreEventWatcher } from "../src/core/events.js";
import { createApplyReport } from "../src/shared/models.js";
import { DriftGuard } from "../src/service/drift-guard.js";
import { extractSettings, normalizeSettingsCategories, settingsDifferences, settingsFingerprint } from "../src/settings/catalog.js";
import { normalizeAndValidateConfig } from "../src/config/schema.js";
import { buildApplyPreview } from "../src/apply/preview.js";

// A `GET /cfg` answer shaped like the Core REST API's CfgAll.
function cfgAll(overrides = {}) {
  return {
    button: { brightness: 40, auto_brightness: false, features: ["static_color"], static_color: { rgb: [255, 0, 0], zones: ["MAIN"] } },
    display: { brightness: 70, auto_brightness: true },
    haptic: { enabled: true },
    sound: { enabled: false, volume: 30 },
    power_saving: { wakeup_sensitivity: 2, display_off_sec: 20, standby_sec: 180 },
    localization: { language_code: "de_DE", country_code: "DE", time_zone: "Europe/Berlin", time_format_24h: true, measurement_unit: "METRIC" },
    voice: { microphone: true, voice_assistant: { active: { entity_id: "hass.main.assist" } } },
    software_update: { check_for_updates: true, auto_update: false, ota_window_start: "02:00:00", ota_window_end: "05:00:00" },
    device: { name: "Living room" },
    network: { wifi: { ssid: "home" } },
    bt: { enabled: true },
    profile: { has_admin_pin: true },
    ...overrides
  };
}

function fakeCore(target) {
  const patches = [];
  return {
    patches,
    async getJson(p) { return p === "/cfg" ? structuredClone(target) : null; },
    async json(method, p, { json }) {
      patches.push({ method, path: p, json });
      const key = { "/cfg/voice_control": "voice" }[p] || p.replace("/cfg/", "");
      target[key] = { ...target[key], ...json };
      return target[key];
    }
  };
}

// -----------------------------------------------------------------------------
// What is synchronized
// -----------------------------------------------------------------------------

test("only behaviour settings are synchronized, never identity, network, Bluetooth, PIN or the voice assistant", () => {
  const all = extractSettings(cfgAll(), ["button", "display", "haptic", "sound", "power_saving", "localization", "voice", "software_update"]);
  assert.deepEqual(Object.keys(all).sort(), ["button", "display", "haptic", "localization", "power_saving", "software_update", "sound", "voice"]);
  assert.deepEqual(all.voice, { microphone: true }, "the voice assistant entity is device specific");
  assert.equal(all.button.features, undefined, "capabilities are not settings");
  const flat = JSON.stringify(all);
  for (const forbidden of ["Living room", "ssid", "has_admin_pin", "hass.main.assist"]) assert.equal(flat.includes(forbidden), false, forbidden);
});

test("defaults cover backlight, display, haptics, sound and power saving; unknown categories are ignored", () => {
  assert.deepEqual(normalizeSettingsCategories(undefined), ["button", "display", "haptic", "sound", "power_saving"]);
  assert.deepEqual(normalizeSettingsCategories(["sound", "network", "device", "button"]), ["button", "sound"]);
  assert.deepEqual(Object.keys(extractSettings(cfgAll(), undefined)), ["button", "display", "haptic", "sound", "power_saving"]);
});

test("values outside the Core API's ranges are never carried over", () => {
  const settings = extractSettings(cfgAll({ display: { brightness: 140, auto_brightness: "yes" }, power_saving: { wakeup_sensitivity: 9, display_off_sec: 20, standby_sec: -1 } }), ["display", "power_saving"]);
  assert.equal(settings.display, undefined);
  assert.deepEqual(settings.power_saving, { display_off_sec: 20 });
});

test("the settings section is optional and validated in the configuration", () => {
  const base = { role: "master", node_id: "m", node_name: "M", agent_token: "a".repeat(40), remote: { host: "127.0.0.1", api_key: "k".repeat(20) }, peers: [] };
  const plain = normalizeAndValidateConfig({ ...base, sync: {} });
  assert.equal(plain.config.sync.sections.includes("settings"), false, "off unless enabled");
  const enabled = normalizeAndValidateConfig({ ...base, sync: { sections: ["entities", "settings"], settings_categories: ["sound", "bogus"] } });
  assert.ok(enabled.config.sync.sections.includes("settings"));
  assert.deepEqual(enabled.config.sync.settings_categories, ["sound"]);
});

// -----------------------------------------------------------------------------
// Applying on a Satellite
// -----------------------------------------------------------------------------

test("only differing values are written, per category, and the result is what the remote now holds", async () => {
  const target = cfgAll({ button: { brightness: 40, auto_brightness: false, features: ["static_color"] }, sound: { enabled: false, volume: 30 } });
  const core = fakeCore(target);
  const report = createApplyReport("op");
  const wanted = extractSettings(cfgAll({ sound: { enabled: true, volume: 30 }, button: { brightness: 80, auto_brightness: false, features: ["static_color"], static_color: { rgb: [0, 0, 255] } } }), ["button", "sound", "haptic"]);
  const applied = await applyDeviceSettings(core, wanted, report);
  assert.deepEqual(core.patches, [
    { method: "PATCH", path: "/cfg/button", json: { brightness: 80, static_color: { rgb: [0, 0, 255] } } },
    { method: "PATCH", path: "/cfg/sound", json: { enabled: true } }
  ]);
  assert.deepEqual(applied.sound, { enabled: true, volume: 30 });
  assert.equal(report.counts.settings_updated, 2);
  assert.equal(report.counts.settings_unchanged, 1);
  assert.deepEqual(report.errors, []);
});

test("a Remote without colour backlight keeps its own backlight colour (Remote 3 → Remote Two)", async () => {
  const target = cfgAll({ button: { brightness: 40, auto_brightness: false, features: [] } });
  const core = fakeCore(target);
  const adjustments = [];
  await applyDeviceSettings(core, { button: { brightness: 60, static_color: { rgb: [1, 2, 3] } } }, createApplyReport("op"), { adjustments });
  assert.deepEqual(core.patches, [{ method: "PATCH", path: "/cfg/button", json: { brightness: 60 } }]);
  assert.match(adjustments[0], /static button colour skipped/);
});

test("a category or field the target remote does not have is skipped and reported", async () => {
  const target = cfgAll();
  delete target.haptic;
  target.power_saving = { display_off_sec: 10, standby_sec: 60 };
  const core = fakeCore(target);
  const adjustments = [];
  await applyDeviceSettings(core, { haptic: { enabled: false }, power_saving: { wakeup_sensitivity: 1, display_off_sec: 30 } }, createApplyReport("op"), { adjustments });
  assert.deepEqual(core.patches, [{ method: "PATCH", path: "/cfg/power_saving", json: { display_off_sec: 30 } }]);
  assert.ok(adjustments.some((item) => /Haptic feedback is not available/.test(item)));
  assert.ok(adjustments.some((item) => /wakeup_sensitivity is not available/.test(item)));
});

test("a rejected category is retried field by field and never fails the synchronization", async () => {
  const target = cfgAll();
  const core = fakeCore(target);
  const original = core.json;
  core.json = async (method, p, options) => {
    if (p === "/cfg/power_saving" && "standby_sec" in options.json) throw new CoreApiError(400, method, p, { code: "BAD_REQUEST" });
    return original(method, p, options);
  };
  const report = createApplyReport("op");
  const applied = await applyDeviceSettings(core, { power_saving: { wakeup_sensitivity: 3, display_off_sec: 5, standby_sec: 900 } }, report);
  assert.deepEqual(applied.power_saving, { wakeup_sensitivity: 3, display_off_sec: 5, standby_sec: 180 });
  assert.equal(report.errors.length, 0);
  assert.ok(report.warnings.some((item) => /standby_sec/.test(item)));
});

test("a remote that cannot report its settings is left alone", async () => {
  const report = createApplyReport("op");
  const applied = await applyDeviceSettings({ getJson: async () => null, json: async () => assert.fail("no writes") }, { sound: { enabled: true } }, report);
  assert.deepEqual(applied, {});
  assert.ok(report.warnings[0].includes("not synchronized"));
});

test("the preview lists the device settings that will be applied", () => {
  const preview = buildApplyPreview({ source_node_id: "m", sections: ["settings"], data: { settings: { sound: { enabled: true }, display: { brightness: 3 } } } }, { sync: {} }, { get: () => null, items: () => ({}) });
  assert.deepEqual(preview.sections.settings.items.update, ["Sound effects", "Display brightness"]);
});

// -----------------------------------------------------------------------------
// Primary is master: local edits on a Satellite are restored
// -----------------------------------------------------------------------------

test("a setting changed on the Satellite is backed up and restored to the Primary's value", async () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-drift-"));
  const restored = [];
  const guard = new DriftGuard({
    getClient: () => null, getMappings: () => null, getSourceNode: () => "m", report: async () => true,
    restoreSettings: async (settings) => { restored.push(settings); },
    appliedSettings: { sound: { enabled: true, volume: 30 }, display: { brightness: 70, auto_brightness: false } },
    backupDir, reportDelayMs: 5
  });
  assert.equal(guard.note("configuration_change", { new_state: cfgAll({ sound: { enabled: false, volume: 30 } }) }), true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(restored, [{ sound: { enabled: true }, display: { auto_brightness: false } }], "only fields that differ are restored");
  const backup = JSON.parse(fs.readFileSync(path.join(backupDir, fs.readdirSync(backupDir)[0]), "utf8"));
  assert.equal(backup.kind, "settings");
  assert.ok(backup.detail.some((item) => item.field === "enabled" && item.current === false));
  guard.stop();
});

test("settings that match, unsynchronized categories and Remote Sync's own writes are not treated as edits", () => {
  const guard = new DriftGuard({
    getClient: () => null, getMappings: () => null, getSourceNode: () => "m", report: async () => true,
    restoreSettings: async () => assert.fail("nothing to restore"),
    appliedSettings: { sound: { enabled: false, volume: 30 } }
  });
  assert.equal(guard.note("configuration_change", { new_state: cfgAll() }), false, "unchanged");
  assert.equal(guard.note("configuration_change", { new_state: cfgAll({ haptic: { enabled: false }, network: { x: 1 } }) }), false, "not synchronized here");
  guard.beginApply();
  assert.equal(guard.note("configuration_change", { new_state: cfgAll({ sound: { enabled: true, volume: 30 } }) }), false, "own write");
  guard.endApply();
  guard.stop();
});

test("brightness managed by automatic brightness is not fought over", () => {
  const differences = settingsDifferences({ display: { brightness: 50, auto_brightness: true } }, { display: { brightness: 12, auto_brightness: true } });
  assert.deepEqual(differences, []);
  const manual = settingsDifferences({ display: { brightness: 50, auto_brightness: false } }, { display: { brightness: 12, auto_brightness: false } });
  assert.equal(manual.length, 1);
});

test("repeated local changes are restored at most once a minute", async () => {
  let restores = 0;
  const guard = new DriftGuard({
    getClient: () => null, getMappings: () => null, getSourceNode: () => "m", report: async () => true,
    restoreSettings: async () => { restores += 1; },
    appliedSettings: { sound: { enabled: true, volume: 30 } },
    backupDir: fs.mkdtempSync(path.join(os.tmpdir(), "settings-rate-")), reportDelayMs: 5, applyGraceMs: 0, settingsRestoreIntervalMs: 60_000
  });
  guard.note("configuration_change", { new_state: cfgAll() });
  await new Promise((resolve) => setTimeout(resolve, 30));
  guard.note("configuration_change", { new_state: cfgAll() });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(restores, 1);
  assert.ok(guard.settingsTimer, "the second restore waits");
  guard.stop();
});

// -----------------------------------------------------------------------------
// Event classification (shapes from the Core WebSocket API specification)
// -----------------------------------------------------------------------------

function watcherHandle(watcher, msg, msg_data) { watcher.handleEvent({ kind: "event", msg, msg_data }); }

test("a new or renamed device on the Primary counts as a configuration change; a device state change does not", () => {
  const events = [];
  const watcher = new CoreEventWatcher({}, async () => {}, { configurationDetailCallback: (name, data) => events.push(data.entity_id || name) });
  watcherHandle(watcher, "entity_change", { event_type: "NEW", entity_id: "hass.main.media_player.new", entity_type: "media_player", new_state: { name: { en: "New" } } });
  watcherHandle(watcher, "entity_change", { event_type: "CHANGE", entity_id: "hass.main.light.a", entity_type: "light", new_state: { name: { en: "Kitchen" } } });
  watcherHandle(watcher, "entity_change", { event_type: "CHANGE", entity_id: "hass.main.light.a", entity_type: "light", new_state: { attributes: { state: "ON" } } });
  watcherHandle(watcher, "entity_change", { event_type: "CHANGE", entity_id: "uc.main.activity", entity_type: "activity", new_state: { attributes: { state: "ON" } } });
  assert.deepEqual(events, ["hass.main.media_player.new", "hass.main.light.a"]);
  watcher.stop();
});

test("settings events count only when a synchronized setting changed", () => {
  const events = [];
  let fingerprint = null;
  const watcher = new CoreEventWatcher({}, async () => {}, {
    configurationDetailCallback: (name) => events.push(name),
    configurationFilter: (name, data) => {
      if (name !== "configuration_change") return true;
      const next = settingsFingerprint(extractSettings(data.new_state, ["sound"]));
      if (next === fingerprint) return false;
      fingerprint = next;
      return true;
    }
  });
  watcherHandle(watcher, "configuration_change", { new_state: cfgAll() });
  watcherHandle(watcher, "configuration_change", { new_state: cfgAll({ network: { changed: true } }) });
  watcherHandle(watcher, "configuration_change", { new_state: cfgAll({ sound: { enabled: true, volume: 30 } }) });
  assert.deepEqual(events, ["configuration_change", "configuration_change"]);
  watcher.stop();
});

test("without a filter, settings events never trigger a synchronization", () => {
  const events = [];
  const watcher = new CoreEventWatcher({}, async () => {}, { configurationDetailCallback: (name) => events.push(name) });
  watcherHandle(watcher, "configuration_change", { new_state: cfgAll() });
  assert.deepEqual(events, []);
  watcher.stop();
});

test("Core version and layouts are read in the exact shapes of the Core REST API specification", () => {
  const profile = hardwareFromResponses({
    version: { model: "UCR2", device_name: "Bedroom", api: "0.21.0" },
    buttonLayout: [
      { type: "MAIN", grid: { width: 3, height: 9 }, buttons: [{ button: "HOME", icon: "uc:home", name: { en: "Home" }, location: { x: 0, y: 0 } }, { button: "VOLUME_UP", icon: "uc:plus", name: { en: "Vol +" }, location: { x: 2, y: 3 } }] },
      { type: "TOP", grid: { width: 2, height: 1 }, buttons: [{ button: "POWER", icon: "uc:power", name: { en: "Power" }, location: { x: 0, y: 0 } }] }
    ],
    screenLayout: [{ grid: { default: { width: 4, height: 6 }, min: { width: 1, height: 1 }, max: { width: 4, height: 7 } } }]
  });
  assert.deepEqual(profile, { model: "UCR2", hardware_revision: null, buttons: ["HOME", "POWER", "VOLUME_UP"], grid: { width: 4, height: 7 } });
});
