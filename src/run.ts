import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Deal, Source } from './types.ts';
import { sources } from './sources/index.ts';
import { closeOcr } from './ocr.ts';
import { collectFuel, type FuelFeed } from './fuel.ts';
import { collectStores, addChainHours, collectRouteFuel } from './stores.ts';
import { ikiProducts, lidlLtProducts, norfaProducts, promoRefs } from './ltpromo.ts';
import { agree, collectLtPrices, collectPlPrices, collectRimiPrices, sane } from './prices.ts';
import { listBiedronka, listKaufland, listLidl, seenImages, type Leaflet } from './leaflets.ts';
import { saveVisionCache } from './vision.ts';
import { translateDeals } from './translate.ts';
import { collectLtStations } from './ltfuel.ts';
import { collectCrowd } from './crowd.ts';

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
const outDir = new URL('../out/', import.meta.url);
mkdirSync(outDir, { recursive: true });

// Keep yesterday's data for a source that fails today, so one broken site never empties the app.
const prevPath = new URL('deals.json', outDir);
const prev: { deals: Deal[] } = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, 'utf8')) : { deals: [] };

const clean = (d: Deal): Deal | null => {
  const name = d.name?.replace(/\s+/g, ' ').replace(/^[\s\-–—·,.]+/, '').trim();
  if (!name || !(d.price > 0) || d.price > 20000) return null;
  // Leaflet-read names must look like a product: ≥ 2 words or one long word, ≥ 8 letters.
  if (d.ocr) {
    const letters = name.replace(/[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/g, '').length;
    const words = name.split(/\s+/).filter((w) => /[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]{3}/.test(w));
    if (letters < 8 || (words.length < 2 && letters < 9)) return null;
  }
  const round = (x?: number) => (x == null || !isFinite(x) ? undefined : Math.round(x * 100) / 100);
  return { ...d, name, price: round(d.price)!, oldPrice: d.oldPrice && d.oldPrice > d.price ? round(d.oldPrice) : undefined, unitPrice: round(d.unitPrice) };
};

const results: Deal[] = [];
const statuses: { chain: string; ok: boolean; count: number; fetchedAt: string; error?: string }[] = [];
for (const s of sources.filter((x: Source) => only !== 'fuel' && only !== 'stores' && only !== 'prices' && only !== 'prices-pl' && (!only || x.chain === only))) {
  const t0 = Date.now();
  try {
    const raw = await s.collect();
    const seen = new Set<string>();
    const deals = raw.map(clean).filter((d): d is Deal => !!d && !seen.has(d.id) && !!seen.add(d.id));
    if (!deals.length) throw new Error('no deals parsed');
    results.push(...deals);
    statuses.push({ chain: s.chain, ok: true, count: deals.length, fetchedAt: new Date().toISOString() });
    console.log(`✓ ${s.chain}: ${deals.length} deals (${Date.now() - t0} ms)`);
  } catch (e) {
    const kept = prev.deals.filter((d) => d.chain === s.chain);
    results.push(...kept);
    statuses.push({ chain: s.chain, ok: false, count: kept.length, fetchedAt: new Date().toISOString(), error: String((e as Error).message).slice(0, 200) });
    console.log(`✗ ${s.chain}: ${(e as Error).message} (kept ${kept.length} from last run)`);
  }
}

// Shopper-reported shelf prices near the border towns (Open Prices).
if (!only || only === 'crowd') {
  try {
    const crowd = await collectCrowd();
    results.push(...crowd);
    statuses.push({ chain: 'openprices', ok: true, count: crowd.length, fetchedAt: new Date().toISOString() });
    console.log(`✓ Open Prices: ${crowd.length} shopper prices near the border`);
  } catch (e) {
    const kept = prev.deals.filter((d) => d.crowd);
    results.push(...kept);
    statuses.push({ chain: 'openprices', ok: false, count: kept.length, fetchedAt: new Date().toISOString(), error: String((e as Error).message).slice(0, 200) });
    console.log(`✗ Open Prices: ${(e as Error).message} (kept ${kept.length})`);
  }
}

await closeOcr();
if (!only || only === 'biedronka' || only === 'kaufland') saveVisionCache(seenImages);

// Leaflets for the in-app reader (images stay on the retailers' servers).
const leaflets: Leaflet[] = [];
const prevLeafPath = new URL('leaflets.json', outDir);
const prevLeaf: { leaflets: Leaflet[] } = existsSync(prevLeafPath) ? JSON.parse(readFileSync(prevLeafPath, 'utf8')) : { leaflets: [] };
for (const [chain, list] of [['biedronka', listBiedronka], ['kaufland', listKaufland], ['lidl', listLidl]] as const) {
  if (only && only !== chain && only !== 'leaflets') continue;
  try {
    const ls = await list();
    // Kaufland's list is sometimes empty between weekly leaflets: keep the ones still running.
    if (!ls.length) throw new Error('empty list');
    leaflets.push(...ls);
    console.log(`✓ leaflets ${chain}: ${ls.length} (${ls.reduce((a, l) => a + l.pages.length, 0)} pages)`);
  } catch (e) {
    const day = new Date().toISOString().slice(0, 10);
    const kept = prevLeaf.leaflets.filter((l) => l.chain === chain && (!l.validTo || l.validTo >= day));
    leaflets.push(...kept);
    console.log(`✗ leaflets ${chain}: ${(e as Error).message} (kept ${kept.length})`);
  }
}
// Fuel prices (weekly public averages) for the trip calculator.
const fuelPath = new URL('fuel.json', outDir);
if (!only || only === 'fuel') {
  const prevFuel: FuelFeed | undefined = existsSync(fuelPath) ? JSON.parse(readFileSync(fuelPath, 'utf8')) : undefined;
  writeFileSync(fuelPath, JSON.stringify(await collectFuel(prevFuel)));
  try {
    const lt = await collectLtStations();
    writeFileSync(new URL('ltfuel.json', outDir), JSON.stringify({ generatedAt: new Date().toISOString(), source: 'Lietuvos energetikos agentūra (ena.lt)', ...lt }));
    console.log(`✓ fuel LT stations: ${lt.stations.length} (LEA ${lt.updated})`);
  } catch (e) {
    console.log(`✗ fuel LT stations: ${(e as Error).message} (kept last)`);
  }
}
// Shop locations + opening hours from OpenStreetMap (keeps last good file on failure).
if (!only || only === 'stores') {
  try {
    const stores = await collectStores();
    await addChainHours(stores);
    try {
      const route = await collectRouteFuel(new Set(stores.map((x) => x.id)));
      stores.push(...route);
      console.log(`  ✓ route fuel stations: ${route.length}`);
    } catch (e) {
      console.log(`  ✗ route fuel stations: ${(e as Error).message}`);
    }
    writeFileSync(new URL('stores.json', outDir), JSON.stringify({ generatedAt: new Date().toISOString(), attribution: '© OpenStreetMap contributors (ODbL)', stores }));
    console.log(`✓ stores: ${stores.length}`);
  } catch (e) {
    console.log(`✗ stores: ${(e as Error).message} (kept last file)`);
  }
}
// Reference shelf prices (LT: Barbora; PL: Rossmann, Frisco if enabled). Keeps the last
// good values per side when a source fails.
if (!only || only === 'prices' || only === 'prices-pl') {
  const path = new URL('prices.json', outDir);
  const prevP = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { lt: {}, pl: {} };
  const cfgP = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  let lt = prevP.lt, pl = prevP.pl;
  if (only !== 'prices-pl') try {
    if (cfgP.priceSources?.barbora === false) throw new Error('switched off in config.json');
    lt = await collectLtPrices();
    console.log(`✓ LT prices: ${Object.keys(lt).length}`);
  } catch (e) {
    console.log(`✗ LT prices: ${(e as Error).message} (kept ${Object.keys(lt).length})`);
  }
  // Rimi online shop: per-chain Lithuanian prices (Barbora above = Maxima).
  let ltRimi = prevP.ltRimi ?? {};
  if (only !== 'prices-pl') try {
    if (cfgP.priceSources?.rimi === false) throw new Error('switched off in config.json');
    ltRimi = agree(await collectRimiPrices(), lt);
    console.log(`✓ LT Rimi prices: ${Object.keys(ltRimi).length}`);
  } catch (e) {
    console.log(`✗ LT Rimi prices: ${(e as Error).message} (kept ${Object.keys(ltRimi).length})`);
  }
  // Lidl LT, IKI, Norfa: this week's leaflet prices. A failed chain is left out (an old
  // promo would be wrong), so the app falls back to Maxima for it.
  const ltPromo: Record<string, Record<string, unknown>> = {};
  if (only !== 'prices-pl') for (const [id, label, read] of [['lidl', 'Lidl', lidlLtProducts], ['iki', 'IKI', ikiProducts], ['norfa', 'Norfa', norfaProducts]] as const) {
    try {
      if (cfgP.priceSources?.[id] === false) throw new Error('switched off in config.json');
      ltPromo[id] = promoRefs(label, await read(), lt);
      console.log(`✓ LT ${label} leaflet prices: ${Object.keys(ltPromo[id]).length}`);
    } catch (e) {
      console.log(`✗ LT ${label} leaflet prices: ${(e as Error).message}`);
    }
  }
  try {
    pl = sane(await collectPlPrices({ frisco: cfgP.priceSources?.frisco === true, rossmann: cfgP.priceSources?.rossmann !== false }), lt);
    console.log(`✓ PL prices: ${Object.keys(pl).length}`);
  } catch (e) {
    console.log(`✗ PL prices: ${(e as Error).message} (kept ${Object.keys(pl).length})`);
  }
  writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), lt, ltRimi, ltPromo, pl }));
}
if (only === 'fuel' || only === 'stores' || only?.startsWith('prices')) process.exit(0);

writeFileSync(prevLeafPath, JSON.stringify({ generatedAt: new Date().toISOString(), leaflets }));
const today = new Date().toISOString().slice(0, 10);
const live = results.filter((d) => !d.validTo || d.validTo >= today);
try {
  await translateDeals(live);
} catch (e) {
  console.log(`✗ translations: ${(e as Error).message}`);
}
writeFileSync(new URL('deals.json', outDir), JSON.stringify({ generatedAt: new Date().toISOString(), sources: statuses, deals: live }));
// The off switch lives in the repo's config.json; publish it next to the feed.
const cfg = new URL('../config.json', import.meta.url);
writeFileSync(new URL('config.json', outDir), existsSync(cfg) ? readFileSync(cfg, 'utf8') : JSON.stringify({ collectedEnabled: true, disabledChains: [] }));
console.log(`total ${live.length} deals`);
