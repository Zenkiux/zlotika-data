import { getJson } from '../http.ts';
import type { Deal, Source } from '../types.ts';

// Rossmann's own product API, filtered to promotions. ~8 500 items nationally;
// we take the first pages (the site's default promo ordering) to keep the feed small.
const PAGES = 8;
const SIZE = 96;

export const rossmann: Source = {
  chain: 'rossmann',
  async collect() {
    const out: Deal[] = [];
    for (let page = 1; page <= PAGES; page++) {
      const r = await getJson<any>(`https://www.rossmann.pl/products/v3/api/Products?Page=${page}&PageSize=${SIZE}&Statuses=promotion`);
      const items: any[] = r?.data?.products ?? [];
      for (const p of items) {
        if (!(p.price > 0)) continue;
        // name is often empty; fallbackName then repeats the start of caption.
        const main = p.name?.trim() ? `${p.name.trim()} ${p.caption ?? ''}` : (p.caption || p.fallbackName || '');
        const title = [p.brand, main].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        const type: string | undefined = p.promotion?.type;
        out.push({
          id: `rossmann-${p.id}`,
          chain: 'rossmann',
          name: title,
          price: p.price,
          oldPrice: p.oldPrice ?? undefined,
          unit: p.unit,
          // "rossmann"-type promotions are tied to the Rossmann Club app (unconfirmed; shown as card-needed).
          card: type === 'rossmann' ? true : undefined,
          validFrom: p.promotionFrom?.slice(0, 10),
          validTo: p.promotionTo?.slice(0, 10),
          imageUrl: p.pictures?.[0]?.medium,
          url: p.navigateUrl ? `https://www.rossmann.pl${p.navigateUrl}` : undefined,
          category: 'hygiene',
        });
      }
      if (page >= (r?.data?.totalPages ?? 1)) break;
    }
    return out;
  },
};
