// Per-station Lithuanian pump prices from the energy agency's fuel map (degalukainos.ena.lt).
// Stations report prices to LEA by 10:00 every working day. The map reads them from LEA's
// API with a read-only key that ships in the public page; we read that key from the page
// each run (so a new key is picked up) and fetch the same data once a day.
import { get } from './http.ts';

const SITE = 'https://degalukainos.ena.lt/';

export type LtStation = { id: string; brand: string; company: string; address: string; lat: number; lon: number; pb95?: number; diesel?: number; lpg?: number; at: string };

async function apiConfig(): Promise<{ base: string; token: string }> {
  const html = await (await get(SITE, { accept: 'text/html' })).text();
  const entry = html.match(/src="\.?\/?(assets\/index-[^"]+\.js)"/)?.[1];
  if (!entry) throw new Error('LEA page: no app script');
  const main = await (await get(SITE + entry, { accept: '*/*' })).text();
  const chunks = [...main.matchAll(/"\.\/(FuelPriceSiteApp-[^"]+\.js)"/g)].map((m) => m[1]);
  for (const src of [main, ...(await Promise.all(chunks.map(async (c) => (await get(SITE + 'assets/' + c, { accept: '*/*' })).text())))]) {
    const base = src.match(/apiBase:"([^"]+)"/)?.[1];
    const token = src.match(/token:"([^"]+)"/)?.[1];
    if (base && token) return { base, token };
  }
  throw new Error('LEA page: API settings not found');
}

export async function collectLtStations(): Promise<{ updated: string; stations: LtStation[] }> {
  const { base, token } = await apiConfig();
  const res = await fetch(`${base}/read/prices/latest`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'ZlotikaBot/0.1 (free price-comparison app; daily, robots.txt respected)' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`LEA API HTTP ${res.status}`);
  const j = (await res.json()) as { last_updated?: string; data: { uuid: string; company_name: string; gas_station_name: string; address: string; latitude: string; longitude: string; fuel_type: string; price: string; submitted_at: string }[] };
  const by = new Map<string, LtStation>();
  for (const r of j.data) {
    const lat = Number(r.latitude), lon = Number(r.longitude), price = Number(r.price);
    if (!isFinite(lat) || !isFinite(lon) || !(price > 0.3 && price < 5)) continue;
    // One row per station and fuel: group rows by place.
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    let s = by.get(key);
    if (!s) {
      s = { id: `lea:${r.uuid}`, brand: r.gas_station_name?.trim() || r.company_name, company: r.company_name, address: r.address, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, at: r.submitted_at };
      by.set(key, s);
    }
    if (r.fuel_type === 'benzinas_95') s.pb95 = price;
    else if (r.fuel_type === 'dyzelinas') s.diesel = price;
    else if (r.fuel_type === 'snd') s.lpg = price;
    if (r.submitted_at > s.at) s.at = r.submitted_at;
  }
  const stations = [...by.values()];
  if (stations.length < 100) throw new Error(`only ${stations.length} stations`);
  return { updated: j.last_updated ?? stations.reduce((m, s) => (s.at > m ? s.at : m), ''), stations };
}
