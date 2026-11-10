import type { Source } from '../types.ts';
import { aldi } from './aldi.ts';
import { biedronka } from './biedronka.ts';
import { kaufland } from './kaufland.ts';
import { lidl } from './lidl.ts';
import { rossmann } from './rossmann.ts';

// Structured sources first; leaflet-image (OCR) sources after.
// Sites that block bots (kaufland.pl itself, Carrefour, Action, Hebe) are never fetched.
export const sources: Source[] = [aldi, rossmann, lidl, kaufland, biedronka];
