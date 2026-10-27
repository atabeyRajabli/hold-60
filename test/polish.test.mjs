import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkAction, locateSyntaxError, suggestKey, NONFINITE_PREFIX } from '../src/policy-check.js';
import { headroom, HEADROOM_FROM_HZ } from '../src/ui/dial.js';
import { computePars } from '../src/par-client.js';
import { placeCoachBox } from '../src/ui/coach-place.js';
import { referencePars } from '../src/reference.js';
import { dailyScenario } from '../src/daily.js';
import { OVERFREQ_HZ } from '../src/sim.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ---------------------------------------------------------------- code mode warnings

test('checkAction: a clean result, or returning nothing, has no warnings', () => {
  assert.deepEqual(checkAction({ coal: 1200, gas: 900, peaker: 0, wind: 3000, solar: 3500, battery: -300, dr: true, commit: { gas: 4 } }), []);
  assert.deepEqual(checkAction({ setpoints: { gas: 10 }, dr: false }), []);
  assert.deepEqual(checkAction(undefined, 'undefined'), []);
  assert.deepEqual(checkAction({ commit: null }), []);
});

test('checkAction: an unknown key is named, with a did-you-mean', () => {
  const w = checkAction({ gass: 900, coal: 100 });
  assert.equal(w.length, 1);
  assert.equal(w[0].key, 'gass');
  assert.match(w[0].text, /unknown key "gass"/);
  assert.match(w[0].text, /did you mean "gas"/);
  assert.equal(suggestKey('Peaker'), 'peaker');
  assert.equal(suggestKey('zzzzzz'), null);
  assert.match(checkAction({ nuclear: 1000 })[0].text, /nuclear cannot be dispatched/);
});

test('checkAction: NaN / Infinity markers and non-numbers name the key', () => {
  const w = checkAction({ gas: NONFINITE_PREFIX + 'NaN', coal: NONFINITE_PREFIX + '-Infinity', peaker: '500', battery: null, wind: [1] });
  const byKey = Object.fromEntries(w.map((x) => [x.key, x.text]));
  assert.match(byKey.gas, /"gas" is NaN/);
  assert.match(byKey.coal, /"coal" is -Infinity/);
  assert.match(byKey.peaker, /string "500"/);
  assert.match(byKey.battery, /null/);
  assert.match(byKey.wind, /an array/);
  assert.equal(w.length, 5);
});

test('checkAction: commit and setpoints are checked one level down', () => {
  const w = checkAction({ commit: { gass: 2, coal: NONFINITE_PREFIX + 'NaN', gas: 3 }, setpoints: { gas: NONFINITE_PREFIX + 'Infinity', peeker: 1 }, dr: 1 });
  const keys = w.map((x) => x.key).sort();
  assert.deepEqual(keys, ['commit.coal', 'commit.gass', 'dr', 'setpoints.gas', 'setpoints.peeker'].sort());
  assert.match(w.find((x) => x.key === 'commit.gass').text, /did you mean "commit.gas"/);
  assert.deepEqual(checkAction({ commit: 5 }).map((x) => x.key), ['commit']);
});

test('checkAction: a return value that is not an object warns once', () => {
  for (const kind of ['number', 'string', 'array', 'null', 'unserializable']) {
    const w = checkAction(null, kind);
    assert.equal(w.length, 1);
    assert.equal(w[0].id, 'return');
  }
});

test('checkAction: ids are stable, so the page can show each problem once', () => {
  const a = checkAction({ gass: 1 }), b = checkAction({ gass: 2 });
  assert.equal(a[0].id, b[0].id);
});

test('the worker marks non-finite numbers the way the page expects', () => {
  assert.ok(read('../src/policy-worker.js').includes(`NONFINITE_PREFIX = '${NONFINITE_PREFIX}'`));
});

// ---------------------------------------------------------------- syntax errors get a line

const lineOf = (src) => locateSyntaxError(src);

test('locateSyntaxError: valid code gives null', () => {
  assert.equal(lineOf('function dispatch(s) {\n  return { gas: 1 };\n}\n'), null);
});

test('locateSyntaxError: points at the offending line', () => {
  const src = 'function dispatch(state, memory) {\n  const x = 1;\n  const y = ;\n  return { gas: x };\n}\n';
  const r = lineOf(src);
  assert.equal(r.line, 3);
  assert.equal(r.atEnd, false);
  assert.equal(lineOf('function dispatch() {\n  return 1;\n}\n}\n').line, 4); // extra closing brace
  assert.equal(lineOf('const a = 1;\nconst a = 2;\nfunction dispatch() {}').line, 2); // redeclaration
  assert.equal(lineOf('function dispatch() {\n  let s = "abc;\n  return {};\n}').line, 2); // unterminated string
  assert.equal(lineOf('function dispatch() {\n  return { gas: 1,, coal: 2 };\n}').line, 2);
});

