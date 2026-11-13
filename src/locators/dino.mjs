// Dino: /map page's Nuxt payload holds all ~3300 stores (GeoJSON) with THIS WEEK's hours ("nieczynne" = closed).
import { get, toOSM, townOf, regularise } from './common.mjs';
import { unflatten } from './unflat.mjs';
const D = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export async function dino() {
  const html = await get('https://marketdino.pl/map');
  const src = html.match(/id="__NUXT_DATA__"[^>]*data-src="([^"]+)"/)[1];
  const root = unflatten(await get(new URL(src, 'https://marketdino.pl').href, true));
  // dates of the week the payload was rendered in (Mon..Sun), to undo holiday-week distortions
  const t = new Date(root.prerenderedAt), mon = new Date(+t - ((t.getUTCDay() + 6) % 7) * 864e5);
  const dates = D.map((_, i) => new Date(+mon + i * 864e5).toISOString().slice(0, 10));
  return root.data['map-data'].features.filter(f => townOf(f.geometry.coordinates[1], f.geometry.coordinates[0])).map(f => {
    const p = f.properties;
    const byDate = Object.fromEntries(D.map((d, i) => {
      const v = p[`${d}Hours`]; return [dates[i], !v || v === 'nieczynne' ? null : v.replace(/\b(\d):/g, '0$1:')];
    }));
    return { chain: 'dino', id: p.name, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
      address: p.address, hours: D.every(d => p[`${d}Hours`] == null) ? null : toOSM(regularise(byDate)) };
  });
}
