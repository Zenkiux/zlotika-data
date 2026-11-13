// Aldi: stores sitemap -> store detail pages; each embeds Uberall JSON in "apiData" (Magnolia SSR).
import { get, toOSM, span, townOf } from './common.mjs';
export async function aldi() {
  const sm = await get('https://www.aldi.pl/sitemaps/.aldi-nord-sitemap-stores.xml');
  const urls = [...sm.matchAll(/<loc>(https:\/\/www\.aldi\.pl\/wyszukiwarka-sklepu\/(?:suwalki|augustow|sejny|bialystok)\/[^<]+)<\/loc>/g)].map(m => m[1]);
  const out = [];
  for (const u of urls) {
    const html = await get(u);
    const raw = html.match(/"apiData":("(?:[^"\\]|\\.)*")/);
    if (!raw) continue;
    const s = JSON.parse(JSON.parse(raw[1])).find(x => x[0] === 'STORE_DETAIL_UBERALL_GET')?.[1].res.storeDetail;
    if (!s || !townOf(s.lat, s.lng)) continue;
    const week = Array(7).fill(null);
    for (const d of s.openingHours) if (!d.closed)
      week[d.dayOfWeek - 1] = [span(d.from1, d.to1), span(d.from2, d.to2)].filter(Boolean).join(',');
    // specialOpeningHours: [{date:'2026-12-24', closed:true} | {date, from1, to1}] -> OSM "2026 Dec 24 off"
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const today = new Date().toISOString().slice(0, 10);
    const special = s.specialOpeningHours.filter(x => x.date >= today).map(x => {
      const [y, m, d] = x.date.split('-'); return `${y} ${M[m - 1]} ${d} ${x.closed ? 'off' : span(x.from1, x.to1)}`;
    });
    out.push({ chain: 'aldi', id: s.identifier, lat: s.lat, lon: s.lng,
      address: `${s.streetAndNumber}, ${s.zip} ${s.city}`, hours: toOSM(week), special });
  }
  return out;
}
