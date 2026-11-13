// Lidl: public SEO pages (Nuxt). Country page -> build id + town links; each town page has a _payload.json.
import { get, toOSM, span, townOf } from './common.mjs';
import { unflatten } from './unflat.mjs';
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export async function lidl() {
  const html = await get('https://www.lidl.pl/s/pl-PL/sklepy/');
  const bid = html.match(/_payload\.json\?_b=([\w-]+)/)[1];
  const paths = new Set([...html.matchAll(/href="(\/s\/pl-PL\/sklepy\/(?:suwalki|augustow|sejny|bialystok)\/[^"]*)"/g)].map(m => m[1]));
  const stores = new Map();
  for (const p of paths) {
    const data = unflatten(await get(`https://www.lidl.pl${p}_payload.json?_b=${bid}`, true));
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== 'object' || seen.has(o)) return; seen.add(o);
      if (o.objectNumber && o.generalOpeningHours) stores.set(o.objectNumber, o);
      for (const k in o) walk(o[k]);
    })(data);
  }
  return [...stores.values()].filter(s => townOf(s.address.latitude, s.address.longitude)).map(s => {
    const reg = s.generalOpeningHours.regular;
    const week = DAYS.map(d => (reg[d]?.length ? reg[d].map(r => span(r.from, r.to)).join(',') : null));
    return {
      chain: 'lidl', id: s.objectNumber, lat: s.address.latitude, lon: s.address.longitude,
      address: [s.address.streetName, s.address.streetNumber].filter(Boolean).join(' ') + `, ${s.address.zip} ${s.address.city}`,
      hours: toOSM(week),
      special: s.generalOpeningHours.special, // dated exceptions, if any
    };
  });
}
