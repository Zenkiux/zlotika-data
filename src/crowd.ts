// Prices shoppers photographed on shelf tags or receipts, from Open Prices (Open Food
// Facts, open data under ODbL — attribution: "Open Prices, Open Food Facts contributors").
// Zlotika users can add to it from the app; everyone, including us, reads it back here.
import { getJson } from './http.ts';
import type { Deal } from './types.ts';

const API = 'https://prices.openfoodfacts.org/api/v1/prices';
const TOWNS = [
  { name: 'suwalki', lat: 54.1115, lon: 22.9308, km: 12 },
  { name: 'augustow', lat: 53.8436, lon: 22.9796, km: 10 },
  { name: 'sejny', lat: 54.1093, lon: 23.3463, km: 8 },
  { name: 'bialystok', lat: 53.1325, lon: 23.1688, km: 15 },
];
const CHAINS = ['biedronka', 'lidl', 'kaufland', 'aldi', 'netto', 'dino', 'auchan', 'carrefour', 'rossmann', 'hebe', 'pepco', 'action'];

export function chainOf(osmBrand?: string | null, osmName?: string | null): string | undefined {
  const s = `${osmBrand ?? ''} ${osmName ?? ''}`.toLowerCase();
  return CHAINS.find((c) => s.includes(c));
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => day(new Date(Date.parse(iso) + n * 864e5));

export async function collectCrowd(): Promise<Deal[]> {
  const since = day(new Date(Date.now() - 120 * 864e5));
  const out: Deal[] = [];
  const seen = new Set<number>();
  for (const t of TOWNS) {
    for (let page = 1; page <= 5; page++) {
      const r = await getJson<any>(`${API}?currency=PLN&lat=${t.lat}&lon=${t.lon}&radius_km=${t.km}&date__gte=${since}&order_by=-date&size=100&page=${page}`);
      for (const p of r.items ?? []) {
        if (seen.has(p.id) || p.duplicate_of) continue;
        seen.add(p.id);
        const chain = chainOf(p.location?.osm_brand, p.location?.osm_name);
        const name = [p.product?.product_name, p.product?.product_quantity ? `${p.product.product_quantity} ${p.product.product_quantity_unit ?? ''}`.trim() : null]
          .filter(Boolean).join(', ') || p.product_name || p.category_tag?.replace(/^\w+:/, '');
        if (!chain || !name || !(p.price > 0)) continue;
        out.push({
          id: `op-${p.id}`,
          chain,
          name,
          price: p.price,
          oldPrice: p.price_without_discount ?? undefined,
          validFrom: p.date,
          // A photographed price ages: promotions for a week, regular prices for two months.
          validTo: addDays(p.date, p.price_is_discounted ? 7 : 60),
          url: `https://prices.openfoodfacts.org/prices/${p.id}`,
          crowd: true,
          barcode: p.product_code ?? undefined,
        });
      }
      if (page >= (r.pages ?? 1)) break;
    }
  }
  return out;
}
