import { readPageVision, visionEnabled } from './vision.ts';
import { get, getJson, getText } from './http.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { interpretPaddle, readPage, type NameSide, type PageDeal, type PaddleLine } from './ocr.ts';
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

// ── Leaflet pages → deals that point back to their page ───────────────
// Each page: the vision model first (cached per image), else local OCR within its budget.
// Toy and home catalogues are skipped: nobody drives to Poland for those prices.
const SKIP = /zabawk|home|dom i ogr|ogr[oó]d|katalog zabawek|moda/i;
export const seenImages = new Set<string>();

export async function ocrLeaflets(leaflets: Leaflet[], side: NameSide, maxPages: number, prefer?: RegExp): Promise<Deal[]> {
  const today = new Date().toISOString().slice(0, 10);
  const ordered = leaflets
    .filter((l) => !SKIP.test(l.title) && (!l.validTo || l.validTo >= today))
    .sort((a, b) => (prefer ? Number(prefer.test(b.title)) - Number(prefer.test(a.title)) : 0));
  const out: Deal[] = [];
  const emit = (lf: Leaflet, pg: Leaflet['pages'][number], items: (PageDeal & { everyday?: boolean })[], vision: boolean) =>
    items.forEach((d, i) =>
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
        vision: vision || undefined,
        everyday: d.everyday,
        leaflet: lf.id,
        page: pg.n,
      }),
    );

  // 1) Vision model (cached per page image).
  const rest: [Leaflet, Leaflet['pages'][number]][] = [];
  let visionPages = 0;
  for (const lf of ordered) {
    for (const pg of lf.pages) {
      seenImages.add(pg.image);
      try {
        const items = await readPageVision(pg.image);
        if (items) {
          visionPages++;
          emit(lf, pg, items, true);
        } else rest.push([lf, pg]);
      } catch (e) {
        console.log(`  ${lf.chain} p${pg.n} vision failed: ${(e as Error).message}`);
        rest.push([lf, pg]);
      }
    }
  }

  // 2) Open-source OCR for the pages vision didn't cover, within the page budget:
  //    PaddleOCR when installed (PADDLE_PYTHON), else Tesseract.
  const py = process.env.PADDLE_PYTHON;
  // PaddleOCR takes ~20–40 s a page on a CPU runner: cap it so the daily run stays short.
  const todo = rest.slice(0, py ? Math.min(maxPages, Number(process.env.PADDLE_MAX ?? 40)) : maxPages);
  let ocrPages = 0;
  if (py && todo.length) {
    const dir = mkdtempSync(join(tmpdir(), 'zl-pages-'));
    const files: string[] = [];
    for (const [, pg] of todo) {
      try {
        const f = join(dir, `${files.length}.png`);
        writeFileSync(f, Buffer.from(await (await get(pg.image, { accept: 'image/*' })).arrayBuffer()));
        files.push(f);
      } catch {
        files.push('');
      }
    }
    const res = spawnSync(py, [new URL('../tools/paddle_page.py', import.meta.url).pathname, ...files.filter(Boolean)], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (res.status !== 0 || res.error) {
      console.log(`  PaddleOCR failed (status ${res.status}${res.error ? `, ${res.error.message}` : ''}):`);
      console.log((res.stderr ?? '').split('\n').filter((l) => l.trim()).slice(-12).map((l) => `    ${l}`).join('\n'));
    }
    const widths = new Map<string, number>();
    for (const f of files.filter(Boolean)) widths.set(f, (await sharp(f).metadata()).width ?? 1000);
    const byFile = new Map<string, PaddleLine[]>();
    for (const l of (res.stdout ?? '').split('\n')) {
      try {
        const d = JSON.parse(l);
        byFile.set(d.image, d.lines);
      } catch { /* log lines */ }
    }
    todo.forEach(([lf, pg], i) => {
      const lines = byFile.get(files[i]);
      if (!lines) return;
      ocrPages++;
      emit(lf, pg, interpretPaddle(lines, widths.get(files[i]) ?? 1000, side), false);
    });
    rmSync(dir, { recursive: true, force: true });
  } else {
    for (const [lf, pg] of todo) {
      try {
        const img = Buffer.from(await (await get(pg.image, { accept: 'image/*' })).arrayBuffer());
        emit(lf, pg, await readPage(img, side), false);
        ocrPages++;
      } catch (e) {
        console.log(`  ${lf.chain} p${pg.n} skipped: ${(e as Error).message}`);
      }
    }
  }
  console.log(`  ${leaflets[0]?.chain ?? ''}: ${visionPages} pages by vision${visionEnabled() ? '' : ' (no key / quota / run limit)'}, ${ocrPages} by ${py ? 'PaddleOCR' : 'Tesseract'}, ${rest.length - todo.length} left for tomorrow`);
  return out;
}
