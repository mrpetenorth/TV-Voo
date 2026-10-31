// Lightweight name -> tvg-id mappings and normalizer

export function normalizeChannelName(raw: string): string {
  if (!raw) return '';
  const normalized = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Keep +1 channels distinct from their parent channel (ITV1 vs ITV+1).
    .replace(/\+\s*1\b/g, ' plusone ')
    // Strip common XMLTV region suffixes before punctuation is normalised.
    .replace(/\.(uk|gb|co\.uk)$/i, '')
    .replace(/(?:'|’)/g, '')
    .replace(/\s*(\.[a-z0-9]{1,3})+$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(hd|uhd|4k|tv|channel|plus)\b/g, ' ')
    .replace(/\bsports\b/g, 'sport')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized
    .replace(/^itv 1$/, 'itv1')
    .replace(/^itv be$/, 'itvbe')
    .replace(/^itv ([234])$/, 'itv$1')
    .replace(/^film 4$/, 'film4')
    .replace(/^u (dave|drama|gold|yesterday|watch)$/, '$1')
    .replace(/^rte ?1$/, 'rte one')
    .replace(/^rte ?2$/, 'rte two')
    .replace(/^tnt sport espn$/, 'espn')
    .replace(/^thats tv gold$/, 'thats gold');
}

// Base map: put hand-curated tricky cases here (can be extended at runtime)
const STATIC_MAP: Record<string, string> = {
  'sky arte 1': 'SkyArte.it',
  'sky arte 2': 'SkyArte.it',
  'real time 1': 'RealTime.it',
  'real time 2': 'RealTime.it',
};

export function buildNameToIdMap(ext?: Record<string, string>): Record<string, string> {
  return { ...STATIC_MAP, ...(ext || {}) };
}
