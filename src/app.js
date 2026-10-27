// Hold 60 — app shell: screens, game loop, manual play, code mode, results.

import { GridSim, runDay, DAY_MIN, F0, fmtTime, THERMAL, buildProfiles, GRADE_ORDER, VOLL, CARBON_PRICE } from './sim.js';
import { SCENARIOS, getScenario, tutorialScenario } from './scenarios.js';
import { BASELINES, STARTER_POLICY, dayAhead, lookAhead } from './policies.js';
import { createDial, statusOf, headroom } from './ui/dial.js';
import { createChart } from './ui/chart.js';
import { createMiniChart } from './ui/minichart.js';
import { createControls } from './ui/controls.js';
import { shareText, copyText, shareResult, canShare, money, moneyM, vsPar, tonnes, mwh } from './ui/share.js';
import { dailyKey, dailyScenario, dailyScenarioId, dailyNumber, dailyLabel, countRun, isStarterSource } from './daily.js';
import { referencePars } from './reference.js';
import { computePars } from './par-client.js';
import { unpackGhost, makeGhost, isBetterRun } from './ghost.js';
import { setSound, setHum, alarm, soundOn } from './ui/audio.js';
import { PolicyRunner, PolicyError } from './policy-runner.js';
import { checkAction } from './policy-check.js';
import { placeCoachBox } from './ui/coach-place.js';
import { parseHash } from './route.js';

const TICKS_PER_SEC = 10; // at 1x one simulated hour takes 6 seconds, a day 2.4 minutes
const $ = (s) => document.querySelector(s);
document.getElementById('boot-msg')?.remove(); // the module loaded, so the "serve over http" hint is not needed
const fmt = (x) => Math.round(x).toLocaleString('en-US');

