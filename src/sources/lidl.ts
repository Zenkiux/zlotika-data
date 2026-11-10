import { getText } from '../http.ts';
import type { Deal, Source } from '../types.ts';

// Lidl category pages (/h/…) embed product tiles as JSON in data-grid-data.
// robots.txt forbids offset paging, so we read only what each page serves.
const FALLBACK = ['/h/owoce-i-warzywa/h10071012', '/h/mieso-i-drob/h10095752', '/h/napoje/h10071022', '/h/piekarnia/h10096086'];
const MAX_PAGES = 14;
const day = (unix?: number) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : undefined);
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export const lidl: Source = {
  chain: 'lidl',
  async collect() {
    const home = await getText('https://www.lidl.pl/');
    const found = [...new Set([...home.matchAll(/href="(\/h\/[a-z0-9-]+\/h\d+)"/g)].map((m) => m[1]))];
    const paths = [...new Set([...FALLBACK, ...found])].slice(0, MAX_PAGES);
    const out: Deal[] = [];
    for (const path of paths) {
      let html: string;
      try { html = await getText(`https://www.lidl.pl${path}`); } catch { continue; }
      for (const m of html.matchAll(/data-grid-data="([^"]+)"/g)) {
        let p: any;
        try { p = JSON.parse(unescape(m[1])); } catch { continue; }
        const pr = p.price ?? {};
        const plus = (p.lidlPlus ?? [])[0];
        // Lidl Plus text, e.g. "Cena poza promocją: 5,99/szt. Cena za 1 szt. przy zakupie 2 szt.: 2,99/szt. Limit: 3 szt. …"
        const cond: string = plus?.price?.basePrice?.text ?? '';
        const num = (s?: string) => (s ? parseFloat(s.replace(',', '.')) : undefined);
        const plusUnit = num(cond.match(/przy zakupie\s+\d+\s+szt\.?:\s*([\d,]+)/i)?.[1]);
        const minQty = num(cond.match(/przy zakupie\s+(\d+)\s+szt/i)?.[1]);
        const limit = num(cond.match(/Limit:\s*(\d+)/i)?.[1]);
        const regular = plus?.price?.price ?? pr.oldPrice;
        // "-33%" coupons: the shown price is the regular one ("Cena poza promocją").
        const pct = num(String(plus?.highlightText ?? '').match(/-\s*(\d+)\s*%/)?.[1]);
        const shownIsRegular = /poza promocj/i.test(plus?.price?.prefix ?? cond);
        const couponPrice = pct && shownIsRegular && regular ? Math.round(regular * (100 - pct)) / 100 : undefined;
        const price = plus ? (plusUnit ?? couponPrice ?? plus.price?.price) : pr.price;
        if (!(price > 0)) continue;
        out.push({
          id: `lidl-${p.productId}`,
          chain: 'lidl',
          name: p.fullTitle,
          price,
          oldPrice: plus ? (plusUnit || couponPrice ? regular : undefined) : (pr.oldPrice ?? pr.discount?.deletedPrice),
          unit: pr.packaging?.text,
          card: plus ? true : undefined,
          multibuy: plus?.highlightText || undefined,
          minQty: minQty && minQty > 1 ? minQty : undefined,
          limit,
          validFrom: day(p.storeStartDate),
          validTo: day(p.storeEndDate),
          imageUrl: p.image,
          url: p.canonicalUrl ? `https://www.lidl.pl${p.canonicalUrl}` : undefined,
          category: p.category,
        });
      }
    }
    return out;
  },
};
