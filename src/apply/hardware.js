import { logger } from "../shared/logger.js";

const log = logger("hardware");

// -----------------------------------------------------------------------------
// Hardware profiles
// -----------------------------------------------------------------------------
//
// Remote Two and Remote 3 differ in physical buttons and in the screen grid available to UI pages. Nothing here is
// hard-coded: each Core reports its own layout (GET /cfg/device/button_layout and /cfg/device/screen_layout), the
// Primary ships its profile with every snapshot, and the Satellite adapts what it receives to its own hardware.
// When a layout cannot be read, nothing is removed — the Core's own validation stays the last line of defence.

function collectButtons(value, result = new Set(), depth = 0) {
  if (depth > 4 || value === null || value === undefined) return result;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) result.add(item.trim());
      else if (item && typeof item === "object") {
        const id = item.button ?? item.button_id ?? item.id ?? item.name;
        if (typeof id === "string" && id.trim()) result.add(id.trim());
        else collectButtons(item, result, depth + 1);
      }
    }
    return result;
  }
  if (typeof value === "object") {
    for (const key of ["buttons", "items", "layout", "button_layout", "physical_buttons"]) {
      if (value[key] !== undefined) return collectButtons(value[key], result, depth + 1);
    }
    // Object keyed by button id ({ "HOME": {...}, "BACK": {...} }).
    const keys = Object.keys(value).filter((key) => /^[A-Z0-9_]{2,}$/.test(key));
    for (const key of keys) result.add(key);
  }
  return result;
}

function gridSize(value) {
  const width = Number(value?.width ?? value?.columns ?? value?.cols);
  const height = Number(value?.height ?? value?.rows);
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 64 && height <= 64 ? { width, height } : null;
}

// Largest UI page grid this remote accepts. The Core answers `GET /cfg/device/screen_layout` with a list of
// `{ grid: { default, min, max } }`; with several layouts the smallest maximum is the safe one.
function findGrid(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  if (Array.isArray(value)) {
    const grids = value.map((item) => findGrid(item, depth + 1)).filter(Boolean);
    if (!grids.length) return null;
    return { width: Math.min(...grids.map((grid) => grid.width)), height: Math.min(...grids.map((grid) => grid.height)) };
  }
  if (value.grid && typeof value.grid === "object" && (value.grid.max || value.grid.default)) return gridSize(value.grid.max) || gridSize(value.grid.default);
  if (value.max && typeof value.max === "object") return gridSize(value.max);
  const direct = gridSize(value);
  if (direct) return direct;
  for (const key of ["grid", "screen", "layout", "screen_layout", "size"]) {
    const found = findGrid(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function hardwareFromResponses({ version = null, buttonLayout = null, screenLayout = null } = {}) {
  const buttons = [...collectButtons(buttonLayout)].sort();
  return {
    model: typeof version?.model === "string" ? version.model : (typeof version?.device_model === "string" ? version.device_model : null),
    hardware_revision: version?.hw ?? version?.hardware_revision ?? null,
    buttons: buttons.length ? buttons : null,
    grid: findGrid(screenLayout)
  };
}

export async function readHardwareProfile(client) {
  const optional = { optionalStatuses: [400, 404, 405, 501], wakeOnUnavailable: false };
  const read = async (path) => { try { return await client.getJson(path, optional); } catch (error) { log.debug(`Could not read ${path}: ${error.message}`); return null; } };
  const [version, buttonLayout, screenLayout] = await Promise.all([
    typeof client.versionInfo === "function" ? client.versionInfo().catch(() => null) : read("/pub/version"),
    read("/cfg/device/button_layout"),
    read("/cfg/device/screen_layout")
  ]);
  return hardwareFromResponses({ version, buttonLayout, screenLayout });
}

export function hardwareLabel(profile) {
  return profile?.model || "unknown model";
}

// -----------------------------------------------------------------------------
// Adaptation
// -----------------------------------------------------------------------------

export class HardwareAdapter {
  constructor(source, target) {
    this.source = source || null;
    this.target = target || null;
    this.adjustments = [];
  }

  get differs() {
    if (!this.source || !this.target) return false;
    return this.source.model !== this.target.model
      || JSON.stringify(this.source.buttons) !== JSON.stringify(this.target.buttons)
      || JSON.stringify(this.source.grid) !== JSON.stringify(this.target.grid);
  }

  #note(context, message) { this.adjustments.push(`${context}: ${message}`); }

  // Button mappings ([{ button, short_press, long_press, ... }]): entries for buttons the target lacks are dropped.
  buttons(mapping, context) {
    const available = this.target?.buttons;
    if (!Array.isArray(mapping) || !available) return mapping;
    const known = new Set(available);
    const kept = [];
    const dropped = [];
    for (const entry of mapping) {
      const button = typeof entry?.button === "string" ? entry.button : null;
      if (button && !known.has(button)) dropped.push(button);
      else kept.push(entry);
    }
    // Not a single mapped button recognized: the layout answer was most likely not understood. Keep everything.
    if (dropped.length && !kept.some((entry) => typeof entry?.button === "string")) {
      log.debug(`${context}: none of the mapped buttons appear in this remote's layout; leaving the mapping unchanged`);
      return mapping;
    }
    if (dropped.length) this.#note(context, `skipped mapping(s) for button(s) this remote does not have: ${[...new Set(dropped)].join(", ")}`);
    return kept;
  }

  // UI page ({ grid: {width,height}, items: [{ location: {x,y}, size: {width,height} }] }): a grid larger than the
  // target screen is reduced, and items that would fall outside are dropped.
  page(page, context) {
    const limit = this.target?.grid;
    if (!limit || !page || typeof page !== "object") return page;
    const grid = page.grid && typeof page.grid === "object" ? page.grid : null;
    const width = Number(grid?.width);
    const height = Number(grid?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || (width <= limit.width && height <= limit.height)) return page;
    const next = { ...page, grid: { ...grid, width: Math.min(width, limit.width), height: Math.min(height, limit.height) } };
    const items = Array.isArray(page.items) ? page.items : [];
    const kept = items.filter((item) => {
      const x = Number(item?.location?.x ?? 0);
      const y = Number(item?.location?.y ?? 0);
      const w = Number(item?.size?.width ?? 1);
      const h = Number(item?.size?.height ?? 1);
      return x + w <= next.grid.width && y + h <= next.grid.height;
    });
    if (Array.isArray(page.items)) next.items = kept;
    const name = typeof page.name === "string" ? page.name : (page.name?.en || page.page_id || "page");
    this.#note(context, `page "${name}" reduced from ${width}×${height} to ${next.grid.width}×${next.grid.height}${items.length - kept.length ? `, ${items.length - kept.length} item(s) outside the smaller screen skipped` : ""}`);
    return next;
  }

  ui(ui, context) {
    if (!ui || typeof ui !== "object" || !Array.isArray(ui.pages)) return ui;
    return { ...ui, pages: ui.pages.map((page) => this.page(page, context)) };
  }

  // Proxy remote entities carry their own button mapping and pages in their options.
  remoteOptions(options, context) {
    if (!options || typeof options !== "object") return options;
    const next = { ...options };
    if (Array.isArray(options.button_mapping)) next.button_mapping = this.buttons(options.button_mapping, context);
    if (options.user_interface) next.user_interface = this.ui(options.user_interface, context);
    return next;
  }
}
