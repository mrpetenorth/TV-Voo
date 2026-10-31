// Lightweight name -> tvg-id mappings and normalizer

export function normalizeChannelName(raw: string): string {
  if (!raw) return '';
  const sourceName = raw.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim();
  // Keep Disney Channel distinct from Disney XD; do not collapse both to "disney".
  if (/^disney\s+channel(?:\s+hd)?$/.test(sourceName)) return 'disney channel';
  if (/^disney\s*\+(?:\s*xd)?(?:\s+hd)?$/.test(sourceName)) return 'disney xd';
  if (/^sky sports\s*(?:\+|plus)$/.test(sourceName)) return 'sky sports arena';
  const normalized = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Keep ITV+1 distinct from ITV1 before punctuation is normalised.
    .replace(/\+\s*1\b/g, ' plusone ')
    .replace(/(?:'|’)/g, '')
    // Drop common XMLTV region suffixes.
    .replace(/\.(uk|gb|co\.uk)$/i, '')
    .replace(/\s*(\.[a-z0-9]{1,3})+$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(hd|uhd|4k|tv|channel|plus)\b/g, ' ')
    .replace(/\bsports\b/g, 'sport')
    .replace(/\s+/g, ' ')
    .trim();

  // Exact, conservative aliases for common UK XMLTV display-name variants.
  return normalized
    .replace(/^itv 1$/, 'itv1')
    .replace(/^itv be$/, 'itvbe')
    .replace(/^itv ([234])$/, 'itv$1')
    .replace(/^film 4$/, 'film4')
    .replace(/^u (dave|drama|gold|yesterday|watch)$/, '$1')
    .replace(/^u w$/, 'watch')
    .replace(/^boxnation$/, 'box nation')
    .replace(/^wwe network$/, 'wwe')
    .replace(/^investigation discovery$/, 'discovery id')
    .replace(/^rte ?1$/, 'rte one')
    .replace(/^rte1$/, 'rte one')
    .replace(/^rte ?2$/, 'rte two')
    .replace(/^tnt sport espn$/, 'espn');
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
