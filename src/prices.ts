// Reference shelf prices for the app's shopping vocabulary (src/terms.json), so the
// app can compare a Polish price with what the same kind of product costs at home.
// Lithuania: Barbora.lt (Maxima online shop) search pages; robots.txt allows /search.
import { readFileSync } from 'node:fs';
import { getText } from './http.ts';

export type Term = { lt: string; en: string; pl: string; cat: string };
export const terms: Term[] = JSON.parse(readFileSync(new URL('terms.json', import.meta.url), 'utf8'));

/**
 * Hand-checked search tweaks (LT shops name some things differently), and items that
 * can't be compared fairly by price per kg/l/piece (books, shoes, "fruit"…).
 */
const tweaks: Record<string, { lt?: string; pl?: string; skip?: boolean; not?: string[] }> = {
  'Vištienos krūtinėlė': { lt: 'viščiukų krūtinėlės filė', not: ['ruky', 'virt', 'kepta'] },
  'Vištienos šlaunelės': { lt: 'viščiukų šlaunelės', not: ['ruky', 'virt', 'kepta'] },
  'Vištienos sparneliai': { lt: 'viščiukų sparneliai', not: ['ruky', 'virt', 'kepta'] },
  'Malta mėsa': { lt: 'malta kiauliena', not: ['priesk'], pl: 'mięso mielone' },
  'Kalakutiena': { lt: 'kalakutienos filė', not: ['ruky', 'virt'] },
  'Kiaulienos šoninė': { not: ['ruky', 'sudyt'] },
  'Bulvės': { not: ['sald', 'bulvyt', 'trask', 'kosel', 'blyn', 'cips'] },
  'Morkos': { not: ['salot', 'sultys'] },
  'Kačių maistas': { lt: 'kačių ėdalas', pl: 'karma dla kota' },
  'Šunų maistas': { lt: 'šunų ėdalas', pl: 'karma dla psa' },
  'Kūdikių tyrelė': { lt: 'tyrelė kūdikiams' },
  'Sauskelnės': { not: ['plauk', 'plywan', 'woreczk', 'worki'] },
  'Sviestas': { not: ['lydyt', 'ghee'] },
  'Kava': { skip: true }, // too broad: ground, beans and instant have their own items
  ...Object.fromEntries(
    ['Žuvis', 'Vaisiai', 'Daržovės', 'Valymo priemonė', 'Batai', 'Knyga', 'Žaislas', 'Vitaminai', 'Kojinės', 'Apatiniai', 'Marškinėliai',
      'Džemperis', 'Pižama', 'Vaistai nuo skausmo', 'Veido kremas', 'Apsauginis kremas nuo saulės', 'Makiažo valiklis'].map((k) => [k, { skip: true }]),
  ),
};
export const tweakFor = (t: Term) => tweaks[t.lt] ?? {};

/** Per vocabulary item: the typical and cheapest price for the most relevant product category. */
export type RefPrice = {
  source: string;
  unit: 'kg' | 'l' | 'units';
  n: number; // products in the sample
  unitMin: number;
  unitMedian: number;
  pkgMedian: number; // € for a typical package
  example: { name: string; price: number; unitPrice: number; url: string };
};

export type Product = { name: string; price: number; unitPrice: number | null; unit: string | null; category: string; url: string };

const fold = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
// Lithuanian and Polish change word endings (kava/kavos, masło/masła): compare the first part.
const stem = (w: string) => (/^\d+$/.test(w) ? w : w.slice(0, Math.max(3, Math.min(6, w.length - 2))));

/** Pull the embedded JSON array that starts at `"key":[` out of a server-rendered page. */
export function embeddedArray(html: string, key: string): unknown[] {
  const i = html.indexOf(`"${key}":[`);
  if (i < 0) return [];
  const s = i + key.length + 3;
  let d = 0, inStr = false, esc = false, e = s;
  for (; e < html.length; e++) {
    const c = html[e];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') d++;
    else if (c === ']' && --d === 0) break;
  }
  return JSON.parse(html.slice(s, e + 1));
}

type BarboraItem = {
  title: string; price: number; url: string; status: string; categoryPathUrl?: string;
  promotion?: { oldPrice?: number; loyaltyCardRequired?: boolean } | null;
  comparativeUnit?: { type?: string; price?: number } | null;
};

