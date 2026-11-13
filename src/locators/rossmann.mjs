// Rossmann: /drogerie is Next.js SSR; __NEXT_DATA__ holds every shop (~2000) with weekly hours. One request.
import { get, toOSM, span, townOf } from './common.mjs';
const D = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export async function rossmann() {
  const html = await get('https://www.rossmann.pl/drogerie');
  const next = JSON.parse(html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)[1]);
  let shops;
  (function walk(o) {
    if (shops || !o || typeof o !== 'object') return;
    if (Array.isArray(o) && o[0]?.openHours && o[0]?.shopLocation) { shops = o; return; }
    for (const k in o) walk(o[k]);
  })(next.props.pageProps.initialReduxState.shops);
  return shops.filter(s => townOf(s.shopLocation.latitude, s.shopLocation.longitude)).map(s => ({
    chain: 'rossmann', id: s.shopNumber, lat: s.shopLocation.latitude, lon: s.shopLocation.longitude,
    address: `${s.address.street}, ${s.address.postCode} ${s.address.city}`,
    hours: toOSM(D.map(d => span(s.openHours[`${d}OpenFrom`], s.openHours[`${d}OpenTo`]))),
  }));
}
