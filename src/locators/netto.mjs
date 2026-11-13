// Netto: /wyszukiwarka-sklepow/ is Next.js RSC; the flight data embeds all ~700 stores with the next 7 days' hours.
import { get, toOSM, townOf, regularise } from './common.mjs';
const hm = s => s.slice(11, 16);
function objAt(s, i) { // bracket-match one JSON object starting at i
  let d = 0, q = false;
  for (let j = i; j < s.length; j++) { const c = s[j];
    if (q) { if (c === '\\') j++; else if (c === '"') q = false; continue; }
    if (c === '"') q = true; else if (c === '{') d++; else if (c === '}' && --d === 0) return s.slice(i, j + 1); }
}
export async function netto() {
  const html = await get('https://netto.pl/wyszukiwarka-sklepow/');
  const txt = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map(m => JSON.parse(m[1])).join('');
  const stores = new Map();
  for (let i = txt.indexOf('{"id":"'); i >= 0; i = txt.indexOf('{"id":"', i + 1)) {
    try { const o = JSON.parse(objAt(txt, i)); if (o.brand === 'netto' && o.hours) stores.set(o.id, o); } catch {}
  }
  return [...stores.values()].filter(s => townOf(s.coordinates[1], s.coordinates[0])).map(s => ({
    chain: 'netto', id: s.sapSiteId, lat: s.coordinates[1], lon: s.coordinates[0],
    address: `${s.address.street}, ${s.address.zip} ${s.address.city}`,
    hours: toOSM(regularise(Object.fromEntries(s.hours.filter(h => h.type === 'store')
      .map(h => [h.date, h.closed ? null : `${hm(h.open)}-${hm(h.close)}`])))),
  }));
}
