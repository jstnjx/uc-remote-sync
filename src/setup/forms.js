// -----------------------------------------------------------------------------
// Setup form fields
//
// Field shapes follow the Integration-API `Setting` schema: number, text, textarea, password, checkbox, dropdown
// and label. Titles and texts accept either a plain string (English) or a language object such as
// { en: "...", de: "..." }; the Integration API layer narrows them to the language requested by the Remote.
// -----------------------------------------------------------------------------

export function languageText(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return { en: String(value ?? "") };
}

function setting(id, title, field, description) {
  const item = { id, label: languageText(title), field };
  if (description) item.description = languageText(description);
  return item;
}

export function label(id, title, value) {
  return setting(id, title, { label: { value: languageText(value) } });
}

export function text(id, title, value = "", description = undefined, { regex = undefined } = {}) {
  const field = { text: { value: String(value ?? "") } };
  if (regex) field.text.regex = regex;
  return setting(id, title, field, description);
}

export function textarea(id, title, value = "", description = undefined) {
  return setting(id, title, { textarea: { value: String(value ?? "") } }, description);
}

export function password(id, title, description = undefined, { regex = undefined } = {}) {
  const field = { password: { value: "" } };
  if (regex) field.password.regex = regex;
  return setting(id, title, field, description);
}

export function checkbox(id, title, value = false, description = undefined) {
  return setting(id, title, { checkbox: { value: Boolean(value) } }, description);
}

export function number(id, title, value, { min, max, steps, decimals = 0, unit } = {}, description = undefined) {
  const field = { number: { value: Number(value) } };
  if (min !== undefined) field.number.min = min;
  if (max !== undefined) field.number.max = max;
  if (steps !== undefined) field.number.steps = steps;
  if (decimals !== undefined) field.number.decimals = decimals;
  if (unit !== undefined) field.number.unit = languageText(unit);
  return setting(id, title, field, description);
}

export function dropdown(id, title, value, items) {
  return setting(id, title, {
    dropdown: {
      value,
      items: items.map(([itemId, itemLabel]) => ({ id: itemId, label: languageText(itemLabel) }))
    }
  });
}

// Setup input values arrive as strings. Checkboxes report "true" / "false"; older dropdown-based forms used
// "yes" / "no", which is still accepted for reconfiguration drafts and tests.
export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}