const store = {
  get(k, d = null) { try { const v = localStorage.getItem('hold60.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hold60.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem('hold60.' + k); } catch { /* private mode */ } },
};

// ------------------------------------------------------------------ theme

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
applyTheme(store.get('theme'));
function isDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}
function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  store.set('theme', next);
  applyTheme(next);
  chart?.refreshColors();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => chart?.refreshColors());

function setStatusColor(level) {
  document.documentElement.style.setProperty('--status', `var(--${level})`);
}

// ------------------------------------------------------------------ screens

const screens = { landing: $('#screen-landing'), picker: $('#screen-picker'), game: $('#screen-game') };
let screen = null;
function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  screen = name;
  document.documentElement.classList.toggle('in-game', name === 'game'); // no pull-to-refresh mid-day
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ landing demo

const landingDial = createDial($('#landing-dial'));
let demo = null;
function newDemo() {
  const sim = new GridSim(getScenario('heatwave'), { seed: 2207 });
  const fc = sim.forecast();
  const mem = {};
  while (sim.t < 15 * 60) { const s = sim.observe(); s.forecast = fc; sim.step(dayAhead(s, mem)); }
  return { sim, fc, mem, acc: 0, f: F0 };
}
function landingTick(dt) {
  if (!demo || demo.sim.done) demo = newDemo();
  demo.acc += dt * 8;
  while (demo.acc >= 1 && !demo.sim.done) {
    demo.acc--;
    const s = demo.sim.observe();
    s.forecast = demo.fc;
    demo.sim.step(dayAhead(s, demo.mem));
  }
  const target = F0 + demo.sim.df;
  demo.f += (target - demo.f) * (1 - Math.exp(-dt * 6));
  // a little mechanical jitter so the needle feels alive
  const jitter = Math.sin(performance.now() / 170) * 0.006 + Math.sin(performance.now() / 53) * 0.003;
  landingDial.set(demo.f + jitter);
  $('#landing-hz').textContent = (demo.f + jitter).toFixed(2);
  const lvl = statusOf(demo.f, demo.sim.shed.length > 0);
  setStatusColor(lvl);
  $('#landing-status').textContent = demo.sim.shed.length ? 'shedding load' : lvl === 'ok' ? 'stable' : 'strained';
}

/** The grid is the same for everyone on a UTC calendar date. Records are per date and per mode. */
const dailyRecord = (key, mode) => store.get(`daily.${key}.${mode}`);

function renderLanding() {
  const key = dailyKey();
  const base = getScenario(dailyScenarioId(key));
  const rec = dailyRecord(key, 'manual') || dailyRecord(key, 'code');
  const first = !store.get('tutorialDone'); // never finished the tutorial: teach first, then today's grid
  const btn = $('#btn-daily');
  btn.href = first ? '#tutorial?then=daily' : '#daily';
  btn.firstChild.nodeValue = first ? 'Learn the grid, 30 s ' : "Today's grid ";
  $('#daily-tag').textContent = (first ? 'then ' : '') + 'Daily #' + dailyNumber(key);
  const line = $('#daily-line');
  line.textContent = '';
  const b = document.createElement('b');
  b.textContent = dailyLabel(key);
  line.append(b, ` · ${base.name} · new grid at 00:00 UTC`);
  if (rec) {
    const done = document.createElement('span');
    done.className = 'done';
    done.textContent = ` · Best today: ${rec.grade}, ${moneyM(rec.societal)}`;
    line.append(done);
  }
  const tut = $('#link-tutorial');
  tut.textContent = first ? "Skip to today's grid" : '30-second tutorial';
  tut.href = first ? '#daily' : '#tutorial';
}
// a tab left open across UTC midnight should not keep showing yesterday's grid
const refreshLanding = () => { if (screen === 'landing') renderLanding(); };
document.addEventListener('visibilitychange', refreshLanding);
addEventListener('focus', refreshLanding);

// ------------------------------------------------------------------ picker

function sparkPath(sc) {
  const p = buildProfiles(sc);
  let max = 0, min = Infinity;
  const pts = [];
  for (let m = 0; m < DAY_MIN; m += 20) {
    const d = p.demandF[m], n = d - p.windF[m] - p.solarF[m];
    pts.push([m, d, n]);
    max = Math.max(max, d);
    min = Math.min(min, n);
  }
  min = Math.min(0, min);
  const x = (m) => (m / DAY_MIN) * 300;
  const y = (v) => 40 - ((v - min) / (max - min)) * 36;
  const line = (k) => pts.map((q, i) => `${i ? 'L' : 'M'}${x(q[0]).toFixed(1)} ${y(q[k]).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 300 42" preserveAspectRatio="none" aria-hidden="true">
    <path d="${line(1)}" style="stroke:var(--muted);stroke-width:1.5;stroke-dasharray:4 3" vector-effect="non-scaling-stroke"/>
    <path d="${line(2)}" style="stroke:var(--ink);stroke-width:2" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderPicker() {
  const list = $('#scenario-list');
  const dk = dailyKey(), dbase = getScenario(dailyScenarioId(dk));
  const today = `<li class="scenario">
      <span class="num">DAILY #${dailyNumber(dk)} · ${dailyLabel(dk)}</span>
      <h2>Today's grid: ${dbase.name}</h2>
      <p>The same grid for everyone today, with one surprise outage that is not in the forecast. Your best finished run counts.</p>
      <div class="actions"><a class="btn btn-primary btn-small" href="#daily">Play today</a><a class="btn btn-small" href="#code/daily">Write code</a></div>
    </li>`;
  list.innerHTML = today + SCENARIOS.map((sc) => {
    const best = store.get('best.' + sc.id);
    const dots = [1, 2, 3, 4, 5].map((i) => `<i class="${i <= sc.order ? 'on' : ''}"></i>`).join('');
    return `<li class="scenario">
      <span class="num">DAY ${sc.order}</span>
      <h2>${sc.name}</h2>
      ${best ? `<span class="best" title="Your best grade">${best.grade}${best.mode === 'code' ? ' ⌨' : ''}</span>` : ''}
      <p>${sc.blurb}</p>
      ${sparkPath(sc)}
      <div class="meta"><span class="diff" aria-label="Difficulty ${sc.order} of 5">${dots}</span><span>peak ${fmt(sc.peakMW + (sc.flatLoadMW || 0))} MW</span><span>solid: net demand</span></div>
      <div class="actions"><a class="btn btn-primary btn-small" href="#${sc.id}">Play</a><a class="btn btn-small" href="#code/${sc.id}">Write code</a></div>
    </li>`;
  }).join('');
}

// ------------------------------------------------------------------ game

const dial = createDial($('#dial'));
const miniDial = createDial($('#mini-dial'));
const miniChart = createMiniChart($('#mini-chart'));
const chart = createChart($('#chart'), $('#legend'));
let game = null;
let controls = null;
const runner = new PolicyRunner({ onLog: (t) => consoleLine(t) });

// build 20 houses once
$('#houses').innerHTML = Array.from({ length: 20 }, () => '<i class="house"></i>').join('');
const houseEls = [...document.querySelectorAll('#houses .house')];

/** The route id of a scenario object ("daily" for today's variant). */
const routeId = (sc) => (sc.daily ? 'daily' : sc.id);
const ghostKey = (sc) => (sc.daily ? 'daily.' + sc.daily.key : 'sc.' + sc.id);
const loadGhost = (g) => (g.tutorial ? null : unpackGhost(store.get('ghost.' + ghostKey(g.sc))?.f));

/** Store a daily's par on its scenario. Infinite (no blackout-free reference run) means 0: no par, any clean run grades A. */
function applyPars(sc, p) {
  sc.par = Number.isFinite(p.par) ? p.par : 0;
  sc.codePar = Number.isFinite(p.codePar) ? p.codePar : 0;
  sc.parReady = true;
  sc.parVia = p.via || 'main';
}

/**
 * Daily variants have no hand-tuned par: derive it from our reference policies (about 0.3 s, cached on the scenario).
 * This is the synchronous path, used only when the worker's answer has not arrived by the time one is needed.
 */
function ensurePar(sc) {
  if (!sc.daily || sc.parReady) return;
  applyPars(sc, referencePars(sc));
}

/** Start the same computation in a Web Worker as soon as a daily opens, so the main thread never stalls on it. */
function warmPar(sc) {
  if (!sc.daily || sc.parReady || sc.parWarming) return;
  sc.parWarming = true;
  computePars(sc).then((p) => { if (!sc.parReady) applyPars(sc, p); }).catch(() => { /* ensurePar computes it when needed */ });
}

function startGame(scId, mode, { tutorial = false, date = null, challenge = null, then = null } = {}) {
  runner.stop();
  hideCoach();
  hideHint();
  const sc = tutorial ? tutorialScenario() : scId === 'daily' ? dailyScenario(date || dailyKey()) : getScenario(scId);
  if (!sc) { location.hash = '#play'; return; }
  const sim = new GridSim(sc);
  game = {
    sc, sim, mode, tutorial, speed: 0, acc: 0, f: F0, ended: false, busy: false,
    setpoints: {}, drPending: false, logSeen: 0, hints: new Set(), lastHintT: -999,
    lastDrawT: -1, minF: F0, maxF: F0, tutStep: 0, slow: false, runId: 0, aborted: false, autopilot: false, autoUsed: false, needSync: false,
    challenge, then, actLog: [], autoPaused: false, hooked: false,
  };
  for (const id of THERMAL) game.setpoints[id] = sim.units[id].target;
  game.setpoints.wind = sim.ren.wind.target;
  game.setpoints.solar = sim.ren.solar.target;
  game.setpoints.battery = 0;

  show('game');
  chart.setGhost(loadGhost(game));
  warmPar(sc);
  setGameTitle(tutorial ? 'Tutorial' : sc.daily ? `Daily #${sc.daily.n}` : sc.name, tutorial || sc.daily ? sc.name : '');
  showChallenge(game);
  $('#mode-badge').hidden = mode !== 'code';
  setEnded(false);
  setAutopilot(false);
  $('#panel-controls').hidden = mode === 'code';
  $('#panel-code').hidden = mode !== 'code';
  $('#feed').innerHTML = '';
  document.title = sc.daily ? `Daily #${sc.daily.n} · ${sc.name} · Hold 60` : `${sc.name} · Hold 60`;

  if (mode === 'manual') {
    controls = createControls($('#controls'), sim, onControl);
    controls.syncInputs();
    controls.update();
  } else {
    controls = null;
    setupCodePanel();
  }
  setSpeed(0);
  chart.draw(sim);
  renderGame(0, true);

  if (tutorial) startTutorial();
  else if (mode === 'manual') {
    const saved = sc.daily ? loadProgress(sc) : null;
    if (saved) {
      coach(`<b>Resume your run?</b> Daily #${sc.daily.n} was at ${fmtTime(saved.t)} when you left.`, $('.speed'), {
        button: 'Resume your run', onButton: () => resumeRun(saved),
        button2: 'Start over', onButton2: () => { clearProgress(); showIntro(); },
      });
    } else showIntro();
  }
}

function showIntro() {
  const g = game, sc = g.sc;
  const rec = sc.daily ? dailyRecord(sc.daily.key, 'manual') : null;
  const intro = sc.daily
    ? `<b>Daily #${sc.daily.n}: ${sc.name}.</b> ${sc.tip} ${rec ? `Your best so far is ${rec.grade}, ${moneyM(rec.societal)}; a better run replaces it.` : 'Your best finished run counts.'}`
    : `<b>${sc.name}.</b> ${sc.tip}`;
  // two-column layout: anchor under the dial panel (open space), because the topbar sits right above the chart legend
  const wide = matchMedia('(min-width: 980px)').matches;
  const go = { button: 'Start the day', onButton: () => { hideCoach(); setSpeed(1); } };
  if (wide) coach(intro, null, { ...go, anchor: $('.panel-dial') });
  else coach(intro, $('.speed'), go);
}

/** "Daily #1" plus the scenario name, which phones drop to keep the title readable. */
function setGameTitle(main, rest = '') {
  const t = $('#game-title');
  t.textContent = main;
  if (rest) {
    const span = document.createElement('span');
    span.className = 't-name';
    span.textContent = ' · ' + rest;
    t.append(span);
  }
}

// ---- "a friend got B": the banner a shared daily link opens with
function showChallenge(g) {
  const el = $('#challenge');
  const c = g.challenge;
  el.hidden = !(c && g.sc.daily && !g.tutorial);
  if (el.hidden) return;
  $('#challenge-text').textContent = `A friend got ${c.g} ($${c.s.toFixed(1)}M) on Daily #${g.sc.daily.n} — can you beat it?`;
  const tut = $('#challenge-tut');
  tut.hidden = !!store.get('tutorialDone') || g.mode !== 'manual';
  tut.href = `#tutorial?then=daily/${g.sc.daily.key}&g=${encodeURIComponent(c.g)}&s=${c.s}`;
}
$('#challenge-x').addEventListener('click', () => { $('#challenge').hidden = true; });

// ---- resume: an in-progress manual daily run is saved every game-hour (and when the tab is hidden)
// The day is a pure function of (scenario, seed, actions), so the control changes are all we need to store.
const ACT_IDS = new Set([...THERMAL, 'wind', 'solar', 'battery', 'dr']);
function saveProgress() {
  const g = game;
  if (!g || screen !== 'game' || g.mode !== 'manual' || !g.sc.daily || g.tutorial || g.ended || g.hooked || g.sim.t < 1) return;
  store.set('progress', { date: g.sc.daily.key, t: g.sim.t, log: g.actLog, hints: [...g.hints], ap: g.autoPaused });
}
function clearProgress() { store.del('progress'); }
function loadProgress(sc) {
  const p = store.get('progress');
  if (!p || p.date !== sc.daily.key || !Number.isInteger(p.t) || p.t < 1 || p.t >= DAY_MIN || !Array.isArray(p.log)) return null;
  const log = p.log.filter((e) => Array.isArray(e) && Number.isFinite(e[0]) && e[0] >= 0 && ACT_IDS.has(e[1]) && Number.isFinite(e[2]));
  return { t: p.t, log, hints: Array.isArray(p.hints) ? p.hints.filter((h) => typeof h === 'string') : [], ap: !!p.ap };
}
function resumeRun(saved) {
  const g = game, sim = g.sim;
  try {
    const sp = g.setpoints;
    let i = 0, dr = false;
    const apply = (upTo) => {
      while (i < saved.log.length && saved.log[i][0] <= upTo) {
        const [, id, v] = saved.log[i++];
        if (id === 'dr') dr = true; else sp[id] = v;
      }
    };
    for (let m = 0; m < saved.t; m++) {
      dr = false;
      apply(m);
      const a = { ...sp };
      if (dr) a.dr = true;
      sim.step(a);
    }
    dr = false;
    apply(saved.t);
    g.drPending = dr;
    g.actLog = saved.log;
    g.hints = new Set(saved.hints);
    g.autoPaused = saved.ap;
  } catch (err) {
    console.error(err);
    clearProgress();
    startGame('daily', 'manual', { date: g.sc.daily.key, challenge: g.challenge });
    return;
  }
  g.logSeen = sim.log.length;
  $('#feed').innerHTML = '';
  for (const e of sim.log.slice(-4)) feed(e);
  const from = Math.max(0, sim.t - 60);
  g.minF = Math.min(...sim.hist.freq.slice(from, sim.t));
  g.maxF = Math.max(...sim.hist.freq.slice(from, sim.t));
  g.f = F0 + sim.df;
  controls.syncInputs();
  chart.draw(sim);
  renderGame(0, true);
  coach(`Back at <b>${fmtTime(sim.t)}</b>, paused. Look around, then carry on.`, $('.speed'), { button: 'Continue', onButton: () => { hideCoach(); setSpeed(1); } });
}
addEventListener('pagehide', saveProgress);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveProgress(); });

