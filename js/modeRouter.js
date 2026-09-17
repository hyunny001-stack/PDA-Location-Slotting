export function selectPdaModule(search) {
  const params = new URLSearchParams(search);
  if (params.get('mode') === 'location-first') {
    return 'pda-location-first.js';
  }
  return 'pda-item-first.js';
}
