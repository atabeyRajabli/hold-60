// Hold 60 — the daily challenge. Pure module (no DOM, no clock of its own): everything is a function
// of the UTC calendar date, so every player gets the same grid on the same day.
//
//   date (UTC) --> key "2026-11-17" --> day number, seed, scenario (fixed rotation), surprise outage
//
// Changing ROTATION, EPOCH or the hash below changes every future daily, so a test pins them.

import { getScenario } from './scenarios.js';
import { mulberry32 } from './sim.js';

/** Daily #1. Tuesday 17 November 2026 (UTC). Earlier dates are shown as #1 as well (a preview). */
export const EPOCH = Date.UTC(2026, 10, 17);
/** One scenario per day, cycling. The showcase heatwave opens the run. */
export const ROTATION = ['heatwave', 'windless', 'ai2030', 'spring', 'storm'];
const DAY_MS = 86400000;

/** "2026-11-17" for the UTC calendar date of `date`. */
export function dailyKey(date = new Date()) {
  const d = new Date(date);
  return d.toISOString().slice(0, 10);
}

function dayIndex(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY_MS);
}

/** Daily number shown to players: 1 on launch day, never below 1. */
export function dailyNumber(key) {
  return Math.max(1, dayIndex(key) + 1);
}

/** FNV-1a over the key: a stable 32-bit seed. */
export function dailySeed(key) {
  let h = 0x811c9dc5;
  const s = 'hold60-daily-' + key;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function dailyScenarioId(key) {
  const n = ROTATION.length;
  return ROTATION[((dayIndex(key) % n) + n) % n];
}

const SURPRISES = [
  { fleet: 'gas', units: 1, minutes: [90, 150], msg: 'Surprise outage: a gas unit tripped (boiler feed pump)' },
  { fleet: 'gas', units: 1, minutes: [60, 150], msg: 'Surprise outage: a gas unit tripped (gas pressure dip)' },
  { fleet: 'coal', units: 1, minutes: [180, 300], msg: 'Surprise outage: a coal unit tripped (mill fire)' },
  { fleet: 'peaker', units: 2, minutes: [60, 150], msg: 'Surprise outage: two peakers tripped (fuel valve)' },
];

/**
 * Today's grid: the rotation's scenario with a few daily twists.
 *  - Most days: the daily seed (new weather noise), peak demand within +/-3%, and one surprise outage at a
 *    time that is not in the forecast (on the heatwave it comes before 12:00 and is never coal, because a late outage
 *    on top of the duck curve is not winnable by any policy we know).
 *  - The winter storm is a knife edge even for our best policy, so it keeps its own seed and sizes and
 *    only moves each scripted outage by by up to 5 minutes.
 * `par` and `codePar` are left unset; the app fills them in with referencePars() because the variants
 * have no hand-tuned par. Deterministic: the same key always gives the same scenario.
 */
export function dailyScenario(key = dailyKey()) {
  const base = getScenario(dailyScenarioId(key));
  const sc = structuredClone(base);
  const seed = dailySeed(key);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  let surpriseAt = null;
  if (base.id === 'storm') {
    for (const e of sc.events) e.at = Math.max(5, e.at + Math.round((rng() - 0.5) * 2) * 5);
  } else {
    sc.seed = seed;
    sc.peakMW = Math.round(base.peakMW * (0.97 + rng() * 0.06) / 10) * 10;
    const latest = base.id === 'heatwave' ? 12 * 60 : 20.5 * 60;
    const at = Math.round((9 * 60 + rng() * (latest - 9 * 60)) / 5) * 5;
    const r1 = rng(), r2 = rng();
    const lengthOf = (p) => Math.round((p.minutes[0] + r2 * (p.minutes[1] - p.minutes[0])) / 5) * 5;
    // never stack the surprise on the scenario's own outage of the same fleet
    const clashes = (p) => base.events.some((e) => e.type === 'trip' && e.fleet === p.fleet && e.at < at + lengthOf(p) + 30 && at < e.at + (e.minutes || 90) + 30);
    const pool = base.id === 'heatwave' ? SURPRISES.filter((p) => p.fleet !== 'coal') : SURPRISES; // a 4 h coal outage at noon sinks the heatwave
    const start = Math.floor(r1 * pool.length);
    let pick = pool[start];
    for (let i = 0; i < pool.length; i++) {
      const p = pool[(start + i) % pool.length];
      if (!clashes(p)) { pick = p; break; }
    }
    sc.events.push({ at, type: 'trip', fleet: pick.fleet, units: pick.units, minutes: lengthOf(pick), msg: pick.msg, surprise: true });
    surpriseAt = at;
  }
  sc.events.sort((a, b) => a.at - b.at);
  delete sc.par;
  delete sc.codePar;
  sc.daily = { key, n: dailyNumber(key), seed, surpriseAt, base: base.id };
  return sc;
}

/** "Tue 17 Nov" for the UTC date, independent of the viewer's locale and time zone. */
export function dailyLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${wd} ${d} ${mo}`;
}

// ------------------------------------------------------------------ the counted run

/** Source text with line endings and trailing blanks normalised, so "untouched" survives a copy-paste. */
export function normalizeSource(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
}

/** True when the editor still holds the starter template (a run of it never counts). */
export function isStarterSource(src, starter) {
  return normalizeSource(src) === normalizeSource(starter);
}

/**
 * The counted run for a date and mode is the player's BEST finished run (lowest score), not the first.
 * Template runs never count. `prev` is the stored record (or null / junk).
 * @returns {{status: 'template'|'first'|'improved'|'kept', record: object|null}}
 *   `record` is what to store: the new best, or `prev` with its attempt counter bumped.
 */
export function countRun(prev, result, { template = false, par = 0 } = {}) {
  const good = prev && Number.isFinite(prev.societal) ? prev : null;
  if (template) return { status: 'template', record: good };
  const runs = (good ? good.runs || 1 : 0) + 1;
  const mine = { grade: result.grade, societal: result.societal, par, cells: result.cells, runs };
  if (!good) return { status: 'first', record: mine };
  if (result.societal < good.societal) return { status: 'improved', record: mine };
  return { status: 'kept', record: { ...good, runs } };
}
