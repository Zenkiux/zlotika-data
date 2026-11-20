// Polish pump prices near the border, from AutoCentrum.pl (robots.txt allows station pages):
//  • AutoCentrum.pl station pages: prices drivers report, each with its age. We keep a price
//    only if it was reported in the last 7 days, and say how old it is.
// (cena-paliw.pl was checked and dropped: its "cheapest today" shows the same prices in every
// town, so it isn't real station data.)
import { get } from './http.ts';

const TOWNS = ['suwalki', 'augustow', 'sejny'];
const MAX_AGE_DAYS = 7;

type Price = { price: number; days: number; label: string };
export type PlStation = { id: string; brand: string; address: string; lat: number; lon: number; url: string; pb95?: Price; diesel?: Price; lpg?: Price };
export type Cheapest = Record<string, { updated?: string; pb95?: { price: number; address: string }; diesel?: { price: number; address: string }; lpg?: { price: number; address: string } }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "dzisiaj", "3 godz. temu", "wczoraj", "3 dni temu", "1 tydzień temu", "dawno temu" → days. */
export function ageDays(s: string): number {
  const t = s.toLowerCase().trim();
  if (/dzisiaj|dziś|minut|godz/.test(t)) return 0;
  if (/wczoraj/.test(t)) return 1;
  const n = Number(t.match(/(\d+)/)?.[1] ?? 1);
  if (/dni|dzień/.test(t)) return n;
  if (/tydz|tygod/.test(t)) return n * 7;
  if (/miesi/.test(t)) return n * 30;
  return 999;
}

export function parseStation(html: string, url: string): PlStation | null {
  const lat = Number(html.match(/"latitude":\s*"?([\d.]+)/)?.[1]);
  const lon = Number(html.match(/"longitude":\s*"?([\d.]+)/)?.[1]);
  if (!isFinite(lat) || !isFinite(lon) || !lat) return null;
  const crumbs = [...html.matchAll(/"position":(\d),"name":"([^"]+)"/g)].map((m) => m[2]);
  const brand = crumbs[3] ?? 'Stacja';
  const address = crumbs[4] ?? '';
  const st: PlStation = { id: 'ac:' + url.replace(/\/$/, '').split('/').pop(), brand, address, lat, lon, url };
  const re = /station-detail-wrapper (\w+) text-center">\s*<h2[^>]*>([^<]+)<\/h2>\s*<div class="price">([\d,]+)\s*<span>zł<\/span><\/div>\s*<div class="date">([^<]+)<\/div>/g;
  for (const m of html.matchAll(re)) {
    const cls = m[1], label = m[2].trim(), price = Number(m[3].replace(',', '.')), days = ageDays(m[4]);
    if (!(price > 1 && price < 15) || days > MAX_AGE_DAYS) continue;
    const kind = cls === 'lpg' || /lpg|gaz|autogas|powergas/i.test(label) ? 'lpg' : cls === 'on' || /\bON\b|diesel/i.test(label) ? 'diesel' : cls === 'pb' && !/98|100|racing|nitro|premium|verva|v-power|ultimate|dynamic/i.test(label) ? 'pb95' : null;
    if (!kind) continue;
    const prev = st[kind];
    if (!prev || days < prev.days) st[kind] = { price, days, label };
  }
  return st;
}

export function parseCheapest(html: string) {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const one = (re: RegExp) => {
    const m = text.match(re);
    return m ? { address: m[1].trim(), price: Number(m[2].replace(',', '.')) } : undefined;
  };
  return {
    updated: text.match(/Ostatnia aktualizacja: (\d\d\.\d\d\.\d{4}) o godzinie (\d\d:\d\d)/)?.slice(1).join(' '),
    pb95: one(/najtańsza benzyna[^?]*\? ([^?]{3,60}?) Najniższa cena dziś: (\d+,\d+) zł/i),
    diesel: one(/najtańszy diesel[^?]*\? ([^?]{3,60}?) Najniższa cena dziś: (\d+,\d+) zł/i),
    lpg: one(/najtaniej LPG[^?]*\? ([^?]{3,60}?) Najniższa cena dziś: (\d+,\d+) zł/i),
  };
}

export async function collectPlFuel(log = console.log): Promise<{ stations: PlStation[] }> {
  const sitemap = await (await get('https://www.autocentrum.pl/sitemap/paliwa.xml', { accept: 'application/xml' })).text();
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => TOWNS.some((t) => u.endsWith(`-${t}/`)));
  const stations: PlStation[] = [];
  for (const u of urls) {
    try {
      const st = parseStation(await (await get(u, { accept: 'text/html' })).text(), u);
      if (st) stations.push(st);
    } catch { /* skip one station */ }
    await sleep(1200);
  }
  const fresh = stations.filter((s) => s.pb95 || s.diesel || s.lpg).length;
  log(`  ✓ PL stations (AutoCentrum): ${stations.length}, ${fresh} with prices from the last ${MAX_AGE_DAYS} days`);
  return { stations };
}
