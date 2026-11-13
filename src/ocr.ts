// Reads deals from leaflet page images (Biedronka, Kaufland publish image-only leaflets).
// Pipeline: colour masks → Tesseract (Polish) with word boxes → find big prices →
// attach nearest product name + conditions. Emits only confident (name, price) pairs.
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';

export interface Word { text: string; x: number; y: number; w: number; h: number; conf: number; line: string }
export interface PageDeal {
  name: string;
  price: number;
  oldPrice?: number;
  card?: boolean;
  multibuy?: string;
  minQty?: number;
  limit?: number;
  unitPrice?: number;
  unit?: string;
}

let textW: Worker | null = null;
let digitW: Worker | null = null;
let lineW: Worker | null = null;
const cachePath = new URL('../.tessdata/', import.meta.url).pathname;
async function workers() {
  if (!textW) {
    textW = await createWorker('pol', 1, { cachePath });
    // Sparse text: read each text fragment on its own (leaflets are grids, not paragraphs).
    await textW.setParameters({ tessedit_pageseg_mode: '11' as any, user_defined_dpi: '300' });
  }
  if (!digitW) {
    digitW = await createWorker('pol', 1, { cachePath });
    await digitW.setParameters({ tessedit_pageseg_mode: '11' as any, tessedit_char_whitelist: '0123456789,', user_defined_dpi: '300' });
  }
  if (!lineW) {
    lineW = await createWorker('pol', 1, { cachePath });
    await lineW.setParameters({ tessedit_pageseg_mode: '11' as any, tessedit_char_whitelist: '0123456789,', user_defined_dpi: '300' });
  }
  return { textW, digitW, lineW };
}
export async function closeOcr() {
  await textW?.terminate();
  await digitW?.terminate();
  await lineW?.terminate();
  textW = digitW = lineW = null;
}

/** Two binarised views: light text (white on colour) and dark text (black on light). */
async function masks(img: Buffer, targetWidth: number) {
  const base = sharp(img).removeAlpha();
  const meta = await base.metadata();
  const W = targetWidth;
  const scale = W / (meta.width ?? W);
  const { data, info } = await base.resize({ width: W }).raw().toBuffer({ resolveWithObject: true });
  const light = Buffer.alloc(info.width * info.height);
  const dark = Buffer.alloc(info.width * info.height);
  const red = Buffer.alloc(info.width * info.height);
  for (let i = 0, p = 0; i < data.length; i += info.channels, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    light[p] = max > 215 && max - min < 40 ? 0 : 255; // white-ish → ink
    dark[p] = max < 95 ? 0 : 255; // black-ish → ink
    red[p] = r > 150 && g < 90 && b < 90 ? 0 : 255; // red print on white boxes → ink
  }
  const png = (buf: Buffer) => sharp(buf, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  return { scale, light: await png(light), dark: await png(dark), red: await png(red) };
}

function parseTsv(tsv: string, scale: number, tag: string): Word[] {
  const out: Word[] = [];
  for (const row of tsv.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c[11].trim();
    if (!text) continue;
    out.push({
      text,
      x: +c[6] / scale, y: +c[7] / scale, w: +c[8] / scale, h: +c[9] / scale,
      conf: +c[10],
      line: `${tag}-${c[2]}-${c[3]}-${c[4]}`,
    });
  }
  return out;
}

/** Re-read one price tag: crop, scale the big digits to ~48 px, read symbol by symbol. */
async function refinePrice(img: Buffer, d: Word, ink: 'L' | 'D' | 'R'): Promise<number | null> {
  const meta = await sharp(img).metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  const left = Math.max(0, Math.round(d.x - d.h * 0.3)), top = Math.max(0, Math.round(d.y - d.h * 0.35));
  const width = Math.min(W - left, Math.round(d.w + d.h * 2.4)), height = Math.min(H - top, Math.round(d.h * 1.6));
  if (width < 8 || height < 8) return null;
  const { data, info } = await sharp(img).removeAlpha().extract({ left, top, width, height })
    .resize({ height: 80 }).raw().toBuffer({ resolveWithObject: true });
  const bin = Buffer.alloc(info.width * info.height);
  for (let i = 0, p = 0; i < data.length; i += info.channels, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2], max = Math.max(r, g, b), min = Math.min(r, g, b);
    const on = ink === 'L' ? max > 215 && max - min < 40 : ink === 'R' ? r > 150 && g < 90 && b < 90 : max < 95;
    bin[p] = on ? 0 : 255;
  }
  const png = await sharp(bin, { raw: { width: info.width, height: info.height, channels: 1 } })
    .extend({ top: 20, bottom: 20, left: 20, right: 20, background: { r: 255, g: 255, b: 255 } }).png().toBuffer();
  const { lineW } = await workers();
  const res = await lineW.recognize(png, {}, { blocks: true });
  const syms: { t: string; h: number; x: number; y: number }[] = [];
  for (const b of res.data.blocks ?? []) for (const pa of b.paragraphs) for (const l of pa.lines) for (const w of l.words)
    for (const sy of w.symbols) if (sy.confidence > 30) syms.push({ t: sy.text, h: sy.bbox.y1 - sy.bbox.y0, x: sy.bbox.x0, y: sy.bbox.y0 });
  if (!syms.length) return null;
  // Drop small print caught in the crop (e.g. "KAŻDA Z 2 SZTUK"): keep glyphs ≥ 35 % of the tallest.
  const tallest = Math.max(...syms.map((x) => x.h));
  syms.splice(0, syms.length, ...syms.filter((x) => x.h >= tallest * 0.35));
  syms.sort((a, b) => a.x - b.x);
  if (process.env.OCR_DEBUG) console.error('refine', d.text, Math.round(d.x), Math.round(d.y), Math.round(d.h), syms.map((x) => `${x.t}:${x.h}`).join(' '));
  const txt = syms.map((x) => x.t).join('');
  const m = txt.match(/(\d{1,3}),(\d{2})/);
  if (m) return +`${m[1]}.${m[2]}`;
  const digitsOnly = syms.filter((x) => /\d/.test(x.t));
  const maxH = Math.max(...digitsOnly.map((x) => x.h));
  const bigD = digitsOnly.filter((x) => x.h >= maxH * 0.72);
  const supD = digitsOnly.filter((x) => x.h < maxH * 0.72 && x.x > (bigD[bigD.length - 1]?.x ?? 0));
  if (bigD.length >= 1 && bigD.length <= 3 && supD.length === 2) return +`${bigD.map((x) => x.t).join('')}.${supD.map((x) => x.t).join('')}`;
  return null;
}