test('locateSyntaxError: an unclosed bracket is reported at the end of the code', () => {
  const r = lineOf('function dispatch(state) {\n  if (state.t > 5) {\n    return { gas: 1 };\n  \n\n');
  assert.equal(r.atEnd, true);
  assert.equal(r.line, 3);
});

test('locateSyntaxError: a block comment that is still open mid-file does not count as the error', () => {
  const src = '/* header\n   still a comment\n*/\nfunction dispatch() {\n  return { gas: 1 };\n}\nlet = = 3;\n';
  assert.equal(lineOf(src).line, 7);
});

test('locateSyntaxError: statements that continue on the next line, templates and regexes are not flagged', () => {
  const src = [
    'function dispatch(s) {',
    '  const y =',
    '    s.demand +',
    '    5;',
    '  const r = /[})]/.test("x");',
    '  return { gas: y,',
    '    coal: `a${s.t > 1 ? "}" : "{"}b`, };',
    '}',
    'let = = 1;',
  ].join('\n');
  assert.equal(lineOf(src).line, 9);
  assert.equal(lineOf('function dispatch() {\n  return {\n    gas: 1\n    coal: 2\n  };\n}').line, 4); // missing comma
});

test('locateSyntaxError: works with an injected compiler and never throws on odd input', () => {
  const compile = (s) => { if (s.includes('BAD')) throw new SyntaxError('Unexpected token'); };
  assert.equal(locateSyntaxError('a\nb\nBAD\nd', compile).line, 3);
  assert.equal(locateSyntaxError('', compile), null);
  assert.doesNotThrow(() => locateSyntaxError(undefined));
});

// ---------------------------------------------------------------- headroom cue

test('headroom: silent up to 60.3 Hz, warn above it, urgent within 0.1 Hz of the 60.5 trip', () => {
  assert.equal(HEADROOM_FROM_HZ, 60.3);
  assert.equal(OVERFREQ_HZ, 60.5);
  assert.equal(headroom(60), null);
  assert.equal(headroom(59.2), null);
  assert.equal(headroom(60.3), null);
  assert.equal(headroom(NaN), null);
  const w = headroom(60.34);
  assert.equal(w.level, 'warn');
  assert.ok(Math.abs(w.hz - 0.16) < 1e-9);
  assert.equal(w.text, 'Trip in 0.16 Hz');
  assert.equal(headroom(60.45).level, 'bad');
  const t = headroom(60.6);
  assert.equal(t.level, 'bad');
  assert.equal(t.hz, 0);
  assert.equal(t.text, 'Tripping');
});

// ---------------------------------------------------------------- daily par off the main thread

const par0 = { par: 10_400_000, codePar: 10_300_000 };

test('computePars: a worker answer is used as is', async () => {
  let posted = null;
  const makeWorker = () => {
    const w = { terminate() { this.dead = true; }, postMessage(m) { posted = m; queueMicrotask(() => w.onmessage({ data: { id: m.id, ok: true, pars: par0 } })); } };
    return w;
  };
  const r = await computePars({ x: 1 }, { makeWorker, compute: () => assert.fail('must not compute on the main thread') });
  assert.deepEqual(r, { ...par0, via: 'worker' });
  assert.deepEqual(posted.sc, { x: 1 });
});

test('computePars: falls back to the main thread when the worker cannot be created, errors, times out or answers badly', async () => {
  const compute = () => par0;
  const make = (behave) => () => {
    const w = { terminate() {}, postMessage() { behave(w); } };
    return w;
  };
  const cases = {
    'constructor throws': () => { throw new Error('no Worker'); },
    onerror: make((w) => queueMicrotask(() => w.onerror({ preventDefault() {} }))),
    'ok false': make((w) => queueMicrotask(() => w.onmessage({ data: { ok: false, message: 'boom' } }))),
    garbage: make((w) => queueMicrotask(() => w.onmessage({ data: 'hi' }))),
    silence: make(() => {}),
  };
  for (const [name, makeWorker] of Object.entries(cases)) {
    const r = await computePars({}, { makeWorker, compute, timeoutMs: 20 });
    assert.deepEqual(r, { ...par0, via: 'main' }, name);
  }
});

