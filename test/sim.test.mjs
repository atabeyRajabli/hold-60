import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GridSim, runDay, DAY_MIN, F0, UFLS_HZ, OVERFREQ_HZ, gradeFor, scoreRun, VOLL, CARBON_PRICE, hourCell,
} from '../src/sim.js';
import { SCENARIOS, getScenario, tutorialScenario } from '../src/scenarios.js';
import { parseHash, validDateKey } from '../src/route.js';
import { shareText, shareURL, moneyM, vsPar } from '../src/ui/share.js';
import { BASELINES, lookAhead, STARTER_POLICY } from '../src/policies.js';
import { expert, reactive, tunedSimple } from '../tools/expert-policy.mjs';
import { readFileSync } from 'node:fs';

// the example policy printed in README.md: a plain starting point that must NOT set or reach par
const readmeCode = readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('```js')[1].split('```')[0];
const readmeExample = new Function(readmeCode + ';return dispatch;')();

const spring = getScenario('spring');
const heat = getScenario('heatwave'); // starts with plenty of gas online, handy for physics tests

/** A copy of a scenario with tweaks, so tests can isolate one mechanism. */
function variant(base, patch) {
  const sc = structuredClone(base);
  Object.assign(sc, patch);
  return sc;
}

/** Hold every setpoint where warm start put it. */
function holdPolicy(sim) {
  return {
    coal: sim.units.coal.target, gas: sim.units.gas.target, peaker: sim.units.peaker.target,
    wind: sim.ren.wind.target, solar: sim.ren.solar.target, battery: 0,
  };
}

test('same seed and same actions give identical days', () => {
  const a = runDay(spring, lookAhead).sim;
  const b = runDay(spring, lookAhead).sim;
  assert.deepEqual(Array.from(a.hist.freq), Array.from(b.hist.freq));
  assert.deepEqual(a.totals, b.totals);
  assert.deepEqual(a.log, b.log);
});

test('a different seed changes the weather but not the forecast', () => {
  const a = new GridSim(spring, { seed: 1 });
  const b = new GridSim(spring, { seed: 2 });
  assert.deepEqual(a.forecast().demand, b.forecast().demand);
  assert.notDeepEqual(Array.from(a.prof.demand), Array.from(b.prof.demand));
});

test('tick 0 starts balanced at 60 Hz', () => {
  for (const sc of SCENARIOS) {
    const sim = new GridSim(sc);
    assert.equal(sim.df, 0);
    const s = sim.observe();
    assert.ok(Math.abs(s.generation - s.demand) < 1, `${sc.id}: ${s.generation} vs ${s.demand}`);
  }
});

test('frequency falls with a supply deficit and rises with a surplus', () => {
  const calm = variant(heat, { demandNoise: 0, windNoise: 0, solarNoise: 0 });
  const down = new GridSim(calm);
  const base = holdPolicy(down);
  // remove 300 MW of gas and keep the battery out of it
  down.f = structuredClone(down.f);
  down.f.battery.mw = 0.0001;
  for (let i = 0; i < 5; i++) down.step({ ...base, gas: Math.max(0, base.gas - 300) });
  assert.ok(down.df < -0.05, `expected under-frequency, got ${down.df}`);

  const up = new GridSim(calm);
  up.f = structuredClone(up.f);
  up.f.battery.mw = 0.0001;
  for (let i = 0; i < 5; i++) up.step({ ...base, gas: base.gas + 200 });
  assert.ok(up.df > 0.05, `expected over-frequency, got ${up.df}`);
});

test('bigger imbalance moves frequency further', () => {
  const calm = variant(heat, { demandNoise: 0, windNoise: 0, solarNoise: 0 });
  const dev = (mw) => {
    const s = new GridSim(calm);
    s.f = structuredClone(s.f);
    s.f.battery.mw = 0.0001;
    const base = holdPolicy(s);
    for (let i = 0; i < 3; i++) s.step({ ...base, gas: base.gas - mw });
    return s.df;
  };
  assert.ok(dev(200) < dev(100));
  assert.ok(dev(100) < 0);
});

