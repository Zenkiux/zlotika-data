// Translates the already published deals.json in out/ (used by the quick translate workflow).
import { readFileSync, writeFileSync } from 'node:fs';
import { translateDeals } from './translate.ts';

const path = new URL('../out/deals.json', import.meta.url);
const feed = JSON.parse(readFileSync(path, 'utf8'));
await translateDeals(feed.deals);
const n = feed.deals.filter((d: { nameLt?: string }) => d.nameLt).length;
console.log(`✓ ${n} of ${feed.deals.length} deals have Lithuanian names`);
writeFileSync(path, JSON.stringify(feed));