export async function barboraSearch(q: string): Promise<Product[]> {
  const html = await getText(`https://barbora.lt/search?q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'lt' } });
  return (embeddedArray(html, 'inventories') as BarboraItem[])
    .filter((p) => p.status === 'active' && p.price > 0)
    .map((p) => {
      // Shelf price without a loyalty card: a card-only promo doesn't count.
      const card = p.promotion?.loyaltyCardRequired && p.promotion?.oldPrice;
      const price = card ? p.promotion!.oldPrice! : p.price;
      const ratio = price / p.price;
      const up = p.comparativeUnit?.price;
      return {
        name: p.title,
        price,
        unitPrice: up ? Math.round(up * ratio * 100) / 100 : null,
        unit: p.comparativeUnit?.type ?? null,
        category: p.categoryPathUrl ?? '',
        url: `https://barbora.lt/produktai/${p.url}`,
      };
    });
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Products that are the thing itself ("ROKIŠKIO sviestas"), not something made with it
 * ("sausainiai su sviestu"): every query word appears, not right after su/be/skonio/z/ze/o,
 * and the product sits in the category most of those matches share.
 */
export function relevant(query: string, products: Product[], not: string[] = []): Product[] {
  const keys = words(query).filter((w) => w.length >= 3).map(stem);
  const nots = not.map(fold);
  products = products.filter((p) => !words(p.name).some((w) => nots.some((n) => w.startsWith(n))));
  if (!keys.length) return [];
  // The main (first) word must not come right after "with/for/flavour" words; later words may ("pasta do zębów").
  const bad = new Set(['su', 'be', 'skonio', 'z', 'ze', 'o', 'w', 'do', 'na', 'dla', 'smaku', 'pod']);
  const hit = products.filter((p) => {
    const ws = words(p.name);
    return keys.every((k, ki) => ws.some((w, i) => w.startsWith(k) && (ki > 0 || !bad.has(ws[i - 1] ?? ''))));
  });
  if (!hit.length) return [];
  const count = new Map<string, number>();
  hit.forEach((p, i) => count.set(p.category, (count.get(p.category) ?? 0) + (i < 10 ? 2 : 1)));
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return hit.filter((p) => p.category === top);
}

/** popular = the shop ranks by popularity (Barbora): use its top results; otherwise use all. */
export function summarise(source: string, ps: Product[], popularOrder = true): RefPrice | null {
  const withUnit = ps.filter((p) => p.unitPrice && p.unit && ['kg', 'l', 'units'].includes(p.unit));
  if (withUnit.length < 2) return null;
  const unitCount = new Map<string, number>();
  withUnit.forEach((p) => unitCount.set(p.unit!, (unitCount.get(p.unit!) ?? 0) + 1));
  const unit = [...unitCount.entries()].sort((a, b) => b[1] - a[1])[0][0] as RefPrice['unit'];
  const same = withUnit.filter((p) => p.unit === unit);
  if (!popularOrder && same.length < 4) return null; // too few to call it 'usual'
  // "Typical" = the shop's top-ranked products (what people actually buy), not niche extremes.
  const popular = popularOrder ? same.slice(0, 8) : same;
  const um = median(popular.map((p) => p.unitPrice!));
  const ex = popularOrder ? popular[0] : [...popular].sort((a, b) => Math.abs(a.unitPrice! - um) - Math.abs(b.unitPrice! - um))[0];
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    source,
    unit,
    n: same.length,
    unitMin: r2(Math.min(...same.map((p) => p.unitPrice!))),
    unitMedian: r2(um),
    pkgMedian: r2(median(popular.map((p) => p.price))),
    example: { name: ex.name, price: ex.price, unitPrice: ex.unitPrice!, url: ex.url },
  };
}

/** Lithuanian reference prices keyed by the Polish shelf name (the app's join key). */
export async function collectLtPrices(log = console.log): Promise<Record<string, RefPrice>> {
  const out: Record<string, RefPrice> = {};
  let failures = 0;
  for (const t of terms) {
    const tw = tweakFor(t);
    if (tw.skip) continue;
    try {
      const q = tw.lt ?? t.lt;
      const ref = summarise('Barbora', relevant(q, await barboraSearch(q), tw.not));
      if (ref) out[t.pl] = ref;
    } catch (e) {
      failures++;
      log(`  lt ${t.lt}: ${(e as Error).message}`);
      if (/HTTP (403|429)/.test((e as Error).message)) throw e; // blocked: stop, don't push on
    }
  }
  if (Object.keys(out).length < terms.length / 3) throw new Error(`only ${Object.keys(out).length} LT prices (${failures} errors)`);
  return out;
}

// ── Poland: regular (non-promo) prices ──────────────────────────────────────────
// Rossmann: the chain's own product search (shops in Suwałki and Białystok).
// Frisco: the full product feed Frisco links from its robots.txt "for personal,
// non-commercial use". Off unless config.json says priceSources.frisco = true.

const plUnits: Record<string, [string, number]> = { ml: ['l', 1e-3], l: ['l', 1], g: ['kg', 1e-3], kg: ['kg', 1], szt: ['units', 1] };