test('computePars: infinite par (no clean reference run) is passed through', async () => {
  const inf = { par: Infinity, codePar: Infinity };
  const makeWorker = () => { const w = { terminate() {}, postMessage(m) { queueMicrotask(() => w.onmessage({ data: { id: m.id, ok: true, pars: inf } })); } }; return w; };
  assert.equal((await computePars({}, { makeWorker })).par, Infinity);
});

test('a daily scenario survives structured clone and gives the same pars as the original', () => {
  const sc = dailyScenario('2026-11-18');
  const copy = structuredClone(sc);
  assert.deepEqual(referencePars(copy), referencePars(sc));
});

test('the page uses the worker path and keeps the synchronous fallback', () => {
  const app = read('../src/app.js');
  assert.match(app, /computePars\(sc\)/);
  assert.match(app, /referencePars\(sc\)/); // ensurePar fallback
  assert.match(read('../src/par-worker.js'), /referencePars/);
  assert.match(read('../src/par-client.js'), /type: 'module'/);
});

// ---------------------------------------------------------------- coach bubble vs chart legend

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const boxRect = (spot, w, h) => rect(spot.left, spot.top, w, h);

test('coach: below the target when nothing is in the way (the old behaviour)', () => {
  const spot = placeCoachBox({ target: rect(100, 10, 200, 40), size: { w: 320, h: 120 }, viewport: { w: 1360, h: 860 } });
  assert.equal(spot.side, 'below');
  assert.equal(spot.top, 60);
});

test('coach: desktop, the topbar speed control sits right above the legend, so the bubble moves clear of it', () => {
  const target = rect(1045, 8, 182, 36);
  const legend = rect(673, 83, 667, 16);
  const size = { w: 320, h: 140 };
  const naive = placeCoachBox({ target, size, viewport: { w: 1360, h: 860 } });
  assert.ok(overlaps(boxRect(naive, 320, 140), legend), 'the old placement did cover the legend');
  const spot = placeCoachBox({ target, size, viewport: { w: 1360, h: 860 }, avoid: [legend] });
  assert.ok(!overlaps(boxRect(spot, 320, 140), legend));
  assert.ok(spot.top + 140 <= 860);
});

test('coach: phone, a bubble under the topbar stays clear of a legend further down', () => {
  const target = rect(170, 6, 140, 36);
  const legend = rect(18, 550, 355, 60);
  const spot = placeCoachBox({ target, size: { w: 366, h: 132 }, viewport: { w: 390, h: 844 }, avoid: [legend] });
  assert.ok(!overlaps(boxRect(spot, 366, 132), legend));
  assert.ok(spot.left >= 12 && spot.left + 366 <= 390 - 12);
});

test('coach: when the legend sits just under the target and below does not fit, it goes above or clear', () => {
  const target = rect(100, 500, 200, 40);
  const legend = rect(80, 548, 300, 20);
  const spot = placeCoachBox({ target, size: { w: 300, h: 120 }, viewport: { w: 800, h: 700 }, avoid: [legend] });
  assert.ok(!overlaps(boxRect(spot, 300, 120), legend));
  assert.equal(spot.side, 'above');
});

test('coach: with nowhere clear it still returns a spot on screen', () => {
  const big = rect(0, 0, 400, 400);
  const spot = placeCoachBox({ target: rect(10, 10, 50, 20), size: { w: 300, h: 120 }, viewport: { w: 400, h: 400 }, avoid: [big] });
  assert.ok(Number.isFinite(spot.top) && Number.isFinite(spot.left));
});

// ---------------------------------------------------------------- footer links

test('landing and results carry the Source / How it works / MIT footer, with the placeholder README tells you to replace', () => {
  const html = read('../index.html');
  const blocks = html.split('class="site-links').slice(1);
  assert.equal(blocks.length, 2, 'landing and results');
  for (const b of blocks) {
    assert.match(b, /href="https:\/\/github\.com\/(<you>|[^/"]+)\/hold-60"[^>]*>Source</);
    assert.match(b, /hold-60#how-the-simulation-works"[^>]*>How it works</);
    assert.match(b, /href="LICENSE"[^>]*>MIT</);
  }
  const readme = read('../README.md');
  assert.match(readme, /^## How the simulation works$/m, 'the anchor the footer links to exists');
  assert.match(readme, /<you>/);
  assert.match(readme, /Replace the footer links/i);
});
