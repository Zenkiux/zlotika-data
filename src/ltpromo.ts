// Lithuanian chains with no online shop: Lidl LT, IKI and Norfa.
// Lidl LT: the same /h/ category pages as lidl.pl (product tiles as JSON).
// IKI and Norfa: this week's leaflet PDFs, which carry a real text layer — every product
// line ends with its price per kg / l / piece ("…, 200 g, 5,95 Eur/kg"), so no OCR is needed.
// These are promotion prices, so the app labels them as "this week's leaflet".
import { get, getText } from './http.ts';
import { fold, ltQty, summarise, terms, tweakFor, words, type Product, type RefPrice } from './prices.ts';

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const num = (s: string) => parseFloat(s.replace(/\s/g, '').replace(',', '.'));
const units: Record<string, string> = { kg: 'kg', l: 'l', vnt: 'units' };

// ── Lidl LT ───────────────────────────────────────────────────────────────
export async function lidlLtProducts(maxPages = 16): Promise<Product[]> {
  const home = await getText('https://www.lidl.lt/', { headers: { 'Accept-Language': 'lt' } });
  const paths = [...new Set([...home.matchAll(/href="(\/h\/[a-z0-9-]+\/h\d+)"/g)].map((m) => m[1]))].slice(0, maxPages);
  const out: Product[] = [];
  for (const path of paths) {
    let html: string;
    try { html = await getText(`https://www.lidl.lt${path}`, { headers: { 'Accept-Language': 'lt' } }); } catch { continue; }
    for (const m of html.matchAll(/data-grid-data="([^"]+)"/g)) {
      let p: any;
      try { p = JSON.parse(unescape(m[1])); } catch { continue; }
      const pr = p.price ?? {};
      // Lidl Plus card-only prices are left out: the shelf price is what everyone pays.
      if (!(pr.price > 0) || (p.lidlPlus ?? []).length) continue;
      // "1 kg = 29,90 €" when given, else from the package size ("1 kg", "130 g").
      const bp = String(pr.basePrice?.text ?? '').match(/1\s*(kg|l|vnt)\.?\s*=\s*([\d\s]+,\d+)/i);
      const q = ltQty(String(pr.packaging?.text ?? ''));
      const unit = bp ? units[bp[1].toLowerCase()] : q?.unit ?? null;
      const unitPrice = bp ? num(bp[2]) : q ? Math.round((pr.price / q.qty) * 100) / 100 : null;
      out.push({
        name: `${p.fullTitle}${pr.packaging?.text ? `, ${pr.packaging.text}` : ''}`,
        price: pr.price,
        unitPrice,
        unit,
        category: 'lidl-lt',
        url: p.canonicalUrl ? `https://www.lidl.lt${p.canonicalUrl}` : 'https://www.lidl.lt/',
      });
    }
  }
  return out;
}

// ── Leaflet PDFs (IKI, Norfa) ─────────────────────────────────────────────
const UNIT_PRICE = /(\d+[.,]\d{2})\s*(?:Eur|€)\s*\/\s*(kg|l|vnt)\.?\*?/i;
// Lines that are prices, badges or decoration, not part of a product name.
const SIZE_END = /\d\s*(g|kg|ml|l|vnt|tabl|pak)\.?(\/pak\.?)?[,.]?\s*(\d+\s*rūšių\)?|\p{L}+)?$/iu;
const SIZE_START = /^(\d|x\s|\()/i;
const NOISE = /^(tik|nuo|iki|ir|-?\d+\s*%|[\d\s.,*]+|eur|€|\d+\s*\+\s*\d+|su kortele|ir iki express|kaina|sutaupote.*)$/i;

// Leaflet furniture that ends up glued to product names.
const clean = (s: string) =>
  s.replace(/\d*\s*PIRKITE\s+lastmile\.lt\s+ir\s+iki\.lt/gi, ' ')
    .replace(/^.*?(?:Įprasta|Iprasta)\s+kaina\s*/i, '')
    .replace(/^[\d\s.,*%-]+(?=\p{L})/u, '')
    .replace(/(\p{L})- (\p{L})/gu, '$1$2') // hyphenated line breaks: "alyvuo- gių"
    .replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim();

/** Product lines from a leaflet's page texts: name lines up to and including "X,XX Eur/kg". */
export function leafletProducts(pages: string[], url: string, category: string): Product[] {
  const out: Product[] = [];
  pages.forEach((text, pi) => {
    let buf: string[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (!line || NOISE.test(line)) { buf = []; continue; }
      const m = line.match(UNIT_PRICE);
      if (!m) { buf.push(line); if (buf.length > 6) buf.shift(); continue; }
      // A size followed by more text means the previous product ended there ("…, 1 kg" + next name).
      const parts = [...buf, line.slice(0, m.index)];
      let start = 0;
      parts.forEach((x, i) => { if (i < parts.length - 1 && SIZE_END.test(x) && /^\p{L}/u.test(parts[i + 1]) && !SIZE_START.test(parts[i + 1])) start = i + 1; });
      const name = clean(parts.slice(start).join(' '));
      buf = [];
      const unit = units[m[2].toLowerCase()];
      const unitPrice = num(m[1]);
      const q = ltQty(name);
      if (name.length < 6 || !(unitPrice > 0)) continue;
      // Package price from its size; a leaflet with no size gives the unit price for one unit.
      const price = q && q.unit === unit ? Math.round(unitPrice * q.qty * 100) / 100 : unitPrice;
      out.push({ name, price, unitPrice, unit, category, url: `${url}#page=${pi + 1}` });
    }
  });
  return out;
}

async function pdfPages(url: string): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const buf = new Uint8Array(await (await get(url, { accept: 'application/pdf', timeoutMs: 180000 })).arrayBuffer());
  const { text } = await extractText(await getDocumentProxy(buf), { mergePages: false });
  return text as unknown as string[];
}

