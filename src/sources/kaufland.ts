import { listKaufland, ocrLeaflets } from '../leaflets.ts';
import type { Source } from '../types.ts';

// kaufland.pl blocks bots — never touched. Leaflets come from the Schwarz leaflet
// platform (shared with Lidl), which answers normally. Pages are images → OCR.
export const kaufland: Source = {
  chain: 'kaufland',
  collect: async () => ocrLeaflets(await listKaufland(), 'left', 70),
};
