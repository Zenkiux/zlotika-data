import type { Source } from '../types.ts';
import { aldi } from './aldi.ts';
import { lidl } from './lidl.ts';
import { rossmann } from './rossmann.ts';

// Chains with shops in/near Suwałki whose public pages serve structured data.
// Blocked sites (Kaufland, Carrefour, Action, Hebe) are intentionally absent.
// Biedronka publishes leaflet images only (needs OCR — later).
export const sources: Source[] = [aldi, rossmann, lidl];