function onControl(id, value) {
  if (!game || game.ended) return;
  if (game.autopilot) setAutopilot(false); // touching anything takes over; the sliders already show the autopilot's targets
  logAction(id, id === 'dr' ? 1 : value);
  if (id === 'dr') { game.drPending = true; return; }
  game.setpoints[id] = value;
}

/** Control changes of a daily run, for "Resume your run". Dragging fires many events a minute; only the last per control counts. */
function logAction(id, value) {
  const g = game, log = g.actLog, t = g.sim.t;
  if (!g.sc.daily || g.tutorial) return;
  const last = log[log.length - 1];
  if (last && last[0] === t && last[1] === id) last[2] = value;
  else log.push([t, id, value]);
}

function setSpeed(s) {
  if (!game) return;
  if (game.speed > 0) game.lastSpeed = game.speed; // remembered for Space
  game.speed = s;
  for (const b of document.querySelectorAll('.speed-btn')) b.setAttribute('aria-pressed', String(+b.dataset.speed === s));
}

for (const b of document.querySelectorAll('.speed-btn')) {
  b.addEventListener('click', () => {
    if (!game) return;
    const s = +b.dataset.speed;
    if (game.fast) return;
    if (game.mode === 'code' && !game.running && s > 0) { runWatch(s); return; }
    if (s > 0 && game.introPending) hideCoach();
    setSpeed(s);
  });
}

/** Autopilot: the look-ahead baseline flies the day until the player touches a control. */
function setAutopilot(on) {
  const g = game;
  if (!g) return;
  g.autopilot = on;
  if (on) {
    g.autoUsed = true;
    g.autoMem = {};
    g.autoFc = g.sim.forecast();
    g.needSync = true;
  }
  $('#autopilot').hidden = !on;
  $('#plants-hint').hidden = on;
}

function setEnded(ended) {
  $('#btn-results').hidden = !ended;
  document.querySelector('.speed').hidden = ended;
  controls?.setDisabled(ended);
}

function stepManual() {
  const g = game;
  if (g.autopilot) {
    const s = g.sim.observe();
    s.forecast = g.autoFc;
    g.sim.step(lookAhead(s, g.autoMem));
    // mirror its targets onto the sliders so taking over doesn't jump anything
    for (const id of THERMAL) g.setpoints[id] = g.sim.units[id].target;
    for (const id of ['wind', 'solar']) g.setpoints[id] = g.sim.ren[id].target;
    g.setpoints.battery = g.sim.battery.setpoint;
    g.needSync = true;
    afterStep();
    return;
  }
  const action = { ...g.setpoints };
  if (g.drPending) { action.dr = true; g.drPending = false; }
  g.sim.step(action);
  afterStep();
}

function afterStep() {
  const g = game, sim = g.sim;
  const f = F0 + sim.df;
  g.minF = Math.min(g.minF * 0.999 + f * 0.001, f);
  g.maxF = Math.max(g.maxF * 0.999 + f * 0.001, f);
  // new log entries
  while (g.logSeen < sim.log.length) {
    const e = sim.log[g.logSeen++];
    feed(e);
    if ((e.type === 'shed' || e.type === 'trip') && autoPause(e)) continue;
    if (e.type === 'shed') { alarm(); hint('shed', 'Below 59.3 Hz, load was shed: 5% of customers lost power. They come back after 20 minutes of healthy frequency.'); }
    if (e.type === 'trip') hint('trip', 'Game rule: above 60.5 Hz a generator trips. Now you are short, fast.');
    if (e.type === 'load') hint('load', 'The AI campus just paused. Demand fell off a cliff, so frequency jumps. A battery with room to charge soaks this up.');
  }
  if (g.mode === 'manual') manualHints();
  if (g.mode === 'manual' && sim.t % 60 === 0 && !sim.done) saveProgress();
  if (sim.done) endGame();
}