test('battery fast frequency response cushions a deficit', () => {
  const calm = variant(heat, { demandNoise: 0, windNoise: 0, solarNoise: 0 });
  const run = (withBattery) => {
    const s = new GridSim(calm);
    if (!withBattery) { s.f = structuredClone(s.f); s.f.battery.mw = 0.0001; }
    const base = holdPolicy(s);
    for (let i = 0; i < 5; i++) s.step({ ...base, gas: base.gas - 200 });
    return s.df;
  };
  assert.ok(run(true) > run(false));
});

test('under-frequency load shedding trips below 59.3 Hz and counts unserved energy', () => {
  const sim = new GridSim(spring);
  // walk away from the controls: thermal plants to zero, no battery
  sim.f = structuredClone(sim.f);
  sim.f.battery.mw = 0.0001;
  let minF = 99;
  for (let i = 0; i < 30; i++) {
    sim.step({ coal: 0, gas: 0, peaker: 0, battery: 0 });
    minF = Math.min(minF, F0 + sim.df);
  }
  assert.ok(sim.totals.shedEvents > 0, 'expected shedding');
  assert.ok(minF < UFLS_HZ + 0.01);
  assert.ok(sim.totals.unservedMWh > 0);
  assert.ok(sim.log.some((e) => e.type === 'shed'));
  // nothing is shed while frequency stays healthy
  const ok = runDay(spring, lookAhead).sim;
  assert.equal(ok.totals.shedEvents, 0);
});

test('shed customers are restored once frequency recovers', () => {
  const sim = new GridSim(heat);
  const base = holdPolicy(sim);
  sim.f = structuredClone(sim.f);
  sim.f.battery.mw = 0.0001;
  for (let i = 0; i < 8; i++) sim.step({ ...base, gas: 0 });
  assert.ok(sim.shed.length > 0);
  for (let i = 0; i < 240; i++) sim.step({ ...base, gas: sim.f.gas.units * sim.f.gas.unitMW * 0.8 });
  assert.ok(sim.log.some((e) => e.type === 'restore'));
});

test('over-frequency above 60.5 Hz trips a generator', () => {
  const sim = new GridSim(spring);
  sim.f = structuredClone(sim.f);
  sim.f.battery.mw = 0.0001;
  const base = holdPolicy(sim);
  for (let i = 0; i < 20; i++) sim.step({ ...base, gas: 2700, peaker: 1200 });
  assert.ok(sim.totals.trips > 0, 'expected an over-frequency trip');
  assert.ok(Math.max(...sim.hist.freq.slice(0, 20)) > OVERFREQ_HZ - 0.05);
});

test('battery conserves energy and respects its limits', () => {
  for (const sc of SCENARIOS) {
    const { sim } = runDay(sc, BASELINES[2].fn);
    const B = sc.fleet.battery;
    const eta = Math.sqrt(B.eff);
    const expected = B.mwh * B.soc0 + sim.totals.batteryIn * eta - sim.totals.batteryOut / eta;
    assert.ok(Math.abs(sim.battery.soc - expected) < 1e-6 * B.mwh, `${sc.id}: soc ${sim.battery.soc} vs ${expected}`);
    assert.ok(sim.battery.soc >= -1e-9 && sim.battery.soc <= B.mwh + 1e-9);
    for (const b of sim.hist.battery) assert.ok(Math.abs(b) <= B.mw + 1e-6);
  }
  // draining at full power empties it and then stops
  const s = new GridSim(spring);
  for (let i = 0; i < 400; i++) s.step({ battery: s.f.battery.mw });
  assert.ok(s.battery.soc < 1);
  assert.ok(s.battery.output < 1);
});

test('thermal plants obey ramp limits and start-up delays', () => {
  const sim = new GridSim(getScenario('heatwave'));
  const d = sim.f.coal;
  const prev = [];
  for (let i = 0; i < 120; i++) {
    const before = sim.units.coal.output;
    const online = sim.units.coal.online;
    sim.step({ coal: i % 60 < 30 ? 0 : d.units * d.unitMW });
    prev.push(Math.abs(sim.units.coal.output - before) <= Math.max(online, 1) * d.rampPerUnit + 1e-6 || sim.log.some((e) => e.t === i));
  }
  assert.ok(prev.every(Boolean), 'coal output moved faster than its ramp rate');

  // a cold peaker fleet cannot produce until its start-up delay has passed
  const s2 = new GridSim(spring);
  assert.equal(s2.units.peaker.online, 0);
  const pk = s2.f.peaker;
  for (let i = 0; i < pk.startMin; i++) {
    s2.step({ peaker: 500 });
    if (i < pk.startMin - 1) assert.ok(s2.units.peaker.output === 0, `peaker produced at minute ${i}`);
  }
  s2.step({ peaker: 500 });
  assert.ok(s2.units.peaker.output > 0);
  assert.ok(s2.units.peaker.output <= 5 * pk.rampPerUnit * 2 + 1e-6);
});