export async function readWords(img: Buffer): Promise<{ words: Word[]; digits: Word[] }> {
  const { textW, digitW } = await workers();
  // Small print reads best enlarged; big price digits read best shrunk (Tesseract likes ~30–50 px glyphs).
  const big = await masks(img, 2400);
  const small = await masks(img, 760);
  const words: Word[] = [];
  const digits: Word[] = [];
  for (const [tag, buf] of [['L', big.light], ['D', big.dark]] as const) {
    words.push(...parseTsv((await textW.recognize(buf, {}, { tsv: true })).data.tsv ?? '', big.scale, tag));
  }
  for (const [tag, buf] of [['L', small.light], ['D', small.dark]] as const) {
    digits.push(...parseTsv((await digitW.recognize(buf, {}, { tsv: true })).data.tsv ?? '', small.scale, tag + 'd'));
  }
  // Big digit groups → precise re-read; emitted as ready "x,yy" tokens.
  const pageW = (await sharp(img).metadata()).width ?? 1000;
  const refined: Word[] = [];
  for (const d of digits) {
    if (d.h < pageW * 0.025 || !/\d/.test(d.text)) continue;
    const v = await refinePrice(img, d, d.line[0] as 'L' | 'D' | 'R');
    if (v != null) refined.push({ ...d, text: v.toFixed(2).replace('.', ','), conf: 99, w: d.w + d.h * 0.8, line: d.line + '*' });
  }
  digits.push(...refined);
  return { words, digits };
}

