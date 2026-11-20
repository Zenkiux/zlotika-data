// Translates Polish deal names into short Lithuanian and English shopper names with Gemini
// (free tier, GEMINI_API_KEY). Each Polish name is translated once and kept in
// out/translations.json, published with the feed, so a daily run only sends new names.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { modelList } from './vision.ts';
import { terms } from './prices.ts';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const KEY = process.env.GEMINI_API_KEY ?? '';
const cacheUrl = new URL('../out/translations.json', import.meta.url);
type Tr = { lt: string; en: string; term?: string }; // term = the app's shopping word (terms.json pl) or ''
let cache: Record<string, Tr> = {};
try {
  if (existsSync(cacheUrl)) cache = JSON.parse(readFileSync(cacheUrl, 'utf8'));
} catch { /* start empty */ }

const PROMPT = `You translate Polish supermarket product names for Lithuanian shoppers in Poland.
For each input give:
- lt: a short, natural Lithuanian name a shopper understands (what the product is + brand + size if present), e.g. "Kava malta Dallmayr Classic, 500 g".
- en: the same in English.
Rules: keep brand names as they are; translate the product type; keep sizes/quantities (g, kg, ml, l, szt. → vnt./pcs);
drop leaflet noise like "Cena za 1 szt.", "promocja", "-40%"; never invent details that are not in the input.
- term: if the product IS one of these everyday shopping items, copy that item's text exactly; otherwise "".
  Only the item itself counts: a toy "Jajko niespodzianka" is not "Jajka"; "Chleb z masłem" is not "Masło"; chocolate milk drink is not "Mleko".
  Items: ${JSON.stringify(terms.map((t) => t.pl))}
Return one object per input, in the same order, with the field "pl" equal to the input text.`;

const SCHEMA = {
  type: 'ARRAY',
  items: { type: 'OBJECT', properties: { pl: { type: 'STRING' }, lt: { type: 'STRING' }, en: { type: 'STRING' }, term: { type: 'STRING' } }, required: ['pl', 'lt', 'en', 'term'] },
};

async function translateBatch(names: string[]): Promise<boolean> {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: `${PROMPT}\n\nInputs (JSON):\n${JSON.stringify(names)}` }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
  });
  for (const m of await modelList()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${API}/${m}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
          body,
          signal: AbortSignal.timeout(120000),
        });
      } catch {
        continue;
      }
      if (res.status === 429) break; // this model's free quota is used up: next model
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 8000));
        continue;
      }
      if (!res.ok) return false;
      try {
        const j: any = await res.json();
        const text = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '[]';
        const out = JSON.parse(text) as { pl: string; lt: string; en: string; term?: string }[];
        const known = new Set(terms.map((t) => t.pl));
        out.forEach((o, i) => {
          const pl = names.includes(o.pl) ? o.pl : names[i];
          if (pl && o.lt?.trim() && o.en?.trim()) cache[pl] = { lt: o.lt.trim(), en: o.en.trim(), term: known.has(o.term ?? '') ? o.term : '' };
        });
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

/** Adds nameLt / nameEn to every deal whose Polish name has (or gets) a translation. */
export async function translateDeals(deals: { name: string; nameLt?: string; nameEn?: string; term?: string }[], log = console.log): Promise<void> {
  const todo = [...new Set(deals.map((d) => d.name))].filter((n) => !cache[n] || cache[n].term === undefined);
  if (KEY && todo.length) {
    const max = Number(process.env.TRANSLATE_MAX ?? 4000);
    const list = todo.slice(0, max);
    let ok = 0;
    for (let i = 0; i < list.length; i += 60) {
      if (await translateBatch(list.slice(i, i + 60))) ok++;
      else break; // quota or outage: keep what we have, try again tomorrow
      await new Promise((r) => setTimeout(r, 4500)); // stay under the free per-minute limit
    }
    log(`  ✓ translations: ${todo.length} new names, ${ok} batches done`);
  } else if (!KEY) {
    log('  · translations: no GEMINI_API_KEY, using cached ones only');
  }
  for (const d of deals) {
    const t = cache[d.name];
    if (t) {
      d.nameLt = t.lt;
      d.nameEn = t.en;
      if (t.term) d.term = t.term;
    }
  }
  // Keep only names still in use, so the cache doesn't grow forever.
  const live = new Set(deals.map((d) => d.name));
  for (const k of Object.keys(cache)) if (!live.has(k)) delete cache[k];
  writeFileSync(cacheUrl, JSON.stringify(cache));
}