type RossmannItem = { brand?: string; name?: string; caption?: string; price: number; oldPrice?: number; unit?: string; navigateUrl?: string; category?: string };

export async function rossmannSearch(q: string): Promise<Product[]> {
  const j = JSON.parse(await getText(`https://www.rossmann.pl/products/v3/api/Products?Page=1&PageSize=48&Search=${encodeURIComponent(q)}`, { accept: 'application/json' }));
  const items: RossmannItem[] = j?.data?.products ?? [];
  return items
    .filter((p) => p.price > 0)
    .map((p) => {
      const regular = p.oldPrice && p.oldPrice > p.price ? p.oldPrice : p.price;
      const m = /([\d,.]+)\s*(ml|l|g|kg|szt)\b/i.exec(p.unit ?? '');
      const [unit, f] = m ? plUnits[m[2].toLowerCase()] : [null, 0];
      const qty = m ? parseFloat(m[1].replace(',', '.')) * f : 0;
      return {
        name: [p.brand, p.name || p.caption].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
        price: regular,
        unitPrice: qty > 0 ? Math.round((regular / qty) * 100) / 100 : null,
        unit,
        category: 'rossmann',
        url: p.navigateUrl ? `https://www.rossmann.pl${p.navigateUrl}` : '',
      };
    });
}

type FriscoProduct = {
  brand?: string; name: { pl: string }; grammage?: number; unitOfMeasure?: string; isAvailable?: boolean; productUrl?: string;
  price?: { price: number; priceBeforeDiscount?: number }; categories?: { depth: number; name: { pl: string } }[];
};

export async function friscoProducts(): Promise<Product[]> {
  const r = await fetch('https://commerce.frisco.pl/api/v1/integration/feeds/public?language=pl', {
    headers: { 'User-Agent': (await import('./http.ts')).UA, 'Accept-Encoding': 'gzip' },
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`Frisco feed HTTP ${r.status}`);
  const j = (await r.json()) as { products: FriscoProduct[] };
  const unitOf: Record<string, string> = { Kilogram: 'kg', Litre: 'l', Piece: 'units' };
  return j.products
    .filter((p) => p.isAvailable && p.price?.price)
    .map((p) => {
      const regular = p.price!.priceBeforeDiscount ?? p.price!.price;
      const cats = (p.categories ?? []).sort((a, b) => b.depth - a.depth);
      return {
        name: [p.brand, p.name.pl].filter(Boolean).join(' '),
        price: regular,
        unitPrice: p.grammage ? Math.round((regular / p.grammage) * 100) / 100 : null,
        unit: unitOf[p.unitOfMeasure ?? ''] ?? null,
        category: cats[0]?.name.pl ?? '',
        url: p.productUrl ?? '',
      };
    });
}

const drugstore = new Set(['hygiene', 'baby', 'household']);

/** Polish regular prices keyed by the Polish shelf name. */
/** Drop PL references that are wildly off the LT one: that's a product mismatch, not a bargain. */
export function sane(pl: Record<string, RefPrice>, lt: Record<string, RefPrice>, plnPerEur = 4.25): Record<string, RefPrice> {
  const out: Record<string, RefPrice> = {};
  for (const [k, p] of Object.entries(pl)) {
    const l = lt[k];
    if (l && l.unit === p.unit) {
      const ratio = p.unitMedian / plnPerEur / l.unitMedian;
      if (ratio > 3 || ratio < 1 / 3) continue;
    }
    out[k] = p;
  }
  return out;
}

export async function collectPlPrices(opts: { frisco: boolean; rossmann: boolean }, log = console.log): Promise<Record<string, RefPrice>> {
  const out: Record<string, RefPrice> = {};
  let frisco: Product[] = [];
  if (opts.frisco) {
    try {
      frisco = await friscoProducts();
      log(`  frisco feed: ${frisco.length} products`);
    } catch (e) {
      log(`  frisco: ${(e as Error).message}`);
    }
  }
  for (const t of terms) {
    const tw = tweakFor(t);
    if (tw.skip) continue;
    const q = tw.pl ?? t.pl;
    let ref: RefPrice | null = null;
    if (opts.rossmann && drugstore.has(t.cat)) {
      try {
        ref = summarise('Rossmann', relevant(q, await rossmannSearch(q), tw.not), false);
      } catch (e) {
        log(`  pl ${q}: ${(e as Error).message}`);
        if (/HTTP (403|429)/.test((e as Error).message)) break;
      }
    }
    if (!ref && frisco.length) ref = summarise('Frisco', relevant(q, frisco, tw.not), false);
    if (ref) out[t.pl] = ref;
  }
  return out;
}

// ── Lithuania: Rimi online shop (rimi.lt/e-parduotuve) ─────────────────────────
// Category pages are allowed by robots.txt (only /search?q=* is not); each product tile
// carries {"name":"ROKIŠKIO sviestas, 82 % rieb., 200 g","price":2.79}. Categories come
// from the shop's own sitemap, matched to our vocabulary by name.
const RIMI = 'https://www.rimi.lt/e-parduotuve';
const ltUnits: Record<string, [string, number]> = { ml: ['l', 1e-3], l: ['l', 1], g: ['kg', 1e-3], kg: ['kg', 1], vnt: ['units', 1] };

/** "…, 200 g" / "…, 1,5 l" / "…, 4 x 100 g" / "…, 10 vnt." → amount in kg / l / pieces. */
export function ltQty(name: string): { unit: string; qty: number } | null {
  const n = name.toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
  const m = n.match(/(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(ml|l|g|kg|vnt)\b\.?(?!.*\d+(?:\.\d+)?\s*(?:ml|l|g|kg|vnt)\b)/);
  if (!m) return null;
  const [unit, f] = ltUnits[m[3]];
  const qty = (m[1] ? Number(m[1]) : 1) * Number(m[2]) * f;
  return qty > 0 ? { unit, qty } : null;
}

let rimiCats: string[] | null = null;
async function rimiCategories(): Promise<string[]> {
  if (rimiCats) return rimiCats;
  const xml = await getText(`${RIMI}/sitemaps/categories/siteMap_rimiLtSite_Category_lt_1.xml`, { accept: 'application/xml' });
  return (rimiCats = [...new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]))]);
}