/** The first blackout or trip of a manual run stops the clock once, with a one-line why. Returns true when it paused. */
function autoPause(e) {
  const g = game;
  if (g.mode !== 'manual' || g.tutorial || g.autopilot || g.autoPaused || g.ended) return false;
  g.autoPaused = true;
  alarm();
  setSpeed(0);
  const why = e.type === 'shed'
    ? 'Frequency fell below 59.3 Hz, so <b>5% of customers lost power</b>. They return after 20 healthy minutes, and more go dark while it stays low.'
    : 'Frequency went above 60.5 Hz, so <b>a generator tripped</b>. That is a game rule against overshooting, and now you are short on supply.';
  coach(`<b>Paused at ${fmtTime(e.t)}.</b> ${why} Raise gas or peakers, or call demand response.`, null, { button: 'Resume', onButton: () => { hideCoach(); setSpeed(g.lastSpeed || 1); } });
  return true;
}

function manualHints() {
  const g = game, sim = g.sim;
  if (g.tutorial && g.tutStep < 3) return;
  const df = sim.df;
  if (df > 0.2) hint('high', 'Frequency is running high: more power than demand. Lower a plant, charge the battery, or curtail solar.');
  if (df < -0.25) hint('low', 'Frequency is sagging: demand is beating supply. Raise gas or peakers. Peakers start in 10 minutes, gas takes an hour.');
  if (sim.battery.soc / sim.f.battery.mwh < 0.1 && sim.t > 30) hint('battery', 'Battery almost empty. It cannot cushion the needle much longer.');
  const set = g.sc.solar.set * 60;
  if (sim.t === Math.round(set - 180)) hint('sunset', 'Sunset in 3 hours. Solar fades while evening demand peaks. Gas units need an hour to start, so look ahead.');
}

function feed(e) {
  const cls = { shed: 'bad', trip: 'bad', outage: 'bad', restore: 'good', return: 'good', dr: 'good', weather: 'warn', load: 'warn' }[e.type] || '';
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = `<time>${fmtTime(e.t)}</time><span></span>`;
  li.lastChild.textContent = e.msg;
  const list = $('#feed');
  list.prepend(li);
  while (list.children.length > 4) list.lastChild.remove();
}

// ------------------------------------------------------------------ rendering

let lastTextUpdate = 0;
function renderGame(dt, force = false) {
  const g = game, sim = g.sim;
  const target = F0 + sim.df;
  g.f += (target - g.f) * (dt ? 1 - Math.exp(-dt * 10) : 1);
  const running = g.speed > 0 && !g.ended;
  const jitter = running ? Math.sin(performance.now() / 140) * 0.004 : 0;
  dial.set(g.f + jitter);
  dial.trace(g.minF, g.maxF);
  dial.headroom(g.f);
  if (miniOn) { miniDial.set(g.f + jitter); miniDial.headroom(g.f); }
  setHum(g.f, running);

  const now = performance.now();
  if (!force && now - lastTextUpdate < 90) return;
  lastTextUpdate = now;
  const shedding = sim.shed.length > 0;
  const room = shedding ? null : headroom(target);
  const lvl = room ? room.level : statusOf(target, shedding);
  setStatusColor(lvl);
  $('#hz').textContent = (g.f + jitter).toFixed(2);
  $('#mini-hz-val').textContent = (g.f + jitter).toFixed(2);
  const st = $('#status');
  st.className = 'status ' + lvl;
  // above 60.3 Hz the pill counts down to the trip, in the same warn / bad styling as the sagging and shed states
  st.textContent = shedding ? 'Load shed' : room ? room.text : lvl === 'ok' ? 'Stable' : target < 60 ? 'Sagging' : 'Running high';
  const clock = fmtTime(sim.t);
  $('#clock').textContent = clock;
  $('#mini-clock').textContent = clock;
  const L = sim.last;
  $('#st-demand').textContent = fmt(L.demand);
  $('#st-gen').textContent = fmt(L.gen);
  // shown as exactly Generation minus Demand, so the three numbers always add up
  const imb = Math.round(L.gen) - Math.round(L.demand);
  const imbEl = $('#st-imb');
  imbEl.textContent = (imb >= 0 ? '+' : '−') + fmt(Math.abs(imb));
  imbEl.parentElement.className = Math.abs(imb) < 60 ? '' : imb > 0 ? 'pos' : 'neg';
  $('#mini-imb').textContent = (imb >= 0 ? '+' : '−') + fmt(Math.abs(imb)) + ' MW';
  $('#st-cost').textContent = moneyM(sim.totals.cost + sim.totals.unservedMWh * VOLL + sim.totals.co2 * CARBON_PRICE);
  $('#st-co2').textContent = fmt(sim.totals.co2);
  $('#st-dark').textContent = fmt(sim.totals.unservedMWh);
  const dark = sim.shed.length;
  houseEls.forEach((h, i) => h.classList.toggle('dark', i >= 20 - dark));
  $('#town-pct').textContent = `${100 - dark * 5}% lit`;
  if (controls) {
    if (g.needSync) { controls.syncInputs(); g.needSync = false; }
    controls.update();
  }
  if (sim.t !== g.lastDrawT) { chart.draw(sim); if (miniOn) miniChart.draw(sim); g.lastDrawT = sim.t; }
}

// ------------------------------------------------------------------ main loop

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame); // first, so one bad frame can't stop the loop
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (screen === 'landing') landingTick(dt);
  else if (screen === 'game' && game) {
    const g = game;
    const modalOpen = $('#results').open || $('#help').open;
    if (!g.ended && g.speed > 0 && !modalOpen) {
      g.acc += dt * TICKS_PER_SEC * g.speed * (g.slow ? 0.5 : 1);
      let n = Math.floor(g.acc);
      if (n > 16) { n = 16; g.acc = 0; } else g.acc -= n;
      if (g.mode === 'manual') {
        for (let i = 0; i < n && !g.ended && g.speed > 0; i++) stepManual();
      } else if (g.running && !g.busy && n > 0) {
        g.busy = true;
        stepPolicy(n, g.runId).finally(() => { g.busy = false; });
      }
    }
    if (g.tutorial) tutorialTick();
    renderGame(dt);
  }
}

// ------------------------------------------------------------------ results

const GRADE_COPY = {
  'A+': 'Flawless. Lights on all day, at or under par, the score of our best reference policy.',
  A: 'Excellent. Lights on all day, within a few percent of par.',
  B: 'Lights stayed on, but it cost more money and CO₂ than it needed to.',
  C: 'Some customers went dark, or you burned a lot to keep them lit.',
  D: 'Rolling blackouts. The news vans are outside the control room.',
  F: 'The grid collapsed. Large parts of the region went dark.',
};

