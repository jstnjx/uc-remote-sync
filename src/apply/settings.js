import { CoreApiError } from "../core/client.js";
import { incrementReport } from "../shared/models.js";
import { logger } from "../shared/logger.js";
import { SETTINGS_CATEGORIES, extractSettings, normalizeSettingsCategories, sameSettingValue } from "../settings/catalog.js";

const log = logger("settings-applier");

// Static button colours exist only on hardware with RGB backlight zones; the Core lists such capabilities in
// `button.features`, and reports `static_color` only where it is supported.
function supportsStaticColor(current) {
  if (current && Object.prototype.hasOwnProperty.call(current, "static_color")) return true;
  return Array.isArray(current?.features) && current.features.some((item) => /colou?r/i.test(String(item)));
}

// -----------------------------------------------------------------------------
// Device settings applier
// -----------------------------------------------------------------------------
//
// Applies the Primary's device settings to this remote, one category at a time:
// - only categories and fields this remote reports itself are written (Remote Two and Remote 3 differ),
// - only values that actually differ are sent,
// - a category the Core rejects as a whole is retried field by field, so one unsupported value never blocks the rest,
// - nothing here can fail a synchronization: problems are reported as warnings.
// Returns the values this remote holds afterwards for every synchronized field (used to detect later local edits).

export async function applyDeviceSettings(client, settings, report, { categories = null, adjustments = [] } = {}) {
  const wanted = settings && typeof settings === "object" ? settings : {};
  const ids = normalizeSettingsCategories(categories || Object.keys(wanted)).filter((id) => wanted[id]);
  if (!ids.length) return {};
  let target;
  try { target = await client.getJson("/cfg", { optionalStatuses: [404, 405] }); }
  catch (error) { report.warnings.push(`Device settings were not synchronized: ${error.message}`); return {}; }
  if (!target || typeof target !== "object") { report.warnings.push("Device settings were not synchronized: this remote does not report its settings"); return {}; }

  const applied = {};
  for (const id of ids) {
    const category = SETTINGS_CATEGORIES[id];
    const current = target[category.key];
    if (!current || typeof current !== "object") {
      adjustments.push(`settings: ${category.label} is not available on this remote and was skipped`);
      continue;
    }
    const payload = {};
    for (const [field, value] of Object.entries(wanted[id])) {
      if (!category.fields[field] || !category.fields[field](value)) continue;
      if (field === "static_color" && !supportsStaticColor(current)) {
        adjustments.push("settings: static button colour skipped (this remote has no colour backlight)");
        continue;
      }
      if (field !== "static_color" && current[field] === undefined) {
        adjustments.push(`settings: ${category.label} → ${field} is not available on this remote and was skipped`);
        continue;
      }
      if (!sameSettingValue(current[field], value)) payload[field] = value;
    }
    const written = await patchCategory(client, category, payload, report);
    applied[id] = extractSettings({ [category.key]: { ...current, ...written } }, [id])[id] || {};
    if (Object.keys(written).length) incrementReport(report, "settings_updated");
    else incrementReport(report, "settings_unchanged");
  }
  return applied;
}

async function patchCategory(client, category, payload, report) {
  if (!Object.keys(payload).length) return {};
  try {
    await client.json("PATCH", category.path, { json: payload, expected: [200] });
    log.info(`Applied ${category.label}: ${Object.keys(payload).join(", ")}`);
    return payload;
  } catch (error) {
    if (!(error instanceof CoreApiError) || ![400, 422].includes(error.status) || Object.keys(payload).length === 1) {
      report.warnings.push(`Could not apply ${category.label} (${Object.keys(payload).join(", ")}): ${error.message}`);
      return {};
    }
  }
  // The Core rejected the combination; apply what it accepts field by field.
  const written = {};
  for (const [field, value] of Object.entries(payload)) {
    try {
      await client.json("PATCH", category.path, { json: { [field]: value }, expected: [200] });
      written[field] = value;
    } catch (error) {
      report.warnings.push(`Could not apply ${category.label} → ${field}: ${error.message}`);
    }
  }
  return written;
}
