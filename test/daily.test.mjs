import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyKey, dailyNumber, dailySeed, dailyScenario, dailyScenarioId, dailyLabel, ROTATION, EPOCH, countRun, isStarterSource, normalizeSource } from '../src/daily.js';
import { getScenario, SCENARIOS } from '../src/scenarios.js';
import { GridSim, runDay, DAY_MIN } from '../src/sim.js';
import { referencePars, gasFirst, expert, reactive, tunedSimple, cleanScore } from '../src/reference.js';
import { BASELINES, STARTER_POLICY } from '../src/policies.js';
import { packGhost, unpackGhost, isBetterRun, makeGhost, GHOST_STEP } from '../src/ghost.js';
import { shareText } from '../src/ui/share.js';
import { readFileSync } from 'node:fs';

const utc = (y, m, d, hh = 0, mm = 0, ss = 0) => new Date(Date.UTC(y, m - 1, d, hh, mm, ss));

test('daily key is the UTC calendar date, whatever the viewer\'s time zone', () => {
  assert.equal(dailyKey(utc(2026, 11, 17, 0, 0, 0)), '2026-11-17');
  assert.equal(dailyKey(utc(2026, 11, 17, 23, 59, 59)), '2026-11-17');
  assert.equal(dailyKey(utc(2026, 11, 18, 0, 0, 0)), '2026-11-18');
  assert.equal(dailyKey(utc(2027, 1, 1, 12)), '2027-01-01');
  assert.equal(dailyLabel('2026-11-17'), 'Tue 17 Nov');
});

test('daily number counts days from launch and never goes below 1', () => {
  assert.equal(EPOCH, Date.UTC(2026, 10, 17));
  assert.equal(dailyNumber('2026-11-17'), 1);
  assert.equal(dailyNumber('2026-11-18'), 2);
  assert.equal(dailyNumber('2027-01-01'), 46);
  assert.equal(dailyNumber('2026-10-27'), 1, 'dates before launch preview as #1');
});

test('date -> seed -> scenario is deterministic and stable (pinned values; changing them reshuffles every future daily)', () => {
  // seeds
  assert.equal(dailySeed('2026-11-17'), 1016630047);
  assert.equal(dailySeed('2026-11-18'), 1100518142);
  assert.notEqual(dailySeed('2026-11-17'), dailySeed('2026-11-18'));
  // rotation
  assert.deepEqual(ROTATION, ['heatwave', 'windless', 'ai2030', 'spring', 'storm']);
  const ids = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'].map(dailyScenarioId);
  assert.deepEqual(ids, ['heatwave', 'windless', 'ai2030', 'spring', 'storm', 'heatwave']);
  assert.equal(dailyScenarioId('2026-10-27'), 'storm'); // before launch the rotation just continues backwards
  // the whole scenario, twice
  const a = dailyScenario('2026-11-17'), b = dailyScenario('2026-11-17');
  assert.deepEqual(a, b);
  assert.equal(a.seed, 1016630047);
  assert.equal(a.peakMW, 8670);
  assert.deepEqual(a.daily, { key: '2026-11-17', n: 1, seed: 1016630047, surpriseAt: 675, base: 'heatwave' });
  assert.deepEqual(a.events.find((e) => e.surprise), { at: 675, type: 'trip', fleet: 'peaker', units: 2, minutes: 90, msg: 'Surprise outage: two peakers tripped (fuel valve)', surprise: true });
  // and the same day plays out identically
  const r1 = runDay(a, tunedSimple).result, r2 = runDay(dailyScenario('2026-11-17'), tunedSimple).result;
  assert.equal(r1.societal, r2.societal);
});

test('daily variants are mild: same scenario, new weather, one surprise outage in sorted order', () => {
  for (let i = 0; i < 40; i++) {
    const key = dailyKey(new Date(EPOCH + i * 86400000));
    const base = getScenario(dailyScenarioId(key));
    const sc = dailyScenario(key);
    assert.equal(sc.id, base.id);
    assert.equal(sc.name, base.name);
    assert.equal(sc.par, undefined, 'par is derived at run time');
    assert.ok(Math.abs(sc.peakMW / base.peakMW - 1) <= 0.031, key);
    const ats = sc.events.map((e) => e.at);
    assert.deepEqual(ats, [...ats].sort((x, y) => x - y), key + ': events out of order');
    const surprises = sc.events.filter((e) => e.surprise);
    if (base.id === 'storm') {
      assert.equal(surprises.length, 0);
      assert.equal(sc.seed, base.seed); // the storm is a knife edge: same weather, outages move by at most 5 minutes
      sc.events.forEach((e, k) => assert.ok(Math.abs(e.at - base.events[k].at) <= 5));
      assert.ok(sc.real, 'the storm keeps its "this really happened" card');
    } else {
      assert.equal(surprises.length, 1);
      assert.ok(surprises[0].at >= 540 && surprises[0].at <= 1230, key);
      assert.equal(sc.events.length, base.events.length + 1);
    }
    new GridSim(sc); // builds
  }
  // the base scenarios are untouched
  assert.equal(getScenario('heatwave').events.length, 1);
});

