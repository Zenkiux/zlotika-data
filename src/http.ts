// Polite HTTP: honest identity, robots.txt respected, one request at a time,
// no attempt to get around blocks. A 403/429/challenge simply fails the source.
export const UA = 'ZlotikaBot/0.1 (free price-comparison app for shoppers; daily, robots.txt respected)';

const robotsCache = new Map<string, { allow: string[]; disallow: string[] }>();

async function robotsFor(origin: string) {
  if (robotsCache.has(origin)) return robotsCache.get(origin)!;
  const rules = { allow: [] as string[], disallow: [] as string[] };
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const lines = (await res.text()).split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim());
      let applies = false;
      let sawSpecific = false;
      // Prefer a group for our bot; otherwise the * group.
      for (const pass of ['zlotikabot', '*']) {
        applies = false;
        for (const l of lines) {
          const [k, ...rest] = l.split(':');
          const v = rest.join(':').trim();
          const key = k?.toLowerCase();
          if (key === 'user-agent') applies = v.toLowerCase() === pass;
          else if (applies && key === 'disallow' && v) { rules.disallow.push(v); sawSpecific = true; }
          else if (applies && key === 'allow' && v) { rules.allow.push(v); sawSpecific = true; }
        }
        if (sawSpecific) break;
      }
    }
  } catch { /* no robots = allowed */ }
  robotsCache.set(origin, rules);
  return rules;
}

function matches(rule: string, path: string) {
  const re = new RegExp('^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return re.test(path);
}

export async function allowed(url: string) {
  const u = new URL(url);
  const r = await robotsFor(u.origin);
  const path = u.pathname + u.search;
  const longest = (rs: string[]) => Math.max(-1, ...rs.filter((x) => matches(x, path)).map((x) => x.length));
  return longest(r.allow) >= longest(r.disallow);
}

let last = 0;
export async function get(url: string, opts: { accept?: string; headers?: Record<string, string> } = {}) {
  if (!(await allowed(url))) throw new Error(`robots.txt disallows ${url}`);
  const wait = Math.max(0, last + 1500 - Date.now()); // ≥1.5 s between requests
  if (wait) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: opts.accept ?? 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'pl-PL,pl;q=0.9', ...opts.headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

export const getText = async (url: string, opts?: Parameters<typeof get>[1]) => (await get(url, opts)).text();
export const getJson = async <T = unknown>(url: string, opts?: Parameters<typeof get>[1]) => (await get(url, { accept: 'application/json', ...opts })).json() as Promise<T>;
