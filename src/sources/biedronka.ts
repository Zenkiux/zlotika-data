import { listBiedronka, ocrLeaflets } from '../leaflets.ts';
import type { Source } from '../types.ts';

// Biedronka publishes leaflets as page images → OCR (food leaflets first).
export const biedronka: Source = {
  chain: 'biedronka',
  collect: async () => ocrLeaflets(await listBiedronka(), 'right', 70, /oferta|okazje|codziennie|festiwal|nabia|ceny/i),
};