export async function rimiCategory(url: string): Promise<Product[]> {
  const html = await getText(`${url}?pageSize=100`);
  const out: Product[] = [];
  for (const m of html.matchAll(/data-gtm-eec-product='([^']+)'/g)) {
    try {
      const p = JSON.parse(m[1]) as { name: string; price: number; category?: string };
      if (!(p.price > 0)) continue;
      const q = ltQty(p.name);
      out.push({ name: p.name, price: p.price, unitPrice: q ? Math.round((p.price / q.qty) * 100) / 100 : null, unit: q?.unit ?? null, category: p.category ?? url, url });
    } catch { /* skip odd tile */ }
  }
  return out;
}

/** Rimi categories whose last path segments contain the term's words (by stem). */
async function rimiCatsFor(q: string): Promise<string[]> {
  const keys = words(q).filter((w) => w.length >= 3).map(stem);
  if (!keys.length) return [];
  const cats = await rimiCategories();
  const scored = cats
    .map((u) => {
      const segs = u.replace(/\/c\/[^/]+$/, '').split('/').slice(-1).join(' '); // the leaf category only
      const ws = words(segs.replace(/-/g, ' '));
      const hits = keys.filter((k) => ws.some((w) => w.startsWith(k))).length;
      return { u, hits, depth: u.split('/').length };
    })
    .filter((x) => x.hits === keys.length)
    .sort((a, b) => b.depth - a.depth);
  return [...new Set(scored.map((x) => x.u))].slice(0, 2);
}

export async function collectRimiPrices(log = console.log): Promise<Record<string, RefPrice>> {
  const out: Record<string, RefPrice> = {};
  for (const t of terms) {
    const tw = tweakFor(t);
    if (tw.skip) continue;
    const q = tw.lt ?? t.lt;
    try {
      const urls = await rimiCatsFor(q);
      if (!urls.length) continue;
      const ps: Product[] = [];
      for (const u of urls) ps.push(...(await rimiCategory(u)));
      // The product name must itself say what it is ("… sviestas, 200 g"), as with Barbora.
      const ref = summarise('Rimi', relevant(q, ps, tw.not), false);
      if (ref) out[t.pl] = ref;
    } catch (e) {
      log(`  rimi ${t.lt}: ${(e as Error).message}`);
      if (/HTTP (403|429)/.test((e as Error).message)) throw e;
    }
  }
  if (Object.keys(out).length < 10) throw new Error(`only ${Object.keys(out).length} Rimi prices`);
  return out;
}

/** Keep a second shop's reference only when it agrees with Barbora's on unit and roughly on price:
 *  a 20× difference is a different product (goat cheese for "milk"), not a cheaper shop. */
export function agree(other: Record<string, RefPrice>, base: Record<string, RefPrice>): Record<string, RefPrice> {
  const out: Record<string, RefPrice> = {};
  for (const [k, r] of Object.entries(other)) {
    const b = base[k];
    if (b && (b.unit !== r.unit || r.unitMedian / b.unitMedian > 2.5 || r.unitMedian / b.unitMedian < 0.4)) continue;
    out[k] = r;
  }
  return out;
}
