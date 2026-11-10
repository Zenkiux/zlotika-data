import { getText } from '../http.ts';
import type { Deal, Source } from '../types.ts';

// aldi.pl/oferty is a Next.js page; offers sit in __NEXT_DATA__ → pageProps.apiData.
const PAGES = ['https://www.aldi.pl/oferty.html', 'https://www.aldi.pl/oferty-kolejny-tydzien.html'];
const day = (unix?: number) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : undefined);

function multibuyFrom(text?: string) {
  if (!text) return undefined;
  const t = text.toUpperCase();
  return /DRUG|\d\s*\+\s*\d|PRZY ZAKUPIE|SZT\./.test(t) ? text : undefined;
}

export const aldi: Source = {
  chain: 'aldi',
  async collect() {
    const out: Deal[] = [];
    for (const url of PAGES) {
      const html = await getText(url);
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) continue;
      const next = JSON.parse(m[1]);
      let api = next?.props?.pageProps?.apiData;
      if (typeof api === 'string') api = JSON.parse(api);
      for (const block of api ?? []) {
        const map = block?.[1]?.res?.algoliaDataMap ?? {};
        for (const [id, p] of Object.entries<any>(map)) {
          const promo = (p.promotionPrices ?? [])[0] ?? p.currentPrice;
          if (!promo?.priceValue) continue;
          const base = promo.basePrice?.[0];
          out.push({
            id: `aldi-${id}-${promo.validFrom ?? ''}`,
            chain: 'aldi',
            name: [p.brandName && p.brandName !== p.name ? p.brandName : null, p.name, p.shortDescription].filter(Boolean).join(' · '),
            price: promo.priceValue,
            oldPrice: promo.strikePrice?.strikePriceValue,
            unit: base?.basePriceScale,
            unitPrice: base?.basePriceValue,
            multibuy: multibuyFrom(promo.priceTagLabels?.promoText1),
            validFrom: promo.validFromLocalDate ?? day(promo.validFrom),
            validTo: promo.validUntilLocalDate ?? day(promo.validUntil),
            imageUrl: p.assets?.find((a: any) => a.type === 'primary')?.url,
            url,
          });
        }
      }
    }
    return out;
  },
};