function endGame() {
  const g = game;
  if (g.ended) return;
  g.ended = true;
  g.running = false;
  runner.stop();
  setSpeed(0);
  setAutopilot(false);
  setEnded(true);
  renderGame(0, true);
  chart.draw(g.sim);
  ensurePar(g.sc);
  const result = g.sim.result();
  g.result = result;
  const prev = store.get('best.' + g.sc.id);
  const assisted = g.tutorial && g.autoUsed; // autopilot helped, so it doesn't count as your best
  if (!assisted && !g.sc.daily && (!prev || GRADE_ORDER.indexOf(result.grade) < GRADE_ORDER.indexOf(prev.grade))) {
    store.set('best.' + g.sc.id, { grade: result.grade, mode: g.mode });
  }
  // today's grid: the counted run per mode is your BEST finished run of that date (not the first), and a
  // run of the untouched starter template never counts
  g.countStatus = null;
  if (g.sc.daily && !g.tutorial) {
    const k = `daily.${g.sc.daily.key}.${g.mode}`;
    const prev = store.get(k);
    const c = countRun(prev, result, { template: g.mode === 'code' && isStarterSource(g.runSource, STARTER_POLICY), par: g.sc.par });
    g.countStatus = c.status;
    g.counted = c.record;
    g.prevBest = prev;
    if (c.status !== 'template' && c.record) store.set(k, c.record);
    if (g.mode === 'manual') clearProgress();
  }
  // the ghost is your best finished run of this exact day (same scenario and seed), never an assisted one
  if (!g.tutorial && !assisted && g.countStatus !== 'template') {
    const gk = 'ghost.' + ghostKey(g.sc);
    if (isBetterRun(result, store.get(gk))) store.set(gk, makeGhost(result, g.sim.hist.freq));
  }
  if (g.tutorial) store.set('tutorialDone', true);
  if (g.mode === 'code') renderCompare(result);
  setTimeout(() => { if (game === g) showResults(); }, 500);
}

function baselineResults(sc) {
  if (!baselineResults.cache) baselineResults.cache = {};
  if (!baselineResults.cache[sc.id]) {
    baselineResults.cache[sc.id] = BASELINES.map((b) => ({ name: b.name, result: runDay(sc, b.fn).result }));
  }
  return baselineResults.cache[sc.id];
}

/** Blackout energy without a unit, so the column stays narrow ("6,389", "12.3k"). */
const darkMWh = (x) => (x < 0.5 ? '0' : x >= 10000 ? (x / 1000).toFixed(1) + 'k' : Math.round(x).toLocaleString('en-US'));

function compareTable(result, sc) {
  ensurePar(sc);
  const rows = [{ name: 'Your code', result, you: true }, ...baselineResults(sc)];
  const best = Math.min(...rows.map((r) => r.result.societal));
  const rel = (x, p) => (p ? vsPar(x, p).replace(' vs par', '') : '–');
  // default columns: Policy, Dark, Score, vs code par, Grade. Fuel, CO₂ and vs par sit behind "Details".
  const gap = sc.codePar
    ? { head: 'vs code par', tip: 'Gap to the best score we know of from any policy, including a hidden gas-first one', par: sc.codePar }
    : { head: 'vs par', tip: 'Gap to par, which sets your grade', par: sc.par };
  const parCol = sc.codePar;
  return `<div class="cmp"><div class="compare-wrap"><table class="cmp-table">
    <thead><tr><th>Policy</th><th title="Energy not served, MWh">Dark<small> MWh</small></th><th title="Fuel &amp; ops + $10k per MWh unserved + $100 per t CO₂">Score*</th><th title="${gap.tip}">${gap.head}</th><th>Grade</th>
      <th class="dcol" title="Fuel, start-ups, battery wear and DR">Fuel &amp; ops</th><th class="dcol">CO₂</th>${parCol ? '<th class="dcol" title="Gap to par, which sets your grade">vs par</th>' : ''}</tr></thead>
    <tbody>${rows.map((r) => `<tr class="${r.you ? 'you' : ''}">
      <td>${r.name}</td><td>${darkMWh(r.result.unservedMWh)}</td>
      <td class="${r.result.societal === best ? 'win' : ''}">${moneyM(r.result.societal)}</td><td>${rel(r.result.societal, gap.par)}</td><td>${r.result.grade}</td>
      <td class="dcol">${money(r.result.cost)}</td><td class="dcol">${tonnes(r.result.co2)}</td>${parCol ? `<td class="dcol">${rel(r.result.societal, sc.par)}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>
    <button type="button" class="cmp-toggle" aria-expanded="false" data-label="Details: fuel, CO₂${parCol ? ', vs par' : ''}">Details: fuel, CO₂${parCol ? ', vs par' : ''}</button>
    <p class="muted small">*Score (lower is better) = fuel &amp; ops + $10,000 per MWh of blackout + $100 per tonne CO₂. Par (an A+): ${sc.par ? moneyM(sc.par) : 'none'}, the best of the reference policies the grade is measured against. <b>Code par: ${sc.codePar ? moneyM(sc.codePar) : 'none'}</b>, the best score we know of from any policy, including a gas-first one. It is the target for code, and it can be beaten.</p></div>`;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.cmp-toggle');
  if (!btn) return;
  const cmp = btn.closest('.cmp');
  const open = cmp.classList.toggle('open');
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? 'Hide details' : btn.dataset.label;
});

function renderCompare(result) {
  $('#compare').innerHTML = compareTable(result, game.sc);
}