test('nuclear output is flat unless it trips', () => {
  const { sim } = runDay(spring, BASELINES[1].fn);
  const n = sim.hist.nuclear;
  assert.ok(n.every((x) => x === n[0]));
  const storm = runDay(getScenario('storm'), BASELINES[1].fn).sim;
  assert.ok(storm.hist.nuclear[DAY_MIN - 1] < storm.hist.nuclear[0]);
});

test('renewables never exceed what the weather allows, and curtailment works', () => {
  const sim = new GridSim(spring);
  for (let i = 0; i < 720; i++) sim.step({ solar: 500 });
  for (let i = 0; i < 720; i++) {
    assert.ok(sim.hist.solar[i] <= 500 + 1e-6);
    assert.ok(sim.hist.solar[i] <= sim.prof.solar[i] + 0.01); // hist is Float32
  }
  assert.ok(sim.totals.curtailedMWh > 0);
});

test('demand response is limited and delayed', () => {
  const sim = new GridSim(spring);
  const calls = sim.f.dr.calls;
  for (let i = 0; i < 1000; i++) sim.step({ dr: true });
  assert.equal(sim.log.filter((e) => e.type === 'dr').length, calls);
  assert.equal(sim.dr.callsLeft, 0);
  const s2 = new GridSim(spring);
  s2.step({ dr: true });
  assert.ok(Math.abs(s2.hist.demand[0] - s2.prof.demand[0]) < 0.01);
  for (let i = 0; i < s2.f.dr.delay; i++) s2.step({});
  assert.ok(Math.abs(s2.hist.demand[s2.f.dr.delay] - (s2.prof.demand[s2.f.dr.delay] - s2.f.dr.mw)) < 0.01);
});

test('bad policy output is ignored rather than crashing the sim', () => {
  const sim = new GridSim(spring);
  sim.step({ coal: NaN, gas: 'lots', peaker: Infinity, battery: null, wind: -5 });
  sim.step(undefined);
  sim.step(42);
  sim.step({ setpoints: { gas: 100 } });
  assert.equal(sim.t, 4);
  assert.equal(sim.units.gas.target, 100);
  assert.ok(Number.isFinite(sim.df));
});

test('scoring: blackouts dominate, then cost and CO2', () => {
  assert.equal(gradeFor(0, 100, 100), 'A+');
  assert.equal(gradeFor(0, 105, 100), 'A');
  assert.equal(gradeFor(0, 115, 100), 'B');
  assert.equal(gradeFor(0, 500, 100), 'C');
  assert.equal(gradeFor(10, 50, 100), 'C', 'any blackout caps the grade even if cheap');
  assert.equal(gradeFor(500, 50, 100), 'D');
  assert.equal(gradeFor(5000, 50, 100), 'F');
  const { sim } = runDay(spring, lookAhead);
  const r = scoreRun(sim);
  assert.equal(r.societal, sim.totals.cost + sim.totals.unservedMWh * VOLL + sim.totals.co2 * CARBON_PRICE);
  assert.equal(r.cells.length, 24);
  assert.equal(hourCell({ shedMWh: 3, strainedMin: 0, trips: 0 }), 'red');
  assert.equal(hourCell({ shedMWh: 0, strainedMin: 5, trips: 0 }), 'yellow');
  assert.equal(hourCell({ shedMWh: 0, strainedMin: 0, trips: 0 }), 'green');
  // doing nothing is graded F everywhere
  for (const sc of SCENARIOS) assert.equal(runDay(sc, null).result.grade, 'F', sc.id);
});

