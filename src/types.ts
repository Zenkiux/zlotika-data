/** Matches lib/services/deals.dart in the app. */
export interface Deal {
  id: string;
  chain: string;
  name: string; // original Polish text
  price: number; // zł
  oldPrice?: number;
  unit?: string;
  unitPrice?: number;
  card?: boolean;
  multibuy?: string;
  minQty?: number;
  limit?: number;
  validFrom?: string; // yyyy-mm-dd
  validTo?: string;
  imageUrl?: string;
  url?: string;
  category?: string;
}

export interface Source {
  chain: string;
  collect(): Promise<Deal[]>;
}