test('every daily we sample is winnable, and the rotation shows all five days', () => {
  const seen = new Set();
  for (let i = 0; i < 10; i++) { // two full rotations
    const key = dailyKey(new Date(EPOCH + i * 86400000));
    const sc = dailyScenario(key);
    seen.add(sc.daily.base);
    const p = referencePars(sc);
    assert.ok(Number.isFinite(p.par), `${key} (${sc.id}): no reference policy keeps the lights on`);
    assert.ok(p.codePar <= p.par);
  }
  assert.equal(seen.size, 5);
});

test('code par: a gas-first policy is part of the best known set, and par is reachable for code', () => {
  const hidden = [...BASELINES.map((b) => b.fn), expert, reactive, tunedSimple, gasFirst];
  for (const sc of SCENARIOS) {
    const best = Math.min(...hidden.map((fn) => cleanScore(sc, fn)));
    assert.ok(Number.isFinite(sc.codePar), sc.id);
    assert.ok(sc.codePar <= sc.par, `${sc.id}: code par ${sc.codePar} is looser than par ${sc.par}`);
    assert.ok(best <= sc.codePar, `${sc.id}: best known ${best.toFixed(0)} > code par ${sc.codePar} (code par is not reachable)`);
    assert.ok(best > sc.codePar * 0.995, `${sc.id}: code par ${sc.codePar} is loose (best ${best.toFixed(0)})`);
  }
  // gas-first is what motivates it: it beats the manual par on days 1, 2 and 5
  for (const id of ['spring', 'heatwave', 'ai2030']) {
    const sc = getScenario(id);
    assert.ok(cleanScore(sc, gasFirst) < sc.par, `${id}: gas-first no longer beats par`);
  }
});

test('the README example stays above code par on every day it keeps the lights on', () => {
  const code = readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('```js')[1].split('```')[0];
  const example = new Function(code + ';return dispatch;')();
  for (const sc of SCENARIOS) {
    const r = runDay(sc, example).result;
    if (r.unservedMWh === 0) assert.ok(r.societal > sc.codePar * 1.01, `${sc.id}: README example is within 1% of code par`);
  }
});

test('ghost: packed frequency trace round-trips within a millihertz, and only better runs replace it', () => {
  const { sim, result } = runDay(getScenario('heatwave'), tunedSimple);
  const g = makeGhost(result, sim.hist.freq);
  assert.equal(g.f.length, Math.ceil(DAY_MIN / GHOST_STEP));
  assert.ok(g.f.every(Number.isInteger));
  assert.ok(JSON.stringify(g).length < 6000, 'ghost should be a few KB');
  const back = unpackGhost(g.f);
  for (let i = 0; i < back.length; i++) assert.ok(Math.abs(60 + back[i] - sim.hist.freq[i * GHOST_STEP]) < 0.0011);
  assert.equal(unpackGhost(null), null);
  assert.equal(unpackGhost('nope'), null);
  assert.equal(unpackGhost([1, 2, 3]), null);
  assert.equal(unpackGhost(Array(100).fill('x')), null);
  assert.ok(isBetterRun({ societal: 5 }, null));
  assert.ok(isBetterRun({ societal: 5 }, { societal: 6 }));
  assert.ok(!isBetterRun({ societal: 6 }, { societal: 6 }));
  assert.ok(!isBetterRun({ societal: 7 }, { societal: 6 }));
  assert.ok(isBetterRun({ societal: 7 }, { junk: true }), 'a corrupt stored ghost is replaced');
});

test('daily share text: "HOLD 60 · Daily #N · date", grade, score vs par, 24 cells, dated link carrying the grade; best / replay / template and code variants', () => {
  globalThis.location = { href: 'https://example.com/hold60/#daily' };
  const sc = dailyScenario('2026-11-17');
  Object.assign(sc, referencePars(sc));
  const result = runDay(sc, tunedSimple).result;
  const today = '2026-11-17';
  const text = shareText({ scenario: sc, result, mode: 'manual', today });
  const lines = text.split('\n');
  assert.equal(lines[0], 'HOLD 60 · Daily #1 · 2026-11-17');
  assert.equal(lines[1], 'Texas-Style Heatwave');
  assert.match(lines[2], /^Grade [A-F]\+? · (no blackouts|[\d,.]+ (MWh|GWh) dark) · score \$\d+\.\d\dM \([+−]\d+\.\d% vs par\) · [\d.]+ (kt|t) CO2$/);
  assert.equal([...lines[3]].length, 24);
  assert.match(lines[3], /^[🟩🟨🟥]+$/u);
  const q = `?g=${encodeURIComponent(result.grade)}&s=${(result.societal / 1e6).toFixed(1)}`;
  assert.equal(lines[4], 'https://example.com/hold60/#daily/2026-11-17' + q);
  const line1 = (status, t = today) => shareText({ scenario: sc, result, mode: 'manual', status, today: t }).split('\n')[1];
  assert.equal(line1('first'), 'Texas-Style Heatwave · best today');
  assert.equal(line1('improved'), 'Texas-Style Heatwave · best today');
  assert.equal(line1('improved', '2026-11-20'), 'Texas-Style Heatwave · best run', 'an older grid is not "today"');
  assert.equal(line1('kept'), 'Texas-Style Heatwave · replay');
  assert.equal(line1('template'), 'Texas-Style Heatwave · template run');
  assert.ok(!/practice/.test(text));
  const code = shareText({ scenario: sc, result, mode: 'code', today }).split('\n');
  assert.equal(code[1], 'Texas-Style Heatwave (my code)');
  assert.match(code[2], /vs par · [+−]\d+\.\d% vs code par\)/);
  assert.equal(code[4], 'https://example.com/hold60/#code/daily/2026-11-17' + q);
  // a normal scenario still shares the old way
  const plain = shareText({ scenario: getScenario('heatwave'), result, mode: 'manual' }).split('\n');
  assert.equal(plain[0], 'Hold 60: Texas-Style Heatwave');
  assert.equal(plain[plain.length - 1], 'https://example.com/hold60/#heatwave');
});