test('every baseline policy (and the starter template) completes every scenario', () => {
  const starter = new Function(STARTER_POLICY + '\nreturn dispatch;')();
  for (const sc of SCENARIOS) {
    for (const b of [...BASELINES, { name: 'starter', fn: starter }]) {
      const { sim, result } = runDay(sc, b.fn);
      assert.equal(sim.t, DAY_MIN, `${b.name} on ${sc.id}`);
      assert.ok(result.complete);
      assert.ok(Number.isFinite(result.societal));
      for (const f of sim.hist.freq) assert.ok(Number.isFinite(f));
    }
  }
});

test('scenarios 1-2 are winnable: a baseline gets through with zero blackouts', () => {
  for (const id of ['spring', 'heatwave']) {
    const sc = getScenario(id);
    const clean = BASELINES.filter((b) => runDay(sc, b.fn).result.unservedMWh === 0);
    assert.ok(clean.length > 0, `${id}: no baseline avoided blackouts`);
  }
});

test('scenarios 3-5: a good hand-written policy beats every baseline', () => {
  for (const id of ['storm', 'windless', 'ai2030']) {
    const sc = getScenario(id);
    const mine = runDay(sc, expert).result;
    assert.equal(mine.unservedMWh, 0, `${id}: expert policy still caused blackouts`);
    for (const b of BASELINES) {
      const r = runDay(sc, b.fn).result;
      assert.ok(mine.societal < r.societal, `${id}: expert $${mine.societal.toFixed(0)} vs ${b.name} $${r.societal.toFixed(0)}`);
    }
  }
});

test('difficulty curve: the storm defeats every baseline', () => {
  for (const b of BASELINES) assert.ok(runDay(getScenario('storm'), b.fn).result.unservedMWh > 0, b.name);
});

test('par values are reachable (an A+ exists for every scenario)', () => {
  for (const sc of SCENARIOS) {
    const best = Math.min(...[...BASELINES.map((b) => b.fn), expert, reactive, tunedSimple].map((fn) => {
      const r = runDay(sc, fn).result;
      return r.unservedMWh > 0 ? Infinity : r.societal;
    }));
    assert.ok(best <= sc.par, `${sc.id}: best ${best.toFixed(0)} > par ${sc.par}`);
    assert.ok(best > sc.par * 0.97, `${sc.id}: par ${sc.par} is far too loose (best ${best.toFixed(0)})`);
  }
});

test('the starter template runs but leaves room to improve', () => {
  const starter = new Function(STARTER_POLICY + ';return dispatch;')();
  for (const sc of SCENARIOS) {
    const r = runDay(sc, starter).result;
    assert.ok(!['A+', 'A'].includes(r.grade), `${sc.id}: starter already scores ${r.grade}`);
  }
});

test('the README example is a starting point: never at or under par, and never an A+', () => {
  for (const sc of SCENARIOS) {
    const r = runDay(sc, readmeExample).result;
    assert.notEqual(r.grade, 'A+', `${sc.id}: README example gets an A+`);
    if (r.unservedMWh === 0) assert.ok(r.societal > sc.par * 1.01, `${sc.id}: README example is within 1% of par (${r.societal.toFixed(0)} vs ${sc.par})`);
  }
  // ...but it is a real policy: it keeps the lights on for the easy days
  for (const id of ['spring', 'heatwave', 'windless']) assert.equal(runDay(getScenario(id), readmeExample).result.unservedMWh, 0, id);
});

test('par is set by hidden reference policies, never by the README example', () => {
  for (const sc of SCENARIOS) {
    const hidden = Math.min(...[...BASELINES.map((b) => b.fn), expert, reactive, tunedSimple].map((fn) => {
      const r = runDay(sc, fn).result;
      return r.unservedMWh > 0 ? Infinity : r.societal;
    }));
    const mine = runDay(sc, readmeExample).result;
    assert.ok(mine.unservedMWh > 0 || mine.societal > hidden, `${sc.id}: README example beats every hidden reference`);
  }
});

