import { get, getJson, getText } from './http.ts';
import { readPage, type NameSide } from './ocr.ts';
import type { Deal } from './types.ts';

/** A retailer leaflet for the in-app reader. Images stay on the retailer's own servers. */
export interface Leaflet {
  id: string;
  chain: string;
  title: string;
  validFrom?: string;
  validTo?: string;
  cover?: string;
  link: string; // the retailer's own leaflet page
  pages: { n: number; image: string; thumb?: string; link: string }[];
}

const today = () => new Date().toISOString().slice(0, 10);

// ── Schwarz leaflet platform (Lidl, Kaufland) ─────────────────────────
async function schwarz(chain: 'lidl' | 'kaufland', viewer: string): Promise<Leaflet[]> {
  const API = 'https://endpoints.leaflets.schwarz/v4';
  const ov = await getJson<any>(`${API}/overview?client_locale=${chain}/pl-PL&region_id=0`);
  const flyers: any[] = (ov.categories ?? []).flatMap((c: any) => c.subcategories.flatMap((s: any) => s.flyers ?? []));
  const out: Leaflet[] = [];
  for (const f of flyers.filter((x) => x.isActive !== false)) {
    const fl = (await getJson<any>(`${API}/flyer?flyer_identifier=${f.id}&region_id=0`)).flyer ?? {};
    const validTo = fl.offerEndDate ?? fl.endDate;
    if (validTo && validTo < today()) continue;
    out.push({
      id: `${chain}-${f.id}`,
      chain,
      title: [f.name, f.title].filter(Boolean).join(' · '),
      validFrom: fl.offerStartDate ?? fl.startDate,
      validTo,
      cover: f.thumbnailUrl ?? fl.thumbnailUrl,
      link: fl.flyerUrlAbsolute ?? `${viewer}/${f.id}`,
      pages: (fl.pages ?? []).map((p: any) => ({
        n: p.number,
        image: p.zoom ?? p.image,
        thumb: p.thumbnail,
        link: `${fl.flyerUrlAbsolute ?? `${viewer}/${f.id}`}#page=${p.number}`,
      })),
    });
  }
  return out;
}

// One listing per run, shared by the reader output and OCR.
const memo = new Map<string, Promise<Leaflet[]>>();
const once = (k: string, f: () => Promise<Leaflet[]>) => () => (memo.get(k) ?? memo.set(k, f()).get(k)!);

export const listKaufland = once('kaufland', () => schwarz('kaufland', 'https://leaflets.kaufland.com/pl-PL'));
export const listLidl = once('lidl', () => schwarz('lidl', 'https://www.lidl.pl/l/pl/gazetki'));

// ── Biedronka ──────────────────────────────────────────────────────────
function biedronkaDates(slug: string) {
  const m = slug.match(/od-(\d{1,2})-(\d{1,2})/) ?? slug.match(/(\d{1,2})-(\d{1,2})$/);
  if (!m) return {};
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), +m[2] - 1, +m[1]));
  if (from.getTime() - now.getTime() > 200 * 864e5) from.setUTCFullYear(from.getUTCFullYear() - 1);
  return { validFrom: from.toISOString().slice(0, 10), validTo: new Date(from.getTime() + 6 * 864e5).toISOString().slice(0, 10) };
}

export const listBiedronka = once('biedronka', async (): Promise<Leaflet[]> => {
  const list = await getText('https://www.biedronka.pl/pl/gazetki');
  const press = [...new Set([...list.matchAll(/https:\/\/www\.biedronka\.pl\/pl\/press,id,[^"#]+/g)].map((m) => m[0]))];
  const out: Leaflet[] = [];
  for (const url of press) {
    const slug = url.split('title,')[1] ?? '';
    const d = biedronkaDates(slug);
    if (d.validTo && d.validTo < today()) continue;
    const html = await getText(url);
    const uuid = html.match(/galleryLeaflet\.init\("([^"]+)"/)?.[1];
    const realTitle = (html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? html.match(/<title>([^<]+)<\/title>/)?.[1])
      ?.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s*[|–-]\s*Biedronka.*$/i, '').replace(/\s*-\s*Gazetka$/i, '').trim();
    if (!uuid) continue;
    const leaf = await getJson<any>(`https://leaflet-api.prod.biedronka.cloud/api/leaflets/${uuid}?ctx=web`);
    const imgs: any[] = leaf.images_mobile ?? [];
    if (!imgs.length) continue;
    const title = realTitle || slug.replace(/-/g, ' ').replace(/\bod (\d{1,2}) (\d{1,2})\b/, 'od $1.$2').replace(/^./, (c) => c.toUpperCase());
    out.push({
      id: `biedronka-${uuid}`,
      chain: 'biedronka',
      title,
      ...d,
      cover: imgs[0]?.image,
      link: url,
      pages: imgs.map((p: any) => ({ n: p.page + 1, image: p.image, link: `${url}#page=${p.page + 1}` })),
    });
  }
  return out;
});

// ── OCR: leaflet pages → deals that point back to their page ──────────
export async function ocrLeaflets(leaflets: Leaflet[], side: NameSide, maxPages: number, prefer?: RegExp): Promise<Deal[]> {
  const ordered = prefer ? [...leaflets].sort((a, b) => Number(prefer.test(b.title)) - Number(prefer.test(a.title))) : leaflets;
  const out: Deal[] = [];
  let budget = maxPages;
  for (const lf of ordered) {
    for (const pg of lf.pages) {
      if (budget-- <= 0) return out;
      try {
        const img = Buffer.from(await (await get(pg.image, { accept: 'image/*' })).arrayBuffer());
        (await readPage(img, side)).forEach((d, i) =>
          out.push({
            id: `${lf.id.slice(0, 24)}-p${pg.n}-${i}`,
            chain: lf.chain,
            name: d.name,
            price: d.price,
            oldPrice: d.oldPrice,
            card: d.card,
            multibuy: d.multibuy,
            minQty: d.minQty,
            limit: d.limit,
            unit: d.unit,
            unitPrice: d.unitPrice,
            validFrom: lf.validFrom,
            validTo: lf.validTo,
            imageUrl: pg.image,
            url: pg.link,
            ocr: true,
            leaflet: lf.id,
            page: pg.n,
          }),
        );
      } catch (e) {
        console.log(`  ${lf.chain} p${pg.n} skipped: ${(e as Error).message}`);
      }
    }
  }
  return out;
}
