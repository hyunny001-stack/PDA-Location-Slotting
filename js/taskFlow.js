export function parseItemCode(raw) {
  const text = String(raw ?? '');
  const first = text[0] ?? '';
  const normalized = text.replace(/\x1d/g, ' ').trim();

  if (first === '1') return normalized.substring(0, 15);

  if (first === '0') {
    const match = normalized.slice(16).match(/91(1\d{2,8}-\d{2,8}[A-Z]{2})/);
    if (match?.[1]?.length === 15) return match[1];
  }

  if (text.includes('\x1d')) {
    for (const segment of normalized.split(' ').reverse()) {
      const clean = segment.trim();
      const dash = clean.indexOf('-');
      if (dash === -1) continue;
      const index = clean.lastIndexOf('91', dash);
      if (index !== -1) return clean.substring(index + 2);
    }
  }

  const plusIndex = normalized.indexOf('+');
  if (plusIndex !== -1) return normalized.substring(0, plusIndex);

  return normalized.split(' ').filter(Boolean)[0] ?? normalized;
}

export function normalizeLocation(value) {
  return String(value ?? '').trim().toLocaleUpperCase('en-US');
}

export function isExpectedLocation(scanned, expected) {
  return normalizeLocation(scanned) === normalizeLocation(expected);
}

export function isExpectedItem(scanned, expected) {
  return parseItemCode(scanned).toLocaleUpperCase('en-US') ===
    String(expected ?? '').trim().toLocaleUpperCase('en-US');
}

export function pendingTargets(mapping, completedLocations) {
  const completed = new Set(
    [...completedLocations].map(location => normalizeLocation(location)),
  );
  return (mapping?.to_locations ?? [])
    .map((location, index) => ({
      location,
      quantity: (mapping?.to_quantities ?? [])[index] ?? 0,
    }))
    .filter(target => !completed.has(normalizeLocation(target.location)));
}