test('hash parsing is total: a mangled link never throws and lands on the landing screen', () => {
  const ok = (id) => !!getScenario(id);
  for (const bad of ['#%zz', '#%', '#%E0%A4%A', '#heatwave%', '#code/%zz', '#nope', '#/', '#\u0000']) {
    const r = parseHash(bad, ok);
    assert.ok(['landing', 'code'].includes(r.view), bad + ' -> ' + JSON.stringify(r));
  }
  assert.equal(parseHash('#%zz', ok).view, 'landing');
  assert.equal(parseHash('', ok).view, 'landing');
  assert.equal(parseHash(undefined, ok).view, 'landing');
  assert.deepEqual(parseHash('#heatwave', ok), { view: 'game', id: 'heatwave' });
  assert.deepEqual(parseHash('#code/storm', ok), { view: 'code', id: 'storm' });
  assert.deepEqual(parseHash('#code', ok, () => 'windless'), { view: 'code', id: 'windless' });
  assert.deepEqual(parseHash('#code/bogus', ok), { view: 'code', id: 'heatwave' });
  assert.equal(parseHash('#play', ok).view, 'picker');
  assert.equal(parseHash('#tutorial', ok).view, 'tutorial');
  assert.equal(parseHash('#%68eatwave', ok).id, 'heatwave'); // valid escapes still decode
  assert.equal(parseHash('#HEATWAVE/', ok).id, 'heatwave', 'case and a trailing slash are forgiven');
  assert.equal(parseHash('#code/__proto__', ok).id, 'heatwave');
  assert.equal(parseHash('#__proto__', ok).view, 'landing');
});

test('dated daily links: #daily/DATE opens that grid, the future clamps to today, junk falls back to today', () => {
  const ok = (id) => !!getScenario(id);
  const today = '2026-12-05';
  const p = (h) => parseHash(h, ok, () => null, today);
  assert.deepEqual(p('#daily'), { view: 'game', id: 'daily', date: today });
  assert.deepEqual(p('#daily/'), { view: 'game', id: 'daily', date: today });
  assert.deepEqual(p('#daily/2026-11-17'), { view: 'game', id: 'daily', date: '2026-11-17' });
  assert.deepEqual(p('#DAILY/2026-11-17/'), { view: 'game', id: 'daily', date: '2026-11-17' });
  assert.deepEqual(p('#daily/2026-12-05'), { view: 'game', id: 'daily', date: today });
  assert.deepEqual(p('#code/daily'), { view: 'code', id: 'daily', date: today });
  assert.deepEqual(p('#code/daily/2026-11-18'), { view: 'code', id: 'daily', date: '2026-11-18' });
  // future dates clamp to today, and the address bar is repaired
  assert.deepEqual(p('#daily/2027-01-01'), { view: 'game', id: 'daily', date: today, canon: '#daily/' + today });
  assert.deepEqual(p('#code/daily/2099-01-01'), { view: 'code', id: 'daily', date: today, canon: '#code/daily/' + today });
  // malformed dates are today's grid too, never an error
  for (const bad of ['2026-13-99', '2026-02-30', '2026-1-5', '20261117', 'yesterday', '2026-11-17x', '0000-00-00', '1999-12-31', '-', '..']) {
    const r = p('#daily/' + bad);
    assert.equal(r.view, 'game', bad);
    assert.equal(r.id, 'daily', bad);
    assert.equal(r.date, today, bad);
  }
  assert.deepEqual(p('#daily/2026-13-99'), { view: 'game', id: 'daily', date: today, canon: '#daily/' + today });
  assert.equal(p('#daily/%zz').view, 'landing');
  assert.equal(p('#daily/2026-11-17/extra').view, 'landing');
  // validDateKey is a strict calendar check
  assert.ok(validDateKey('2026-11-17') && validDateKey('2028-02-29'));
  assert.ok(!validDateKey('2027-02-29') && !validDateKey('2026-00-10') && !validDateKey(20261117) && !validDateKey(null));
});