// ── Interpretation ──────────────────────────────────────────────────────
const STOP = new Set(('tylko supercena hit sztuki sztuk szt kartą karta karte kartę lub apką apka apki aplikacją przy zakupie każda każdy taniej gratis limit dzienny cena ceny za przed obniżką obniżki poza promocją promocja moja biedronka mieszaj dowolnie najtańsze produkty od do teraz zapłacisz także blikiem rabat zostanie rozłożony proporcjonalnie na wszystkie promocyjne regularna najniższa dni oferta ważna wys cm kg zł szt. opak wybrane rodzaje różne rodz rodzaje').split(' '));
const LETTERS = /^[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż][A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż'’\-.,:%0-9/]*$/;

interface Line { key: string; words: Word[]; x: number; y: number; w: number; h: number; text: string }
/** Group words into lines by position: same baseline band and small horizontal gaps. */
function lines(words: Word[]): Line[] {
  const ws = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Word[][] = [];
  for (const w of ws) {
    const host = out.find((l) => {
      const last = l[l.length - 1];
      const sameBand = Math.abs((last.y + last.h / 2) - (w.y + w.h / 2)) < Math.max(last.h, w.h) * 0.45;
      const gap = w.x - (last.x + last.w);
      return sameBand && gap > -last.h * 0.5 && gap < Math.max(last.h, w.h) * 1.2 && Math.abs(last.h - w.h) < Math.max(last.h, w.h) * 0.6;
    });
    if (host) host.push(w); else out.push([w]);
  }
  return out.map((l, i) => {
    l.sort((a, b) => a.x - b.x);
    const x = Math.min(...l.map((w) => w.x)), y = Math.min(...l.map((w) => w.y));
    const x2 = Math.max(...l.map((w) => w.x + w.w)), y2 = Math.max(...l.map((w) => w.y + w.h));
    return { key: String(i), words: l, x, y, w: x2 - x, h: y2 - y, text: l.map((w) => w.text).join(' ') };
  });
}

interface Price { value: number; x: number; y: number; w: number; h: number; ctx: string; refined?: boolean }
let supMax = 0.75;
function prices(digits: Word[], textLines: Line[]): Price[] {
  const ds = digits.filter((d) => d.conf >= 40 && /\d/.test(d.text));
  const used = new Set<Word>();
  const out: Price[] = [];
  const lineAt = (x: number, y: number, h: number) =>
    textLines.filter((l) => Math.abs((l.y + l.h / 2) - y) < h && x >= l.x - h * 2 && x <= l.x + l.w + h * 2).map((l) => l.text).join(' ');
  for (const d of ds) {
    if (used.has(d)) continue;
    const t = d.text.replace(/[^\d,]/g, '');
    let m = t.match(/^(\d{1,3}),(\d{2})$/);
    if (m) { out.push({ value: +`${m[1]}.${m[2]}`, x: d.x, y: d.y, w: d.w, h: d.h, ctx: lineAt(d.x, d.y + d.h / 2, d.h), refined: d.line.endsWith('*') }); used.add(d); continue; }
    if (/^\d{1,3}$/.test(t)) {
      // Superscript cents: a 2-digit token, smaller, just right of and level with the top.
      const sup = ds.find((s) => !used.has(s) && s !== d && /^\d{2}$/.test(s.text.replace(/\D/g, '')) &&
        s.h < d.h * supMax && s.h > d.h * 0.2 && s.x >= d.x + d.w - d.h * 0.2 && s.x - (d.x + d.w) < d.h * 0.7 &&
        s.y >= d.y - d.h * 0.25 && s.y < d.y + d.h * 0.45);
      if (sup) {
        out.push({ value: +`${t}.${sup.text.replace(/\D/g, '')}`, x: d.x, y: d.y, w: sup.x + sup.w - d.x, h: d.h, ctx: lineAt(d.x, d.y + d.h / 2, d.h) });
        used.add(d); used.add(sup);
      }
    }
  }
  const ok = out.filter((p) => p.value > 0.2 && p.value < 5000);
  // Same spot read twice (e.g. "6,99" vs "69,98"): keep the precise re-read / first one.
  const kept: Price[] = [];
  for (const p of ok.sort((a, b) => Number(b.refined) - Number(a.refined))) {
    if (!kept.some((k) => Math.abs(k.x - p.x) < k.h * 0.8 && Math.abs(k.y - p.y) < k.h * 0.8)) kept.push(p);
  }
  return kept;
}

const isDate = (t: string) => /PONIEDZ|WTOREK|ŚROD|CZWART|PIĄT|SOBOT|NIEDZ|\d{1,2}\.\d{1,2}\s*[-–]\s*\d{1,2}\.\d{1,2}/i.test(t);
const isRef = (t: string) => /przed|obniż|poza|regularn|najniższ|\/kg|zł\/|\/l\b|\/szt|=\s*1|1\s*szt\.?\s*=|\(=/i.test(t);

export type NameSide = 'left' | 'right';
export function interpret(words: Word[], digits: Word[], pageW: number, side: NameSide = 'left'): PageDeal[] {
  const good = words.filter((w) => w.conf >= 55);
  const ls = lines(good);
  const ps = prices(digits, lines(words.filter((w) => w.conf >= 30)));
  if (!ps.length) return [];
  const maxH = Math.max(...ps.map((p) => p.h));
  if (process.env.OCR_DEBUG) console.error('prices', ps.map((p) => `${p.value}@${Math.round(p.x)},${Math.round(p.y)} h${Math.round(p.h)} [${p.ctx.slice(0, 40)}]`));
  const main = ps.filter((p) => p.h >= Math.max(maxH * 0.45, pageW * 0.025) && !isRef(p.ctx) && !isDate(p.ctx));
  const refs = ps.filter((p) => isRef(p.ctx) || p.h < maxH * 0.45);
  const nameLines = ls.filter((l) => {
    const ws = l.words.filter((w) => LETTERS.test(w.text) && w.text.length >= 3 && !STOP.has(w.text.toLowerCase().replace(/[.,:]$/, '')));
    const brandNoise = /KART|APK|MOJA|BIEDRON|MIESZAJ|DOWOLN|SUPERCEN|TANIEJ|GRATIS|ZAKUPIE|SZTUK|LIMIT|PONIEDZ|SOBOT|^DRUGI|NISKIE CENY|^ZAWSZE|^KUP\b/i;
    return ws.length >= 1 && ws.reduce((a, w) => a + w.text.length, 0) >= 4 && !isRef(l.text) && !/^\d/.test(l.text) && !brandNoise.test(l.text);
  });
  const nearText = (p: { x: number; y: number }, r: number) => ls.filter((l) => Math.abs(l.y - p.y) < r && Math.abs(l.x - p.x) < r * 1.6).map((l) => l.text).join(' ');

  if (process.env.OCR_DEBUG) console.error('names', nameLines.map((l) => `${l.text}@${Math.round(l.x)},${Math.round(l.y)}`).slice(0, 30));
  const deals: PageDeal[] = [];
  for (const p of main) {
    const R = Math.max(p.h * 4, pageW * 0.22);
    // Name: closest qualifying lines in the price's neighbourhood (above or beside it).
    const cands = nameLines
      .map((l) => {
        const dx = (l.x + l.w / 2) - (p.x + p.w / 2), dy = (l.y + l.h / 2) - (p.y + p.h / 2);
        // Names sit left of or above their price tag; text to the right/below usually belongs elsewhere.
        const wrongSide = side === 'left' ? l.x > p.x + p.w * 0.6 : l.x + l.w < p.x + p.w * 0.4;
        const penalty = (wrongSide ? R * 0.35 : 0) + (dy > p.h * 0.8 ? R * 0.25 : 0);
        // Titles are set larger than variant labels and small print: prefer taller text.
        return { l, d: Math.hypot(dx, dy) + penalty - l.h * 4 };
      })
      .filter(({ l, d }) => d < R && l.y < p.y + p.h * 1.6)
      .sort((a, b) => a.d - b.d);
    if (!cands.length) continue;
    const anchor = cands[0].l;
    const isSize = (t: string) => /^(dł|wym|wys|szer|gł|poj)\.?\b|\b\d+\s*(cm|mm|m)\b|\(=|=\s*1/i.test(t);
    const pool = nameLines.concat(ls.filter((l) => /^(różne|z |w |o |dla |bez )/i.test(l.text)));
    const aligned = (l: Line) => Math.abs(l.x - anchor.x) < anchor.h * 1.8;
    const block: Line[] = [anchor];
    for (const dir of [-1, 1]) {
      let edge = anchor;
      for (;;) {
        const next = pool
          .filter((l) => !block.includes(l) && aligned(l) && !isSize(l.text))
          .filter((l) => dir < 0 ? l.y + l.h <= edge.y + edge.h * 0.2 && edge.y - (l.y + l.h) < Math.max(edge.h, l.h) * 1.1
                                 : l.y >= edge.y + edge.h * 0.8 && l.y - (edge.y + edge.h) < Math.max(edge.h, l.h) * 1.1)
          .sort((a, b) => Math.abs(a.y - edge.y) - Math.abs(b.y - edge.y))[0];
        if (!next || block.length >= 4) break;
        block.push(next);
        edge = next;
      }
    }
    block.sort((a, b) => a.y - b.y);
    const name = block.map((l) => l.text).join(' ').replace(/\s+/g, ' ').replace(/[|_~]+/g, '').trim();
    if (name.replace(/[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/g, '').length < 5) continue;
    // A real product name has at least one word that isn't just a description.
    const DESC = /^(kolory|kolor|rodzaje|rodzaj|rodz|wzory|wzór|różne|różny|zielony|biały|czarny|wybrane|smaki|warianty|sztuki|szt)\.?,?$/i;
    if (!name.split(/\s+/).some((w) => w.length >= 4 && !DESC.test(w) && /[a-ząćęłńóśźż]{3}/i.test(w))) continue;

    const ctx = nearText(p, R);
    const old = refs
      .filter((r) => /przed|obniż|poza|regularn|cena za/i.test(r.ctx + ' ' + nearText(r, r.h * 3)) && Math.hypot(r.x - p.x, r.y - p.y) < R * 1.3 && r.value > p.value)
      .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    const unit = refs.find((r) => /\/kg|zł\/kg/i.test(r.ctx) && Math.hypot(r.x - p.x, r.y - p.y) < R);
    const pct = ctx.match(/(\d{1,2})\s*%\s*TANIEJ/i)?.[1];
    const nn = ctx.match(/(\d)\s*\+\s*(\d)\s*(GRATIS)?/i);
    const minQty = ctx.match(/PRZY\s+ZAKUPIE\s+(\d)/i)?.[1] ?? ctx.match(/KAŻD[AY]\s+Z\s+(\d)/i)?.[1];
    const limit = ctx.match(/Limit\s+dzienny\s+(\d+)/i)?.[1];
    deals.push({
      name,
      price: p.value,
      oldPrice: old?.value,
      card: /KART|APK/i.test(ctx) || undefined,
      multibuy: nn ? `${nn[1]}+${nn[2]}${nn[3] ? ' gratis' : ''}` : pct ? `-${pct}%` : undefined,
      minQty: minQty ? +minQty : undefined,
      limit: limit ? +limit : undefined,
      unitPrice: unit?.value,
      unit: unit ? 'kg' : undefined,
    });
  }
  // One deal per (name, price).
  const seen = new Set<string>();
  return deals.filter((d) => !seen.has(`${d.name}|${d.price}`) && !!seen.add(`${d.name}|${d.price}`));
}

/** PaddleOCR output (one box per text line) → the word/digit boxes interpret() expects. */
export interface PaddleLine { text: string; box: [number, number, number, number]; conf: number }
export function interpretPaddle(lines: PaddleLine[], pageW: number, side: NameSide = 'left'): PageDeal[] {
  const words: Word[] = [];
  const digits: Word[] = [];
  const perKg = new Set<number>();
  lines.forEach((l, i) => {
    const [x, y, w, h] = l.box;
    const conf = Math.round(l.conf * 100);
    let t = l.text.trim().replace(/^(\d{3,4})\/$/, '$1');
    if (!t) return;
    // Big shelf prices come out as one run of digits ("1499" = 14,99 zł; "999" = 9,99 zł),
    // since the grosze are printed as superscript.
    if (/^\d{3,4}$/.test(t) && h > pageW * 0.045) {
      t = `${t.slice(0, -2)},${t.slice(-2)}`;
      const unit = lines.find((u) => /^\/\s*kg$/i.test(u.text.trim()) && u.box[0] >= x + w * 0.6 && u.box[0] < x + w + h && Math.abs(u.box[1] + u.box[3] - (y + h)) < h * 0.5);
      if (unit) perKg.add(Number(t.replace(',', '.')));
    }
    if (/^\d{1,3}(,\d{2})?$/.test(t)) {
      digits.push({ text: t, x, y, w, h, conf, line: `P${i}` });
      return;
    }
    // A bare unit mark beside a big price ("/kg", "/szt.") belongs to that price; as a word
    // it would make the price look like a small per-unit reference.
    if (/^\/\s*(kg|szt\.?|zł|op\.?)$/i.test(t)) return;
    // Spread the line's words across its box in proportion to their length.
    const parts = t.split(/\s+/).filter(Boolean);
    const total = parts.reduce((a, p) => a + p.length + 1, 0) || 1;
    let cx = x;
    for (const p of parts) {
      const pw = (w * (p.length + 1)) / total;
      words.push({ text: p, x: cx, y, w: pw, h, conf, line: `P${i}` });
      cx += pw;
    }
  });
  supMax = 0.95;
  try {
    // Per-unit references read this way are unreliable; keep only per-kg shelf prices.
    return interpret(words, digits, pageW, side).map((d) => (perKg.has(d.price) ? { ...d, unit: 'kg', unitPrice: d.price } : { ...d, unit: undefined, unitPrice: undefined }));
  } finally {
    supMax = 0.75;
  }
}

export async function readPage(img: Buffer, side: NameSide = 'left'): Promise<PageDeal[]> {
  const meta = await sharp(img).metadata();
  const { words, digits } = await readWords(img);
  return interpret(words, digits, meta.width ?? 1000, side);
}