function showResults() {
  const g = game, r = g.result, sc = g.sc;
  $('#res-kicker').textContent = sc.daily ? `Daily #${sc.daily.n} · ${dailyLabel(sc.daily.key)}${g.mode === 'code' ? ' · your code' : ''}` : g.mode === 'code' ? 'Your code ran the day' : g.tutorial ? (g.autoUsed ? 'Tutorial day complete (autopilot flew most of it)' : 'Tutorial day complete') : 'Day complete';
  $('#res-title').textContent = sc.name;
  const dEl = $('#res-daily');
  dEl.hidden = !sc.daily || g.tutorial;
  if (sc.daily) {
    const c = g.counted, st = g.countStatus, n = sc.daily.n;
    const chip = (cls, t) => `<span class="${cls}">${t}</span>`;
    const best = c ? `<b>${c.grade}</b>, ${moneyM(c.societal)}` : '';
    let html = '';
    if (st === 'template') html = `${chip('practice', 'Template')}This is the starter template, so it is not counted. Edit it and run again: your best finished run of Daily #${n} counts.${c ? ` Best so far: ${best}.` : ''}`;
    else if (st === 'first') html = `${chip('counts', 'Counts for today')}Your best finished run of Daily #${n} counts, so a better run replaces this one. Play again and race it (the faint line on the chart).`;
    else if (st === 'improved') html = `${chip('counts', 'Best today')}A new best for Daily #${n}: ${best}${g.prevBest ? `, up from <b>${g.prevBest.grade}</b>, ${moneyM(g.prevBest.societal)}` : ''}.`;
    else html = `${chip('practice', 'Replay')}Your best today stays ${best}${c && c.runs > 1 ? ` (best of ${c.runs} runs)` : ''}. Beat it and it replaces it.`;
    if (g.challenge) {
      const beat = Math.round(r.societal / 1e5) / 10 < g.challenge.s;
      html += ` Your friend got <b>${g.challenge.g}</b> ($${g.challenge.s.toFixed(1)}M): ${beat ? 'you beat it.' : 'not beaten yet.'}`;
    }
    dEl.innerHTML = html;
  }
  const real = $('#res-real');
  real.hidden = !sc.real;
  if (sc.real) { $('#res-real-title').textContent = sc.real.title; $('#res-real-text').textContent = sc.real.text; }
  const gradeEl = $('#res-grade');
  gradeEl.textContent = r.grade;
  gradeEl.className = 'grade g-' + r.grade.replace('+', '');
  let copy = GRADE_COPY[r.grade];
  if (r.grade === 'C' && r.unservedMWh <= 0.5) copy = 'No blackouts, but you burned a lot of money and CO₂ to get there.';
  $('#res-copy').textContent = copy;
  $('#res-timeline').innerHTML = r.cells.map((c, i) => `<i class="${c}" title="${String(i).padStart(2, '0')}:00 ${c === 'green' ? 'stable' : c === 'yellow' ? 'strained' : 'load shed'}"></i>`).join('');
  $('#res-stats').innerHTML = [
    ['In the dark', mwh(r.unservedMWh)], ['Score', moneyM(r.societal)], ['CO₂', tonnes(r.co2)], ['Clean energy', Math.round(r.cleanShare * 100) + '%'],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#res-compare').innerHTML = g.mode === 'code'
    ? compareTable(r, sc)
    : `<p class="muted small">Score ${moneyM(r.societal)}${sc.par ? ` (${vsPar(r.societal, sc.par)})` : ''}. Lower is better: fuel &amp; ops ${money(r.cost)} + $10k per MWh of blackout + $100 per tonne CO₂. ${sc.par ? `Par for an A+ is ${moneyM(sc.par)}.` : 'No blackout-free run is known for this day, so there is no par.'}</p>`;
  const text = shareText({ scenario: sc, result: r, mode: g.mode, assisted: g.tutorial && g.autoUsed, status: g.countStatus });
  $('#share-preview').textContent = text;
  $('#btn-share').textContent = canShare() ? 'Share result' : 'Copy result';
  $('#btn-copy').hidden = !canShare();
  $('#btn-copy').textContent = 'Copy text';
  const idx = SCENARIOS.findIndex((s) => s.id === sc.id);
  const next = sc.daily ? null : SCENARIOS[idx + 1];
  $('#btn-next').hidden = !next;
  $('#btn-next').dataset.next = next ? next.id : '';
  $('#res-code-link').parentElement.hidden = g.mode === 'code';
  $('#res-code-link').href = sc.daily ? '#code/daily/' + sc.daily.key : '#code/' + sc.id;
  $('#results').showModal();
}

$('#btn-results').addEventListener('click', () => { if (game && game.ended && game.result) showResults(); });
$('#btn-takeover').addEventListener('click', () => setAutopilot(false));
$('#btn-share').addEventListener('click', async () => {
  const how = await shareResult($('#share-preview').textContent);
  $('#btn-share').textContent = { shared: 'Shared ✓', copied: 'Copied ✓', failed: 'Select the text above to copy' }[how] || (canShare() ? 'Share result' : 'Copy result');
});
$('#btn-copy').addEventListener('click', async () => {
  const ok = await copyText($('#share-preview').textContent);
  $('#btn-copy').textContent = ok ? 'Copied ✓' : 'Select the text above to copy';
});
$('#btn-again').addEventListener('click', () => {
  $('#results').close();
  if (game) startGame(routeId(game.sc), game.mode, { tutorial: false, date: game.sc.daily?.key, challenge: game.challenge });
});
$('#btn-next').addEventListener('click', () => {
  $('#results').close();
  const id = $('#btn-next').dataset.next;
  location.hash = (game && game.mode === 'code' ? '#code/' : '#') + id;
});
$('#res-code-link').addEventListener('click', () => $('#results').close());

// ------------------------------------------------------------------ coach + hints

let coachTarget = null; // what the bubble is placed next to
let coachSpot = null; // what gets the highlight ring (usually the same element)
let coachState = null;
function coach(html, target, { button = null, onButton = null, button2 = null, onButton2 = null, anchor = null } = {}) {
  hideCoach();
  const c = $('#coach');
  $('#coach-text').innerHTML = html;
  const btn = $('#coach-btn');
  btn.hidden = !button;
  if (button) { btn.textContent = button; btn.onclick = () => onButton && onButton(); }
  const btn2 = $('#coach-btn2');
  btn2.hidden = !button2;
  if (button2) { btn2.textContent = button2; btn2.onclick = () => onButton2 && onButton2(); }
  c.hidden = false;
  coachTarget = anchor || target;
  coachSpot = anchor ? null : target; // an explicit anchor places the bubble without ringing anything
  coachState = { html };
  if (game) game.introPending = !!button && !game.tutorial;
  if (target || anchor) {
    const el = target || anchor;
    if (coachSpot) coachSpot.classList.add('spotlight');
    const r = el.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight - 40) el.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
  placeCoach();
}
function placeCoach() {
  const c = $('#coach');
  if (c.hidden) return;
  const pad = 12;
  const w = Math.min(320, innerWidth - 2 * pad);
  c.style.width = w + 'px';
  if (!coachTarget) {
    c.style.left = (innerWidth - w) / 2 + 'px';
    c.style.top = innerHeight / 3 + 'px';
    return;
  }
  const r = coachTarget.getBoundingClientRect();
  const banner = $('#challenge');
  const floor = !banner.hidden ? banner.getBoundingClientRect().bottom + 10 : 0; // keep the friend's banner readable
  const legend = $('#legend');
  const avoid = legend.offsetParent && screen === 'game' ? [legend.getBoundingClientRect()] : []; // never cover the chart legend
  const spot = placeCoachBox({ target: r, size: { w, h: c.offsetHeight }, viewport: { w: innerWidth, h: innerHeight }, avoid, floor, pad });
  c.style.left = spot.left + 'px';
  c.style.top = spot.top + 'px';
  c.dataset.side = spot.side;
  c.style.setProperty('--arrow-x', Math.min(w - 24, Math.max(12, r.left + r.width / 2 - spot.left - 6)) + 'px');
}
function hideCoach() {
  $('#coach').hidden = true;
  if (coachSpot) coachSpot.classList.remove('spotlight');
  coachTarget = null;
  coachSpot = null;
  coachState = null;
  if (game) game.introPending = false;
}
addEventListener('resize', placeCoach);
addEventListener('scroll', placeCoach, { passive: true });

let hintTimer = 0;
function hint(key, text) {
  const g = game;
  if (!g || g.hints.has(key) || g.mode !== 'manual') return;
  if (g.sim.t - g.lastHintT < 20 && key !== 'shed') return;
  g.hints.add(key);
  g.lastHintT = g.sim.t;
  const h = $('#hint');
  h.innerHTML = '<span></span><button class="x" type="button" aria-label="Dismiss">×</button>';
  h.firstChild.textContent = text;
  h.querySelector('.x').onclick = hideHint;
  h.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideHint, 8000);
}
function hideHint() { $('#hint').hidden = true; }

// ------------------------------------------------------------------ tutorial

