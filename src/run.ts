import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Deal, Source } from './types.ts';
import { sources } from './sources/index.ts';
import { closeOcr } from './ocr.ts';
import { collectFuel, type FuelFeed } from './fuel.ts';
import { listBiedronka, listKaufland, listLidl, type Leaflet } from './leaflets.ts';

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
for (const s of sources.filter((x: Source) => only !== 'fuel' && (!only || x.chain === only))) {
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

await closeOcr();

// Leaflets for the in-app reader (images stay on the retailers' servers).
const leaflets: Leaflet[] = [];
const prevLeafPath = new URL('leaflets.json', outDir);
const prevLeaf: { leaflets: Leaflet[] } = existsSync(prevLeafPath) ? JSON.parse(readFileSync(prevLeafPath, 'utf8')) : { leaflets: [] };
for (const [chain, list] of [['biedronka', listBiedronka], ['kaufland', listKaufland], ['lidl', listLidl]] as const) {
  if (only && only !== chain && only !== 'leaflets') continue;
  try {
    const ls = await list();
    leaflets.push(...ls);
    console.log(`✓ leaflets ${chain}: ${ls.length} (${ls.reduce((a, l) => a + l.pages.length, 0)} pages)`);
  } catch (e) {
    const kept = prevLeaf.leaflets.filter((l) => l.chain === chain);
    leaflets.push(...kept);
    console.log(`✗ leaflets ${chain}: ${(e as Error).message} (kept ${kept.length})`);
  }
}
// Fuel prices (weekly public averages) for the trip calculator.
const fuelPath = new URL('fuel.json', outDir);
if (!only || only === 'fuel') {
  const prevFuel: FuelFeed | undefined = existsSync(fuelPath) ? JSON.parse(readFileSync(fuelPath, 'utf8')) : undefined;
  writeFileSync(fuelPath, JSON.stringify(await collectFuel(prevFuel)));
}
if (only === 'fuel') process.exit(0);

writeFileSync(prevLeafPath, JSON.stringify({ generatedAt: new Date().toISOString(), leaflets }));
const today = new Date().toISOString().slice(0, 10);
const live = results.filter((d) => !d.validTo || d.validTo >= today);
writeFileSync(new URL('deals.json', outDir), JSON.stringify({ generatedAt: new Date().toISOString(), sources: statuses, deals: live }));
// The off switch lives in the repo's config.json; publish it next to the feed.
const cfg = new URL('../config.json', import.meta.url);
writeFileSync(new URL('config.json', outDir), existsSync(cfg) ? readFileSync(cfg, 'utf8') : JSON.stringify({ collectedEnabled: true, disabledChains: [] }));
console.log(`total ${live.length} deals`);
