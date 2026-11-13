// Fuel prices for the trip calculator. Two public sources, no station-level scraping:
//  • EU Weekly Oil Bulletin (European Commission, open data): national average pump
//    prices with taxes for Lithuania and Poland, in €/l. Published weekly (Monday data).
//  • e-petrol.pl: weekly Polish national averages in zł/l (Pb95, ON, LPG), plus
//    voivodeship averages when they are fresh (Podlaskie is the border region).
import { inflateRawSync } from 'node:zlib';
import { get } from './http.ts';

export type FuelPrice = { pb95?: number; diesel?: number; lpg?: number; currency: 'EUR' | 'PLN'; date: string; source: string; url: string };
/** Poland's legal maximum pump price (gross, zł/l), set daily by the Minister of Energy. */
export type FuelCap = { pb95?: number; pb98?: number; diesel?: number; date: string; source: string; url: string };
export type FuelFeed = { generatedAt: string; lt?: FuelPrice; pl?: FuelPrice; plRegion?: FuelPrice & { region: string }; plEu?: FuelPrice; plCap?: FuelCap };

const WOB_PAGE = 'https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en';
const EPETROL = 'https://www.e-petrol.pl/notowania/rynek-krajowy/ceny-stacje-paliw';

/** Reads one file out of a zip archive (enough for an .xlsx). */
function unzipEntry(zip: Buffer, name: string): string {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28), extra = zip.readUInt16LE(p + 30), comment = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (entry === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return (method === 0 ? data : inflateRawSync(data)).toString('utf8');
    }
    p += 46 + nameLen + extra + comment;
  }
  throw new Error(`${name} missing in zip`);
}

const excelDate = (serial: number) => new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
const perLitre = (perThousand?: number) => (perThousand && perThousand > 300 && perThousand < 5000 ? Math.round(perThousand) / 1000 : undefined);

export async function collectEuBulletin(): Promise<{ lt: FuelPrice; pl: FuelPrice }> {
  const page = await (await get(WOB_PAGE)).text();
  // The "Prices with taxes, latest prices (xlsx)" link; its id stays the same, the file is replaced weekly.
  const m = page.match(/href="(\/document\/download\/[^"]+)"[^>]*data-untranslated-label="Prices with taxes latest prices/i);
  if (!m) throw new Error('bulletin link not found');
  const url = new URL(m[1].replace(/&amp;/g, '&'), WOB_PAGE).href;
  const xlsx = Buffer.from(await (await get(url, { accept: '*/*' })).arrayBuffer());
  const strings = [...unzipEntry(xlsx, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((x) => x[1].replace(/<[^>]+>/g, '').trim());
  const sheet = unzipEntry(xlsx, 'xl/worksheets/sheet1.xml');
  const rows = [...sheet.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
    const cells: Record<string, string> = {};
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<f>[^<]*<\/f>)?(?:<v>([^<]*)<\/v>)?<\/c>)/g)) {
      if (c[3] == null) continue;
      cells[c[1]] = / t="s"/.test(c[2]) ? strings[Number(c[3])] : c[3];
    }
    return cells;
  });
  const dateCell = rows.find((r) => /^\d{5}(\.\d+)?$/.test(r.A ?? ''))?.A;
  if (!dateCell) throw new Error('bulletin date not found');
  const date = excelDate(Number(dateCell));
  // Column B = Euro-super 95, C = automotive diesel, G = LPG; all € per 1000 l.
  const country = (name: string): FuelPrice => {
    const r = rows.find((x) => x.A === name);
    if (!r) throw new Error(`${name} missing in bulletin`);
    const p = { pb95: perLitre(Number(r.B)), diesel: perLitre(Number(r.C)), lpg: perLitre(Number(r.G)), currency: 'EUR' as const, date, source: 'EU Weekly Oil Bulletin', url: WOB_PAGE };
    if (!p.pb95 || !p.diesel) throw new Error(`${name}: bad values`);
    return p;
  };
  return { lt: country('Lithuania'), pl: country('Poland') };
}

const num = (s?: string) => {
  const v = Number((s ?? '').replace(',', '.'));
  return v > 1 && v < 20 ? v : undefined;
};