function startTutorial() {
  game.tutStep = 1;
  game.slow = true;
  setSpeed(1);
  // let the trip land and the needle start falling, then point at the fix
  setTimeout(() => {
    if (!game || !game.tutorial || game.tutStep !== 1) return;
    setSpeed(0); // time waits for you
    coach('<b>A coal unit just tripped.</b> Supply is now below demand, so frequency is falling. The battery is holding it, but not for long. Drag <b>Gas peakers</b> to the right: they start in 10 minutes and ramp fast.', $('#ctl-peaker'));
  }, 900);
}

function tutorialTick() {
  const g = game;
  if (g.tutStep === 1 && g.setpoints.peaker >= 300) {
    g.tutStep = 2;
    g.tutT = performance.now();
    setSpeed(1);
    coach('Good. The striped units are starting up. Watch the needle climb back to 60.', $('.panel-dial'));
  } else if (g.tutStep === 2) {
    const ok = Math.abs(g.sim.df) < 0.08 && g.sim.units.peaker.output > 150;
    if (ok || performance.now() - g.tutT > 12000) {
      g.tutStep = 3;
      g.slow = false;
      setSpeed(0);
      if (g.then) {
        const q = g.challenge ? `?g=${encodeURIComponent(g.challenge.g)}&s=${g.challenge.s}` : '';
        coach('<b>That is the whole job, all day.</b> The dashed line is the demand forecast; the dotted line is what your plants must cover after wind and solar. Plants are slow, so stay ahead of it. Today&rsquo;s grid starts paused, so you can look around first.', $('.panel-chart'),
          { button: "Play today's grid", onButton: () => { hideCoach(); store.set('tutorialDone', true); location.hash = '#' + g.then + q; } });
      } else {
        coach('<b>That is the whole job, all day.</b> The dashed line is the demand forecast; the dotted line is what your plants must cover after wind and solar. Plants are slow, so stay ahead of it. Autopilot will fly the day until you touch a slider, so you can watch first.', $('.panel-chart'),
          { button: 'Play the day', onButton: () => { hideCoach(); setAutopilot(true); setSpeed(1); store.set('tutorialDone', true); } });
      }
    }
  }
}

// ------------------------------------------------------------------ code mode

const codeEl = $('#code');
const gutter = $('#gutter');
function updateGutter() {
  const n = codeEl.value.split('\n').length;
  let s = '';
  for (let i = 1; i <= n; i++) s += i + '\n';
  gutter.textContent = s;
  gutter.scrollTop = codeEl.scrollTop;
}
codeEl.addEventListener('input', () => { updateGutter(); store.set('code', codeEl.value); });
codeEl.addEventListener('scroll', () => { gutter.scrollTop = codeEl.scrollTop; });
codeEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b, value } = codeEl;
    codeEl.value = value.slice(0, a) + '  ' + value.slice(b);
    codeEl.selectionStart = codeEl.selectionEnd = a + 2;
    updateGutter();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runWatch(game?.speed || 4);
  }
});

function baselineSource(fn) {
  return fn.toString().replace(/^function\s+\w+\s*\(/, 'function dispatch(');
}
{
  const sel = $('#load-baseline');
  for (const b of BASELINES) {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = `Baseline: ${b.name}`;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    const v = sel.value;
    sel.value = '';
    if (!v) return;
    const src = v === 'starter' ? STARTER_POLICY : baselineSource(BASELINES.find((b) => b.id === v).fn);
    const header = v === 'starter' ? '' : `// Baseline "${BASELINES.find((b) => b.id === v).name}". ${BASELINES.find((b) => b.id === v).about}\n`;
    codeEl.value = header + src + '\n';
    store.set('code', codeEl.value);
    updateGutter();
  });
}