const NOT_LEAFLET = /tvark|politik|taisykl|privatum|salyg|sąlyg/i;

export async function ikiProducts(): Promise<Product[]> {
  const list = await getText('https://iki.lt/leidiniai/', { headers: { 'Accept-Language': 'lt' } });
  // The weekly price leaflet ("IKI kainų leidinys Nr. 47") — newest number first.
  const pages = [...new Set([...list.matchAll(/https:\/\/iki\.lt\/leidiniai\/iki-kainu-leidinys-nr-(\d+)\//g)].map((m) => m[0]))]
    .sort((a, b) => Number(b.match(/nr-(\d+)/)![1]) - Number(a.match(/nr-(\d+)/)![1]))
    .slice(0, 1);
  const pdfs = new Set<string>();
  for (const p of pages) {
    const html = await getText(p, { headers: { 'Accept-Language': 'lt' } });
    for (const m of html.matchAll(/https:\/\/iki\.lt\/wp-content\/uploads\/[^"' ]+\.pdf/g)) if (!NOT_LEAFLET.test(m[0])) pdfs.add(m[0]);
  }
  const out: Product[] = [];
  for (const u of pdfs) out.push(...leafletProducts(await pdfPages(u), u, 'iki'));
  return out;
}

export async function norfaProducts(): Promise<Product[]> {
  const html = await getText('https://www.norfa.lt/leidiniai/', { headers: { 'Accept-Language': 'lt' } });
  const pdfs = [...new Set([...html.matchAll(/(?:https:\/\/www\.norfa\.lt\/)?assets\/Uploads\/PublicationsFiles\/[^"' ]+\.pdf/g)]
    .map((m) => (m[0].startsWith('http') ? m[0] : `https://www.norfa.lt/${m[0]}`)))].filter((u) => !NOT_LEAFLET.test(u));
  const out: Product[] = [];
  for (const u of pdfs) out.push(...leafletProducts(await pdfPages(u), u, 'norfa'));
  return out;
}

/**
 * Leaflets have no categories to fall back on, so matching is strict: every word of the
 * term in exactly that form ("pienas", not "pieno sūris" or "pieniškos dešrelės"), and the
 * first one not right after "su/be" ("batonas su … sviestu").
 */
const READY_MEAL = ['sefai', 'kept', 'patiek', 'salot', 'nealkohol'];
// Per item: products that share the word but aren't the thing (minced pork-beef for "beef").
const PROMO_NOT: Record<string, string[]> = { 'Wołowina': ['kiaulien', 'smulk', 'malt'], 'Makaron': ['saldyt', 'krevet'] };

export function promoMatches(query: string, products: Product[], not: string[] = []): Product[] {
  const keys = words(query).filter((w) => w.length >= 3);
  const nots = not.map(fold);
  if (!keys.length) return [];
  return products.filter((p) => {
    const ws = words(p.name);
    if (ws.some((w) => nots.some((n) => w.startsWith(n)))) return false;
    return keys.every((k, ki) => ws.some((w, i) => w === k && (ki > 0 || !['su', 'be', 'skonio'].includes(ws[i - 1] ?? ''))));
  });
}

/** Vocabulary item → this week's price at one chain (one product is enough: it's a promo, not a "usual" price).
 *  Kept only where it agrees with Maxima's usual price on unit and level. */
export function promoRefs(source: string, products: Product[], base: Record<string, RefPrice>): Record<string, RefPrice> {
  const out: Record<string, RefPrice> = {};
  for (const t of terms) {
    const tw = tweakFor(t);
    if (tw.skip) continue;
    const ref = summarise(source, promoMatches(tw.lt ?? t.lt, products, [...(tw.not ?? []), ...READY_MEAL, ...(PROMO_NOT[t.pl] ?? [])]), false, 1);
    const b = base[t.pl];
    // A promo is near or below the usual price; far above it means a premium variant
    // (buffalo mozzarella for "cheese", olive oil for "oil"), not the everyday product.
    if (ref && b && ref.unit === b.unit && ref.unitMedian <= b.unitMedian * 1.3 && ref.unitMedian >= b.unitMedian * 0.35) out[t.pl] = ref;
  }
  return out;
}
