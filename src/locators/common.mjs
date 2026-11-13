export const UA = 'ZlotikaBot/0.1 (free price-comparison app for shoppers; daily, robots.txt respected)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
import { allowed } from '../http.ts';
export async function get(url, json = false) {
  if (!(await allowed(url))) throw new Error(`robots.txt disallows ${url}`);
  await sleep(1600);
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'pl-PL' } });
  if (r.status === 403 || r.status === 429) throw new Error(`blocked ${r.status} ${url}`); // never retry/bypass
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return json ? r.json() : r.text();
}
// town centre + radius (km) — keeps villages that share a name (e.g. Dino "Augustów 58A, 26-624") out
const TOWNS = { suwalki: [54.1115, 22.9308, 7], augustow: [53.8433, 22.98, 6], sejny: [54.1089, 23.346, 4], bialystok: [53.1325, 23.1688, 12] };
export const km = (a, b, c, d) => { const R = 6371, r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
export const townOf = (lat, lon) => Object.keys(TOWNS).find(t => km(lat, lon, TOWNS[t][0], TOWNS[t][1]) <= TOWNS[t][2]) ?? null;
const pad = t => t.replace(/^(\d):/, '0$1:');
export const span = (f, t) => (f && t ? `${pad(f)}-${pad(t)}` : null);
const D = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
// week = 7 values Mo..Su, each null (closed) or "06:00-22:00" (or "a,b" for split). Polish law: shops shut on PH.
export function toOSM(week, { ph = true } = {}) {
  if (week.every(v => v === undefined)) return null;
  const out = []; let i = 0;
  while (i < 7) { let j = i; while (j + 1 < 7 && week[j + 1] === week[i]) j++;
    out.push(`${i === j ? D[i] : `${D[i]}-${D[j]}`} ${week[i] ?? 'off'}`); i = j + 1; }
  if (ph) out.push('PH off');
  return out.join('; ').replace(/(\S+) off; PH off$/, '$1,PH off');
}
// Polish public holidays (YYYY-MM-DD) incl. Easter-based ones and 24 Dec (since 2025)
export function plHolidays(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1, E = Date.UTC(y, mo - 1, da);
  const iso = t => new Date(t).toISOString().slice(0, 10), DAY = 864e5;
  return new Set(['01-01', '01-06', '05-01', '05-03', '08-15', '11-01', '11-11', '12-24', '12-25', '12-26'].map(s => `${y}-${s}`)
    .concat([E, E + DAY, E + 49 * DAY, E + 60 * DAY].map(iso)));
}
// For "next 7 days" feeds: replace holiday / holiday-eve values with the most common Mo-Sa value of the rest
export function regularise(byDate) { // byDate: {'2026-11-11': '06:00-22:00'|null}
  const week = Array(7).fill(undefined), odd = new Set();
  for (const [d, v] of Object.entries(byDate)) {
    const dt = new Date(d + 'T12:00Z'), wd = (dt.getUTCDay() + 6) % 7, H = plHolidays(dt.getUTCFullYear());
    const next = new Date(+dt + 864e5).toISOString().slice(0, 10);
    week[wd] = v; if (H.has(d) || (H.has(next) && wd < 6)) odd.add(wd);
  }
  const cnt = {}; week.forEach((v, i) => { if (i < 6 && !odd.has(i) && v) cnt[v] = (cnt[v] || 0) + 1; });
  const mode = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const i of odd) if (i < 6) week[i] = mode ?? week[i]; else week[i] = null;
  return week;
}
