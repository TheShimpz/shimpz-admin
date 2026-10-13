// The one way Admin fills a copy template: each `{name}` placeholder with that own value, in one pass, so a value is
// inserted as written and never read for placeholders or replacement patterns; a placeholder without a value stays.
export function fill(template, values) {
  return template.replace(/\{([a-zA-Z]+)\}/g, (placeholder, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : placeholder
  ));
}