export async function collectEPetrol(): Promise<{ pl: FuelPrice; region?: FuelPrice & { region: string } }> {
  const html = await (await get(EPETROL)).text();
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((t) =>
    [...t[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>|\s+/g, ' ').trim())),
  );
  const fresh = (d: string) => Date.now() - Date.parse(d) < 14 * 86400000;
  // National: header Aktualizacja | Pb 98 | Pb 95 | ON | LPG, newest row first.
  const nat = tables.find((t) => t[0]?.[0] === 'Aktualizacja' && t[0][2] === 'Pb 95');
  const top = nat?.slice(1).find((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0]));
  if (!nat || !top || !fresh(top[0])) throw new Error('national table missing or stale');
  const col = (h: string) => nat[0].indexOf(h);
  const pl: FuelPrice = { pb95: num(top[col('Pb 95')]), diesel: num(top[col('ON')]), lpg: num(top[col('LPG')]), currency: 'PLN', date: top[0], source: 'e-petrol.pl', url: EPETROL };
  if (!pl.pb95 || !pl.diesel) throw new Error('national values missing');
  // Voivodeship table, only if it has been updated recently (it sometimes lags for months).
  let region: (FuelPrice & { region: string }) | undefined;
  for (const t of tables.filter((t) => t[0]?.[1] === 'Województwo')) {
    const r = t.find((x) => x[1] === 'podlaskie');
    if (r && fresh(r[0])) {
      const c = (h: string) => t[0].indexOf(h);
      region = { region: 'podlaskie', pb95: num(r[c('Pb 95')]), diesel: num(r[c('ON')]), lpg: c('LPG') > 0 ? num(r[c('LPG')]) : undefined, currency: 'PLN', date: r[0], source: 'e-petrol.pl', url: EPETROL };
      break;
    }
  }
  return { pl, region };
}

// ── Poland: legal maximum price (Monitor Polski, via the Sejm ELI open-data API) ─────
const ELI = 'https://api.sejm.gov.pl/eli';

/** Reads "…wynosi 6,10 zł za 1 l" (the gross figure) for each fuel from the notice text. */
export function parseCap(text: string): { pb95?: number; pb98?: number; diesel?: number } {
  const t = text.replace(/\s+/g, ' ');
  const after = (marker: RegExp) => {
    const i = t.search(marker);
    if (i < 0) return undefined;
    const m = t.slice(i, i + 600).match(/podatek od towarów i usług wynosi (\d+,\d{2}) zł za 1 l/);
    const v = m ? Number(m[1].replace(',', '.')) : NaN;
    return v > 3 && v < 15 ? v : undefined;
  };
  return { pb95: after(/bezołowiowej 95/), pb98: after(/bezołowiowej 98/), diesel: after(/oleju napędowego/) };
}

export async function collectPlCap(): Promise<FuelCap> {
  const list = await (await get(`${ELI}/acts/search?publisher=MP&year=${new Date().getUTCFullYear()}&title=maksymalnej%20ceny%20paliw&sortBy=promulgation&sortDir=desc&limit=3`, { accept: 'application/json' })).json() as any;
  const act = (list.items ?? []).find((a: any) => /maksymalnej ceny paliw/i.test(a.title));
  if (!act) throw new Error('no maximum-price notice found');
  const pdf = new Uint8Array(await (await get(`${ELI}/acts/${act.ELI}/text.pdf`, { accept: 'application/pdf' })).arrayBuffer());
  const { extractText, getDocumentProxy } = await import('unpdf');
  const { text } = await extractText(await getDocumentProxy(pdf), { mergePages: true });
  const cap = parseCap(text as string);
  if (!cap.pb95 || !cap.diesel) throw new Error('prices not found in notice');
  return { ...cap, date: act.promulgation, source: 'Minister Energii (Monitor Polski)', url: `https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=${act.address ?? ''}` };
}

/** Collects all sources; a failing source keeps last run's values. */
export async function collectFuel(prev?: FuelFeed): Promise<FuelFeed> {
  const feed: FuelFeed = { generatedAt: new Date().toISOString() };
  try {
    const eu = await collectEuBulletin();
    feed.lt = eu.lt;
    feed.plEu = eu.pl;
    console.log(`✓ fuel EU bulletin ${eu.lt.date}: LT ${eu.lt.pb95}/${eu.lt.diesel} €, PL ${eu.pl.pb95}/${eu.pl.diesel} €`);
  } catch (e) {
    feed.lt = prev?.lt;
    feed.plEu = prev?.plEu;
    console.log(`✗ fuel EU bulletin: ${(e as Error).message} (kept last)`);
  }
  try {
    const ep = await collectEPetrol();
    feed.pl = ep.pl;
    feed.plRegion = ep.region;
    console.log(`✓ fuel e-petrol ${ep.pl.date}: PL ${ep.pl.pb95}/${ep.pl.diesel}/${ep.pl.lpg} zł${ep.region ? `, podlaskie ${ep.region.pb95}` : ', region stale'}`);
  } catch (e) {
    feed.pl = prev?.pl;
    feed.plRegion = prev?.plRegion;
    console.log(`✗ fuel e-petrol: ${(e as Error).message} (kept last)`);
  }
  try {
    feed.plCap = await collectPlCap();
    console.log(`✓ fuel PL max price ${feed.plCap.date}: Pb95 ${feed.plCap.pb95}, ON ${feed.plCap.diesel} zł`);
  } catch (e) {
    feed.plCap = prev?.plCap;
    console.log(`✗ fuel PL max price: ${(e as Error).message} (kept last)`);
  }
  return feed;
}
