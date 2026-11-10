import { canonicalJson, sha256Bytes } from "../shared/util.js";

// -----------------------------------------------------------------------------
// Device settings that can be synchronized
// -----------------------------------------------------------------------------
//
// Field names and ranges follow the Core REST API (`GET /cfg`, `PATCH /cfg/<category>`). Only settings that describe how
// a remote should behave are listed. Settings that identify or connect one particular device — its name, Wi-Fi,
// network, Bluetooth peripherals, the admin PIN, feature flags and the voice assistant entity — are never synchronized.

const int = (min, max) => (value) => Number.isInteger(value) && value >= min && value <= max;
const bool = (value) => typeof value === "boolean";
const string = (value) => typeof value === "string" && value.length > 0 && value.length <= 64;
const oneOf = (...values) => (value) => values.includes(value);
const timeOfDay = (value) => typeof value === "string" && /^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/.test(value);
const staticColor = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Array.isArray(value.rgb) && value.rgb.length === 3 && value.rgb.every(int(0, 255))
  && (value.zones === undefined || (Array.isArray(value.zones) && value.zones.length <= 32 && value.zones.every(string)));

export const SETTINGS_CATEGORIES = Object.freeze({
  button: {
    key: "button", path: "/cfg/button", label: "Button backlight",
    fields: { brightness: int(0, 100), auto_brightness: bool, static_color: staticColor }
  },
  display: {
    key: "display", path: "/cfg/display", label: "Display brightness",
    fields: { brightness: int(0, 100), auto_brightness: bool }
  },
  haptic: { key: "haptic", path: "/cfg/haptic", label: "Haptic feedback", fields: { enabled: bool } },
  sound: { key: "sound", path: "/cfg/sound", label: "Sound effects", fields: { enabled: bool, volume: int(0, 100) } },
  power_saving: {
    key: "power_saving", path: "/cfg/power_saving", label: "Power saving and standby",
    fields: { wakeup_sensitivity: int(0, 3), display_off_sec: int(0, 60), standby_sec: int(0, 10_800) }
  },
  localization: {
    key: "localization", path: "/cfg/localization", label: "Language, region and time",
    fields: { language_code: string, country_code: string, time_zone: string, time_format_24h: bool, measurement_unit: oneOf("METRIC", "US", "UK") }
  },
  voice: { key: "voice", path: "/cfg/voice_control", label: "Microphone", fields: { microphone: bool } },
  software_update: {
    key: "software_update", path: "/cfg/software_update", label: "Software update schedule",
    fields: { check_for_updates: bool, auto_update: bool, ota_window_start: timeOfDay, ota_window_end: timeOfDay }
  }
});

export const SETTINGS_CATEGORY_IDS = Object.freeze(Object.keys(SETTINGS_CATEGORIES));
export const DEFAULT_SETTINGS_CATEGORIES = Object.freeze(["button", "display", "haptic", "sound", "power_saving"]);

export function normalizeSettingsCategories(value) {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS_CATEGORIES];
  return SETTINGS_CATEGORY_IDS.filter((id) => value.map(String).includes(id));
}

// The synchronizable part of a `GET /cfg` answer (or a `configuration_change` event's new_state): only listed
// categories and fields, and only values the Core API allows.
export function extractSettings(cfgAll, categories) {
  const result = {};
  if (!cfgAll || typeof cfgAll !== "object") return result;
  for (const id of normalizeSettingsCategories(categories)) {
    const category = SETTINGS_CATEGORIES[id];
    const current = cfgAll[category.key];
    if (!current || typeof current !== "object" || Array.isArray(current)) continue;
    const values = {};
    for (const [field, valid] of Object.entries(category.fields)) {
      if (current[field] !== undefined && valid(current[field])) values[field] = structuredClone(current[field]);
    }
    if (Object.keys(values).length) result[id] = values;
  }
  return result;
}

// Deep equality for setting values (objects compared independent of key order).
export function sameSettingValue(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return canonicalJson(a).equals(canonicalJson(b));
}

export function settingsFingerprint(settings) {
  return sha256Bytes(canonicalJson(settings || {}));
}

// Fields that differ between what was applied and what a remote now reports. Brightness values are ignored while the
// matching automatic brightness is on: the remote may manage them itself.
export function settingsDifferences(applied, current) {
  const differences = [];
  for (const [id, values] of Object.entries(applied || {})) {
    const now = current?.[id];
    if (!now) continue;
    for (const [field, value] of Object.entries(values)) {
      if (field === "brightness" && values.auto_brightness === true) continue;
      if (now[field] === undefined) continue;
      if (!sameSettingValue(now[field], value)) differences.push({ category: id, field, applied: value, current: now[field] });
    }
  }
  return differences;
}
