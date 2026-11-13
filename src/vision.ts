// Reads products and prices from leaflet page images with Google's Gemini vision model
// (free tier, key in the GEMINI_API_KEY secret). Every page is read once and cached in
// out/vision-cache.json (published with the feed), so a 100-page leaflet that runs for a
// week costs ~100 requests in total, not per day.
//
// Without a key, or when the free quota runs out, the caller falls back to local OCR.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { get } from './http.ts';
import type { PageDeal } from './ocr.ts';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const KEY = process.env.GEMINI_API_KEY ?? '';
const cacheUrl = new URL('../out/vision-cache.json', import.meta.url);

export interface VisionItem extends PageDeal {
  size?: string;
  everyday?: boolean; // "Zawsze/Codziennie niskie ceny": the regular shelf price
}
type Cache = Record<string, { model: string; at: string; items: VisionItem[] }>;

let cache: Cache = {};
try {
  if (existsSync(cacheUrl)) cache = JSON.parse(readFileSync(cacheUrl, 'utf8'));
} catch { /* start empty */ }
export const saveVisionCache = (keep: Set<string>) => {
  for (const k of Object.keys(cache)) if (!keep.has(k)) delete cache[k];
  writeFileSync(cacheUrl, JSON.stringify(cache));
};
export const cached = (image: string) => cache[image]?.items;

// New pages per run: ~6.5 s each keeps one daily run under ~30 minutes; the rest wait for tomorrow.
const MAX_NEW = Number(process.env.VISION_MAX ?? 220);
let fresh = 0;
export const visionEnabled = () => KEY.length > 0 && !quotaHit && fresh < MAX_NEW;
let quotaHit = false;
let model: string | null = null;

/** Picks the newest "flash" model that takes images, unless GEMINI_MODEL says otherwise. */
async function pickModel(): Promise<string> {
  if (model) return model;
  if (process.env.GEMINI_MODEL) return (model = process.env.GEMINI_MODEL);
  const res = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': KEY } });
  if (!res.ok) throw new Error(`model list HTTP ${res.status}`);
  const list = ((await res.json()) as any).models as { name: string; supportedGenerationMethods?: string[] }[];
  const ok = list
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name)
    .filter((n) => /flash/.test(n) && !/lite|image|tts|audio|live|preview|exp|thinking|embedding/.test(n));
  const ver = (n: string) => Number(n.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  ok.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
  if (!ok.length) throw new Error('no suitable Gemini model');
  return (model = ok[0]);
}

const PROMPT = `This is one page of a Polish supermarket leaflet (gazetka). List every product that has a price printed for it.
Rules:
- name: the product name exactly as printed, in Polish, with brand (e.g. "Masło ekstra Mlekovita"). No marketing slogans.
- size: package size as printed (e.g. "200 g", "6 x 250 ml", "1 kg"), or empty.
- price: the price in zł the shopper pays for ONE package under the offer shown (number, e.g. 6.49). If the page says "2+1 gratis" or "drugi 70% taniej" without a single-item price, use the printed single-item price and put the mechanism in condition.
- regularPrice: crossed-out or "cena regularna" price if printed, else 0.
- unitPrice and unit: the printed price per kg / l / szt. (e.g. 25.96 and "l"), else 0 and "".
- needsCard: true if this price needs the Moja Biedronka card/app, Kaufland Card, Lidl Plus or similar.
- condition: multi-buy or limit text as printed (e.g. "przy zakupie 2 szt.", "2+1 gratis", "limit 6 szt."), else "".
- everyday: true if the price is marked as an everyday/regular low price ("Zawsze niskie ceny", "Codziennie niskie ceny", "Stała cena").
Skip products with no printed price. Do not guess numbers that are not on the page.`;

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING' }, size: { type: 'STRING' }, price: { type: 'NUMBER' }, regularPrice: { type: 'NUMBER' },
      unitPrice: { type: 'NUMBER' }, unit: { type: 'STRING' }, needsCard: { type: 'BOOLEAN' }, condition: { type: 'STRING' }, everyday: { type: 'BOOLEAN' },
    },
    required: ['name', 'price'],
  },
};

let last = 0;
/** Reads one page. Returns null when vision is unavailable (no key, quota) so the caller falls back. */
export async function readPageVision(image: string): Promise<VisionItem[] | null> {
  if (cache[image]) return cache[image].items;
  if (!visionEnabled()) return null;
  const m = await pickModel();
  const png = Buffer.from(await (await get(image, { accept: 'image/*' })).arrayBuffer());
  const jpg = await sharp(png).resize({ width: 1100, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  // Free tier: stay well under the per-minute limit.
  const wait = Math.max(0, last + 6500 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  fresh++;
  const res = await fetch(`${API}/${m}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: jpg.toString('base64') } }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (res.status === 429 || res.status === 403) {
    quotaHit = true;
    console.log(`  vision: ${res.status} — free quota used up, falling back to OCR`);
    return null;
  }
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body: any = await res.json();
  const text = body.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '[]';
  const items = toItems(JSON.parse(text));
  cache[image] = { model: m, at: new Date().toISOString(), items };
  return items;
}

const n = (v: unknown) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : undefined);

/** Validates the model's JSON into deals; drops anything implausible. */
export function toItems(raw: unknown): VisionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: VisionItem[] = [];
  for (const r of raw as any[]) {
    const name = String(r?.name ?? '').replace(/\s+/g, ' ').trim();
    const price = n(r?.price);
    if (name.length < 3 || !price || price > 5000) continue;
    const size = String(r?.size ?? '').trim() || undefined;
    const old = n(r?.regularPrice);
    const cond = String(r?.condition ?? '').trim() || undefined;
    const minQty = cond?.match(/przy zakupie (\d+)/i)?.[1];
    const limit = cond?.match(/limit[^\d]{0,20}(\d+)/i)?.[1];
    const unit = String(r?.unit ?? '').trim().replace(/^zł\s*\/\s*/, '') || undefined;
    out.push({
      name: size && !name.includes(size) ? `${name}, ${size}` : name,
      size,
      price,
      oldPrice: old && old > price ? old : undefined,
      unitPrice: n(r?.unitPrice),
      unit: n(r?.unitPrice) ? unit : undefined,
      card: r?.needsCard === true || undefined,
      multibuy: cond && !/^limit/i.test(cond) ? cond : undefined,
      minQty: minQty ? Number(minQty) : undefined,
      limit: limit ? Number(limit) : undefined,
      everyday: r?.everyday === true || undefined,
    });
  }
  return out;
}