const consoleEl = $('#console');
function consoleLine(text, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  consoleEl.appendChild(line);
  while (consoleEl.childNodes.length > 200) consoleEl.firstChild.remove();
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function setupCodePanel() {
  if (!codeEl.value) codeEl.value = store.get('code') || STARTER_POLICY;
  updateGutter();
  consoleEl.innerHTML = '';
  $('#compare').innerHTML = '';
  $('#run-progress').textContent = '';
  store.set('codeScenario', game.sc.id);
  consoleLine(`${game.sc.name}: ${game.sc.tip}`);
}

function resetSimForRun() {
  const g = game;
  g.sim = new GridSim(g.sc);
  g.ended = false; g.aborted = false; g.result = null; setEnded(false); g.logSeen = 0; g.lastDrawT = -1;
  g.minF = F0; g.maxF = F0; g.f = F0;
  g.runId++;
  g.warned = new Set();
  $('#feed').innerHTML = '';
  $('#compare').innerHTML = '';
  consoleEl.innerHTML = '';
  chart.setGhost(loadGhost(g));
  chart.draw(g.sim);
}

const MAX_WARNINGS = 12;
/** Non-fatal problems in what dispatch() returned (typo'd keys, NaN, ...): each shown once per run, naming the key. */
function warnAction(action) {
  const g = game;
  if (!g.warned) g.warned = new Set();
  for (const w of checkAction(action, runner.lastKind)) {
    if (g.warned.has(w.id) || g.warned.size > MAX_WARNINGS) continue;
    g.warned.add(w.id);
    if (g.warned.size > MAX_WARNINGS) consoleLine('⚠ … more warnings hidden', 'warn');
    else consoleLine(`⚠ ${fmtTime(g.sim.t)}  ${w.text}`, 'warn');
  }
}

function reportPolicyError(err) {
  if (!(err instanceof PolicyError) || err.phase === 'stopped') return;
  const where = err.t != null ? ` at ${fmtTime(err.t)}` : '';
  const line = err.line ? ` (line ${err.line})` : '';
  consoleLine(`✖ ${err.phase === 'compile' ? 'Your code did not load' : 'Run stopped' + where}${line}: ${err.message}`, 'err');
}

async function runWatch(speed = 4) {
  const g = game;
  if (!g || g.mode !== 'code') return;
  runner.stop();
  resetSimForRun();
  const myRun = g.runId;
  g.runSource = codeEl.value;
  try {
    await runner.start(g.runSource, g.sim.forecast());
  } catch (err) { reportPolicyError(err); return; }
  if (game !== g || g.runId !== myRun) return;
  consoleLine('▶ Running your dispatch()…', 'ok');
  g.running = true;
  setSpeed(speed || 4);
}

async function stepPolicy(n, runId) {
  const g = game;
  for (let i = 0; i < n; i++) {
    if (!g.running || g.ended || g.runId !== runId) return;
    try {
      const state = g.sim.observe();
      const action = await runner.decide(state, g.sim.t === 0 ? 1500 : undefined);
      if (!g.running || g.runId !== runId) return;
      warnAction(action);
      g.sim.step(action);
      afterStep();
    } catch (err) {
      g.running = false;
      setSpeed(0);
      reportPolicyError(err);
      return;
    }
  }
}

async function runFast() {
  const g = game;
  if (!g || g.mode !== 'code') return;
  runner.stop();
  setSpeed(0);
  resetSimForRun();
  const myRun = g.runId;
  const btn = $('#btn-run-fast');
  btn.disabled = true;
  g.fast = true;
  g.runSource = codeEl.value;
  try {
    await runner.start(g.runSource, g.sim.forecast());
    g.running = true;
    while (!g.sim.done && g.runId === myRun) {
      const state = g.sim.observe();
      const action = await runner.decide(state, g.sim.t === 0 ? 1500 : undefined);
      if (g.runId !== myRun) break;
      warnAction(action);
      g.sim.step(action);
      if (g.sim.t % 60 === 0) {
        $('#run-progress').textContent = `${fmtTime(g.sim.t)}…`;
        renderGame(0, true);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (g.runId === myRun) {
      while (g.logSeen < g.sim.log.length) feed(g.sim.log[g.logSeen++]);
      $('#run-progress').textContent = '';
      endGame();
    }
  } catch (err) {
    g.running = false;
    $('#run-progress').textContent = '';
    reportPolicyError(err);
  } finally {
    btn.disabled = false;
    g.fast = false;
    g.running = false;
  }
}

$('#btn-run-watch').addEventListener('click', () => runWatch(game?.speed || 4));
$('#btn-run-fast').addEventListener('click', runFast);

// ------------------------------------------------------------------ keyboard

const KEYMAP = {
  q: ['coal', 1], a: ['coal', -1], w: ['gas', 1], s: ['gas', -1], e: ['peaker', 1], d: ['peaker', -1],
  r: ['battery', 1], f: ['battery', -1], t: ['solar', 1], g: ['solar', -1], y: ['wind', 1], h: ['wind', -1],
};
addEventListener('keydown', (e) => {
  if (screen !== 'game' || !game) return;
  if (e.target.closest && e.target.closest('textarea, input:not([type=range]), select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ($('#results').open || $('#help').open) return;
  const k = e.key.toLowerCase();
  if (k === ' ') {
    e.preventDefault();
    if (game.fast || (game.mode === 'code' && !game.running)) return;
    if (game.introPending) hideCoach();
    setSpeed(game.speed > 0 ? 0 : (game.lastSpeed || 1));
    return;
  }
  if (k === '1' || k === '2' || k === '3' || k === '4') {
    if (game.fast || (game.mode === 'code' && !game.running)) return;
    if (game.introPending) hideCoach();
    setSpeed({ 1: 1, 2: 2, 3: 4, 4: 0.5 }[k]);
    return;
  }
  if (k === '?') { $('#help').showModal(); return; }
  if (k === 'm') { toggleSound(); return; }
  if (game.mode !== 'manual' || game.ended || !controls) return;
  if (k === 'x') { onControl('dr', true); controls.parts.dr.el.classList.add('flash'); setTimeout(() => controls.parts.dr.el.classList.remove('flash'), 1200); return; }
  const m = KEYMAP[k];
  if (!m) return;
  e.preventDefault();
  const [id, dir] = m;
  const p = controls.parts[id];
  const min = +p.input.min, max = +p.input.max;
  const stepSize = (max - min) * (e.shiftKey ? 0.01 : 0.05);
  const v = Math.max(min, Math.min(max, Math.round((+p.input.value + dir * stepSize) / 10) * 10));
  p.input.value = v;
  onControl(id, v);
  p.el.classList.remove('flash');
  void p.el.offsetWidth;
  p.el.classList.add('flash');
});

// ------------------------------------------------------------------ toolbar

function toggleSound() {
  const on = setSound(!soundOn());
  $('#btn-sound').setAttribute('aria-pressed', String(on));
}
$('#btn-sound').addEventListener('click', toggleSound);
$('#btn-theme').addEventListener('click', toggleTheme);
$('#btn-help').addEventListener('click', () => $('#help').showModal());

// compact frequency bar on phones when the dial scrolls out of view
let miniOn = false;
const io = new IntersectionObserver(([entry]) => {
  miniOn = !entry.isIntersecting && screen === 'game' && !!game;
  $('#mini-hz').classList.toggle('show', miniOn);
  if (miniOn) { miniDial.set(game.f); miniChart.draw(game.sim); }
}, { rootMargin: '-60px 0px 0px 0px' });
io.observe($('.readout'));

// ------------------------------------------------------------------ routing

function route() {
  let r;
  try {
    r = parseHash(location.hash, (id) => !!getScenario(id), () => store.get('codeScenario'), dailyKey());
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    hideCoach();
    hideHint();
    if (r.bad) history.replaceState(null, '', location.pathname + location.search); // drop the mangled hash
    else if (r.canon) history.replaceState(null, '', location.pathname + location.search + r.canon + (r.challenge ? '?' + location.hash.split('?')[1] : '')); // repaired date: show the grid you got
    if (r.view === 'landing') { runner.stop(); game = null; renderLanding(); show('landing'); document.title = 'Hold 60: keep the grid at 60 Hz'; }
    else if (r.view === 'picker') { runner.stop(); game = null; renderPicker(); show('picker'); document.title = 'Pick a day · Hold 60'; }
    else if (r.view === 'tutorial') startGame('spring', 'manual', { tutorial: true, then: r.then, challenge: r.challenge });
    else if (r.view === 'code') startGame(r.id, 'code', { date: r.date, challenge: r.challenge });
    else startGame(r.id, 'manual', { date: r.date, challenge: r.challenge });
  } catch (err) {
    // never leave the player on a blank page
    console.error(err);
    try { runner.stop(); game = null; show('landing'); } catch { /* nothing left to try */ }
  }
}
addEventListener('hashchange', route);
requestAnimationFrame(frame); // the loop starts first, so a routing problem can never stop the game
route();

// ------------------------------------------------------------------ test hook (used by the browser checks)

window.__hold60 = {
  get game() { return game; },
  dailyKey,
  /** Let a baseline drive the current manual day for `minutes` (to the end by default). */
  advance(minutes = DAY_MIN, policyId = 'lookAhead') {
    if (!game || game.ended) return null;
    game.hooked = true; // scripted moves are not in the action log, so this run cannot be resumed
    hideCoach();
    const b = BASELINES.find((x) => x.id === policyId) || BASELINES[2];
    const fc = game.sim.forecast();
    game.autoMem = game.autoMem || {};
    const stop = Math.min(DAY_MIN, game.sim.t + minutes);
    while (game.sim.t < stop) {
      const s = game.sim.observe();
      s.forecast = fc;
      game.sim.step(b.fn(s, game.autoMem));
    }
    // copy the baseline's targets onto the sliders, as if a person had set them
    for (const id of THERMAL) game.setpoints[id] = game.sim.units[id].target;
    for (const id of ['wind', 'solar']) game.setpoints[id] = game.sim.ren[id].target;
    game.setpoints.battery = game.sim.battery.setpoint;
    controls?.syncInputs();
    game.minF = Math.min(...game.sim.hist.freq.slice(Math.max(0, game.sim.t - 60), game.sim.t));
    game.maxF = Math.max(...game.sim.hist.freq.slice(Math.max(0, game.sim.t - 60), game.sim.t));
    while (game.logSeen < game.sim.log.length) feed(game.sim.log[game.logSeen++]);
    renderGame(0, true);
    if (game.sim.done) endGame();
    return game.sim.t;
  },
  finish(policyId = 'lookAhead') { this.advance(DAY_MIN, policyId); return game && game.result; },
};