test('challenge links: a friend\'s grade and score ride along in the hash; junk is ignored, never a crash', () => {
  const ok = (id) => !!getScenario(id);
  const today = '2026-12-05';
  const p = (h) => parseHash(h, ok, () => null, today);
  assert.deepEqual(p('#daily/2026-11-17?g=B&s=11.3'), { view: 'game', id: 'daily', date: '2026-11-17', challenge: { g: 'B', s: 11.3 } });
  assert.deepEqual(p('#code/daily/2026-11-17?g=A%2B&s=10.62'), { view: 'code', id: 'daily', date: '2026-11-17', challenge: { g: 'A+', s: 10.6 } });
  assert.deepEqual(p('#daily?g=f&s=73.5').challenge, { g: 'F', s: 73.5 }, 'bare #daily works and the grade is case-insensitive');
  assert.equal(p('#daily/2027-01-01?g=B&s=11.3').date, today, 'a clamped date keeps the challenge');
  assert.deepEqual(p('#daily/2027-01-01?g=B&s=11.3').challenge, { g: 'B', s: 11.3 });
  // a hand-typed, unescaped "+" still reads as A+
  assert.deepEqual(p('#daily/2026-11-17?g=A+&s=10.6').challenge, { g: 'A+', s: 10.6 });
  for (const q of ['g=B', 's=11.3', 'g=Z&s=11.3', 'g=B&s=abc', 'g=B&s=-3', 'g=B&s=0', 'g=B&s=1e9', 'g=B&s=', 'g=&s=', 'g=B&s=Infinity', '&&&', '=', 'g=%zz&s=1', '__proto__=1', 'g=B&g=C&s=NaN', 'g=B%00&s=1', 'g=B&s=9'.repeat(50)]) {
    let r;
    assert.doesNotThrow(() => { r = p('#daily/2026-11-17?' + q); }, q);
    assert.equal(r.view, 'game', q);
    assert.equal(r.date, '2026-11-17', q);
    if (r.challenge) assert.ok(['A+', 'A', 'B', 'C', 'D', 'F'].includes(r.challenge.g) && r.challenge.s > 0 && r.challenge.s < 1000, q);
  }
  assert.equal(p('#heatwave?g=B&s=11.3').challenge, undefined, 'only dailies carry a challenge');
  // the tutorial can flow into a daily, keeping the date and the challenge
  assert.deepEqual(p('#tutorial'), { view: 'tutorial' });
  assert.deepEqual(p('#tutorial?then=daily'), { view: 'tutorial', then: 'daily' });
  assert.deepEqual(p('#tutorial?then=daily%2F2026-11-17&g=B&s=11.3'), { view: 'tutorial', then: 'daily/2026-11-17', challenge: { g: 'B', s: 11.3 } });
  assert.deepEqual(p('#tutorial?then=daily/2099-01-01'), { view: 'tutorial', then: 'daily/' + today });
  assert.deepEqual(p('#tutorial?then=javascript:alert(1)'), { view: 'tutorial' });
  assert.deepEqual(p('#tutorial?then=%zz'), { view: 'tutorial' });
  // and the share link round-trips through the parser
  globalThis.location = { href: 'https://example.com/hold60/' };
  const link = shareURL('daily', 'code', '2026-11-17', { grade: 'A+', societal: 10.62e6 });
  assert.deepEqual(p(link.slice(link.indexOf('#'))), { view: 'code', id: 'daily', date: '2026-11-17', challenge: { g: 'A+', s: 10.6 } });
});

test('first run: after the tutorial fix, autopilot (look-ahead) carries the day without a collapse', () => {
  const sc = tutorialScenario();
  const sim = new GridSim(sc);
  const fc = sim.forecast();
  const mem = {};
  // what the tutorial asks of a player: drag the peakers up in the first minutes, then watch
  while (sim.t < 20) sim.step({ ...holdPolicy(sim), peaker: 400 });
  while (!sim.done) {
    const s = sim.observe();
    s.forecast = fc;
    sim.step(lookAhead(s, mem));
  }
  const r = sim.result();
  assert.ok(r.unservedMWh < 1, `autopilot day left ${r.unservedMWh.toFixed(0)} MWh dark`);
  assert.ok(['A+', 'A', 'B', 'C'].includes(r.grade));
});

test('share text carries the numeric score and the gap to par', () => {
  globalThis.location = { href: 'https://example.com/hold60/' };
  const sc = getScenario('heatwave');
  const result = runDay(sc, tunedSimple).result;
  const text = shareText({ scenario: sc, result, mode: 'code' });
  assert.match(text, /\(my code\)/);
  assert.ok(text.includes('score ' + moneyM(result.societal)), text);
  assert.match(text, /[+−]\d+\.\d% vs par/);
  assert.equal(vsPar(110, 100), '+10.0% vs par');
  assert.equal(vsPar(95, 100), '−5.0% vs par');
  assert.equal(moneyM(10_391_000), '$10.39M');
});
