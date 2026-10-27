// Hold 60 — hash routing, kept free of the DOM so it can be unit-tested.
// parseHash never throws: a mangled link (e.g. "#%zz", a trailing "%", "#daily/2026-13-99") lands somewhere safe.
//
//   #                          landing
//   #play                      scenario picker
//   #tutorial[?then=daily[/DATE]]   the tutorial, optionally flowing into a daily afterwards
//   #<scenario>                a hand-built day
//   #daily[/YYYY-MM-DD][?g=B&s=11.3]         the daily grid of a date (default: today; future dates clamp to today)
//   #code[/<scenario>]         code mode;  #code/daily[/YYYY-MM-DD][?g=..&s=..] is a daily in code mode
//
// `g` and `s` are a friend's grade and score ($M); they only drive the "can you beat it?" banner.

export const GRADES = ['A+', 'A', 'B', 'C', 'D', 'F'];

/** Today's UTC calendar date, "YYYY-MM-DD". */
export const utcToday = () => new Date().toISOString().slice(0, 10);

/** True for a real calendar date written exactly "YYYY-MM-DD" (2026-02-30 and 2026-13-99 are not). */
export function validDateKey(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 2000) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A tolerant "a=1&b=2" parser: bad escapes and junk pairs are skipped, never thrown. */
export function parseQuery(q) {
  const out = {};
  for (const pair of String(q || '').split('&')) {
    const i = pair.indexOf('=');
    if (i < 1) continue;
    try {
      const k = decodeURIComponent(pair.slice(0, i));
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = decodeURIComponent(pair.slice(i + 1));
    } catch { /* skip this pair */ }
  }
  return out;
}

/** {g, s} from a link's query when both are sane (a known grade, a score between $0 and $1B), otherwise null. */
export function parseChallenge(query) {
  const q = parseQuery(query);
  const g = String(q.g ?? '').trim().toUpperCase();
  const s = Number(q.s);
  if (!GRADES.includes(g) || !Number.isFinite(s) || !(s > 0) || s >= 1000 || String(q.s).trim() === '') return null;
  return { g, s: Math.round(s * 10) / 10 };
}

/** Resolve a date segment: missing -> today, malformed -> today (bad), future -> today (clamped). */
function resolveDate(seg, today) {
  if (seg == null || seg === '') return { date: today, canon: false };
  if (!validDateKey(seg)) return { date: today, canon: true };
  if (seg > today) return { date: today, canon: true };
  return { date: seg, canon: false };
}

/**
 * @param {string} hash       location.hash, with or without the leading "#"
 * @param {(id: string) => boolean} isScenario
 * @param {() => string|null} [lastCodeId]  scenario to use for a bare "#code"
 * @param {string} [today]    UTC date "YYYY-MM-DD" (a parameter so tests do not depend on the clock)
 * @returns {{view: 'landing'|'picker'|'tutorial'|'game'|'code', id?: string, bad?: boolean,
 *   date?: string, challenge?: {g: string, s: number}, then?: string, canon?: string}}
 *   `date` is set for id 'daily'. `canon` is the hash to put in the address bar when the link was repaired.
 */
export function parseHash(hash, isScenario, lastCodeId = () => null, today = utcToday()) {
  try {
    const raw = String(hash ?? '').replace(/^#/, '');
    const qi = raw.indexOf('?');
    const pathRaw = qi < 0 ? raw : raw.slice(0, qi);
    const query = qi < 0 ? '' : raw.slice(qi + 1);
    let path;
    try { path = decodeURIComponent(pathRaw); } catch { return { view: 'landing', bad: true }; }
    path = path.trim().toLowerCase().replace(/\/+$/, '');
    if (!path) return { view: 'landing' };
    const parts = path.split('/');
    const challenge = parseChallenge(query);
    const withChallenge = (r) => (challenge ? { ...r, challenge } : r);

    const dailyRoute = (view, dateSeg) => {
      const { date, canon } = resolveDate(dateSeg, today);
      const r = { view, id: 'daily', date };
      if (canon) r.canon = (view === 'code' ? '#code/daily/' : '#daily/') + date;
      return withChallenge(r);
    };

    if (parts[0] === 'play' && parts.length === 1) return { view: 'picker' };
    if (parts[0] === 'tutorial' && parts.length === 1) {
      const then = String(parseQuery(query).then ?? '').trim().toLowerCase();
      const m = /^daily(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(then);
      if (!m) return { view: 'tutorial' };
      const { date } = resolveDate(m[1], today);
      return withChallenge({ view: 'tutorial', then: m[1] ? `daily/${date}` : 'daily' });
    }
    if (parts[0] === 'daily' && parts.length <= 2) return dailyRoute('game', parts[1]);
    if (parts[0] === 'code' && parts.length <= 4) {
      if (parts[1] === 'daily') return dailyRoute('code', parts[2]);
      const want = parts[1] || (lastCodeId && lastCodeId()) || 'heatwave';
      return { view: 'code', id: isScenario(want) ? want : 'heatwave' };
    }
    if (parts.length === 1 && /^[a-z0-9_-]+$/.test(parts[0]) && parts[0] !== '__proto__' && isScenario(parts[0])) return { view: 'game', id: parts[0] };
    return { view: 'landing', bad: true };
  } catch {
    return { view: 'landing', bad: true };
  }
}
