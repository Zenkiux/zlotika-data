// Pepco (Shopify Hydrogen / React Router): any /city/<slug> page streams ALL ~1400 PL stores as GeoJSON.
import { get, toOSM, span, townOf } from './common.mjs';
import { decodeTurbo } from './turbo.mjs';
const D = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export async function pepco() {
  const html = await get('https://pepco.pl/city/pepco-bialystok');
  const chunk = html.match(/streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/)[1];
  const data = decodeTurbo(JSON.parse(JSON.parse(chunk)));
  const feats = data.loaderData['routes/city.$city'].stores.features;
  return feats.filter(f => f.properties.is_active && townOf(f.geometry.coordinates[1], f.geometry.coordinates[0])).map(f => {
    const p = f.properties, week = Array(7).fill(null);
    for (const r of p.opening_hours) for (const d of r.days) week[D.indexOf(d)] = r.closed ? null : span(r.from, r.to);
    const tradingSunday = week[6]; week[6] = null; // Sunday trading ban: listed Sunday hours apply to trading Sundays only
    return { chain: 'pepco', id: p.slm_id, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
      address: `${p.street} ${p.street_number}, ${p.zip} ${p.city}`, hours: toOSM(week), tradingSunday };
  });
}
