// -----------------------------------------------------------------------------
// Setup form fields
// -----------------------------------------------------------------------------

export function label(id, title, value) {
  return { id, label: { en: title }, field: { label: { value: { en: String(value) } } } };
}

export function text(id, title, value = "", description = undefined) {
  const item = { id, label: { en: title }, field: { text: { value: String(value ?? "") } } };
  if (description) item.description = { en: description };
  return item;
}

export function dropdown(id, title, value, items) {
  return {
    id,
    label: { en: title },
    field: {
      dropdown: {
        value,
        items: items.map(([itemId, itemLabel]) => ({ id: itemId, label: { en: itemLabel } }))
      }
    }
  };
}
