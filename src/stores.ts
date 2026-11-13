// Shop and fuel-station locations with opening hours, from OpenStreetMap (ODbL).
// One Overpass query per run; the app shows "© OpenStreetMap contributors".
import { UA } from './http.ts';

export type Store = {
  id: string; // osm:n123 / osm:w123
  chain: string; // app chain id, or 'fuel'
  brand: string;
  name?: string;
  town: string; // nearest destination id in the app
  lat: number;
  lon: number;
  address?: string;
  hours?: string; // OSM opening_hours syntax
  hoursFrom?: 'chain' | 'osm'; // the chain's own store locator, or OpenStreetMap
};

// The app's destinations (lib/data/geo.dart).
const towns = [
  { id: 'suwalki', lat: 54.1115, lon: 22.9308, r: 9000 },
  { id: 'augustow', lat: 53.8436, lon: 22.9796, r: 7000 },
  { id: 'sejny', lat: 54.1093, lon: 23.3463, r: 5000 },
  { id: 'bialystok', lat: 53.1325, lon: 23.1688, r: 12000 },
];

const chains = ['biedronka', 'lidl', 'kaufland', 'rossmann', 'hebe', 'aldi', 'netto', 'auchan', 'carrefour', 'pepco', 'action', 'dino'];

// Public Overpass instances; tried in turn, busy servers answer 429/502/504.
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
};

export async function collectStores(): Promise<Store[]> {
  const parts = towns
    .map((t) => {
      const at = `(around:${t.r},${t.lat},${t.lon})`;
      return `nwr${at}["shop"]["brand"];nwr${at}["amenity"="fuel"];`;
    })
    .join('');
  const q = `[out:json][timeout:90];(${parts});out center tags;`;
  let res: Response | undefined;
  const errors: string[] = [];
  for (const url of [...ENDPOINTS, ...ENDPOINTS]) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(120000),
      });
      if (res.ok) break;
      errors.push(`${new URL(url).host} ${res.status}`);
    } catch (e) {
      errors.push(`${new URL(url).host} ${(e as Error).message}`);
    }
    res = undefined;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!res) throw new Error(`Overpass: ${errors.join('; ')}`);
  const j = (await res.json()) as { elements: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] };
  const out: Store[] = [];
  const seen = new Set<string>();
  for (const e of j.elements) {
    const t = e.tags ?? {};
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat == null || lon == null) continue;
    const brand = (t.brand ?? t.name ?? '').trim();
    const fold = brand.toLowerCase();
    let chain: string | undefined;
    if (t.amenity === 'fuel') chain = 'fuel';
    else chain = chains.find((c) => fold.includes(c));
    if (!chain || !brand) continue;
    const id = `osm:${e.type[0]}${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = { lat, lon };
    const town = towns.map((tw) => ({ id: tw.id, d: dist(p, tw) })).sort((a, b) => a.d - b.d)[0].id;
    const street = [t['addr:street'] ?? t['addr:place'], t['addr:housenumber']].filter(Boolean).join(' ');
    const address = [street, t['addr:city']].filter(Boolean).join(', ') || undefined;
    out.push({
      id,
      chain,
      brand,
      name: t.name && t.name !== brand ? t.name : undefined,
      town,
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      address,
      hours: t.opening_hours?.trim() || undefined,
    });
  }
  if (out.length < 10) throw new Error(`only ${out.length} stores`);
  return out.sort((a, b) => a.town.localeCompare(b.town) || a.chain.localeCompare(b.chain));
}

// Official store locators that publish hours and can be read politely (see locators/).
// Biedronka, Hebe, Action, Carrefour and Kaufland block automated access: not used.
const locatorChains = ['lidl', 'aldi', 'rossmann', 'pepco', 'dino', 'netto'] as const;

/** Prefer the chain's own published hours over OpenStreetMap where a shop matches (≤150 m). */
export async function addChainHours(stores: Store[], log = console.log): Promise<void> {
  const { match } = await import('./locators/match.mjs');
  for (const c of locatorChains) {
    try {
      const mod = await import(`./locators/${c}.mjs`);
      const loc = (await mod[c]()) as { chain: string; lat: number; lon: number; address: string; hours: string | null }[];
      const osm = stores.filter((s) => s.chain === c);
      const m: Map<string, { hours: string | null }> = match(osm, loc);
      let n = 0;
      for (const s of osm) {
        const h = m.get(s.id)?.hours;
        if (h) {
          s.hours = h;
          s.hoursFrom = 'chain';
          n++;
        } else if (s.hours) s.hoursFrom = 'osm';
      }
      // Shops the map doesn't have yet: add them from the chain's own list.
      const used = new Set([...m.values()].map((v) => `${(v as { lat: number }).lat},${(v as { lon: number }).lon}`));
      let added = 0;
      for (const l of loc as (typeof loc[number] & { id?: string | number })[]) {
        if (used.has(`${l.lat},${l.lon}`) || !l.hours) continue;
        const p = { lat: l.lat, lon: l.lon };
        const town = towns.map((tw) => ({ id: tw.id, d: dist(p, tw) })).sort((a, b) => a.d - b.d)[0].id;
        stores.push({ id: `${c}:${l.id ?? `${l.lat},${l.lon}`}`, chain: c, brand: c[0].toUpperCase() + c.slice(1), town, lat: l.lat, lon: l.lon, address: l.address, hours: l.hours, hoursFrom: 'chain' });
        added++;
      }
      log(`  ✓ ${c} locator: ${loc.length} shops, ${n} matched, ${added} added`);
    } catch (e) {
      log(`  ✗ ${c} locator: ${(e as Error).message}`);
    }
  }
  for (const s of stores) if (s.hours && !s.hoursFrom) s.hoursFrom = 'osm';
}
