// Match locator stores to OSM stores of the same chain: greedy 1:1 by distance, <=150 m;
// fallback <=400 m when normalised street name + house number also agree.
import { km } from './common.mjs';
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
  .replace(/\b(ul|ulica|al|aleja|aleje|os|osiedle|pl|plac|gen|ks|im)\b\.?/g, ' ').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const key = a => { const s = norm(String(a).split(',')[0]); const n = s.match(/\d+[a-z]?/)?.[0]; return [s.replace(/\d.*$/, '').trim().split(' ').pop(), n]; };
export function match(osm, loc) {
  const pairs = [];
  for (const o of osm) for (const l of loc) if (o.chain === l.chain) {
    const m = km(o.lat, o.lon, l.lat, l.lon) * 1000;
    const [os, on] = key(o.address), [ls, ln] = key(l.address);
    if (m <= 150 || (m <= 400 && os && os === ls && on === ln)) pairs.push([m, o, l]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const used = new Set(), res = new Map();
  for (const [m, o, l] of pairs) if (!res.has(o.id) && !used.has(l)) { used.add(l); res.set(o.id, { ...l, metres: Math.round(m) }); }
  return res; // osm id -> locator record
}