test('winter storm card: hedged, short, and names its source; absent elsewhere', () => {
  const real = getScenario('storm').real;
  assert.ok(real && real.title);
  const sentences = real.text.split(/(?<=\.)\s+/);
  assert.ok(sentences.length >= 3 && sentences.length <= 4, `expected 3-4 sentences, got ${sentences.length}`);
  assert.match(real.text, /February 2021/);
  assert.match(real.text, /fictional|invented/i);
  assert.match(real.text, /FERC/);
  assert.match(real.text, /NERC/);
  assert.doesNotMatch(real.text, /\d[\d,.]*\s?(MW|GW|million|billion|deaths|%)/i, 'no exact-data claims');
  for (const sc of SCENARIOS) if (sc.id !== 'storm') assert.equal(sc.real, undefined, sc.id);
});

test('meta tags: absolute-ready og:image and twitter large card point at a real file', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta property="og:image" content="og-card\.png">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  const png = readFileSync(new URL('../og-card.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test('counted run: the best finished run counts (not the first); the starter template never does', () => {
  const run = (societal, grade = 'B') => ({ societal, grade, cells: ['green'] });
  // first finished run counts
  const c = countRun(null, run(12e6), { par: 10e6 });
  assert.equal(c.status, 'first');
  assert.equal(c.record.societal, 12e6);
  assert.equal(c.record.runs, 1);
  assert.equal(c.record.par, 10e6);
  // a better one replaces it, and the attempts add up
  const c2 = countRun(c.record, run(11e6, 'A'), { par: 10e6 });
  assert.equal(c2.status, 'improved');
  assert.equal(c2.record.societal, 11e6);
  assert.equal(c2.record.grade, 'A');
  assert.equal(c2.record.runs, 2);
  // a worse (or equal) one is a replay: the best stays, the attempt counter moves
  const c3 = countRun(c2.record, run(13e6, 'C'));
  assert.equal(c3.status, 'kept');
  assert.equal(c3.record.societal, 11e6);
  assert.equal(c3.record.runs, 3);
  assert.equal(countRun(c3.record, run(11e6)).status, 'kept', 'a tie does not replace');
  // a learning run that blacked out does not lock the day: a clean run beats it
  const lockedIn = countRun(null, run(73.5e6, 'F'));
  assert.equal(countRun(lockedIn.record, run(12.6e6)).status, 'improved');
  // template runs are never counted, whatever the score, and never touch an existing record
  assert.deepEqual(countRun(null, run(5e6, 'A'), { template: true }), { status: 'template', record: null });
  const t2 = countRun(c2.record, run(5e6, 'A'), { template: true });
  assert.equal(t2.status, 'template');
  assert.equal(t2.record.societal, 11e6);
  // a corrupt stored record is replaced
  assert.equal(countRun({ junk: 1 }, run(9e6)).status, 'first');
  assert.equal(countRun('nope', run(9e6)).status, 'first');
});

test('starter-template detection ignores line endings and trailing blanks, not real edits', () => {
  assert.ok(isStarterSource(STARTER_POLICY, STARTER_POLICY));
  assert.ok(isStarterSource(STARTER_POLICY.replace(/\n/g, '\r\n') + '\n\n', STARTER_POLICY));
  assert.ok(isStarterSource(STARTER_POLICY.split('\n').map((l) => l + '  ').join('\n'), STARTER_POLICY));
  assert.ok(!isStarterSource(STARTER_POLICY.replace('return', 'return /*mine*/'), STARTER_POLICY));
  assert.ok(!isStarterSource('', STARTER_POLICY));
  assert.ok(!isStarterSource(undefined, STARTER_POLICY));
  assert.equal(normalizeSource(null), '');
});
