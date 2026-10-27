// Hold 60 — hidden reference policies. They set par and code par (see referencePars) and prove that
// the harder days can be beaten. They are not shown in the in-game editor, but nothing about them is secret.
import { runDay } from './sim.js';
import { BASELINES } from './policies.js';

// A hand-written "good" policy used only by the tests to prove scenarios 3-5 can be
// beaten. Not shipped in the game UI (it would spoil the puzzle).
//
// Ideas: learn how wrong the forecast is (icing wind, bias), plan the battery for the
// whole remaining day by "water-filling" the net-load peaks, commit plants for what the
// battery cannot cover, keep spare capacity sized to the biggest thing that can trip,
// and keep battery headroom to soak up sudden load drops.
export function expert(state, memory) {
  const f = state.forecast, F = state.fleets, t = state.t;
  const B = F.battery;
  const nuc = F.nuclear.output;
  const at = (arr, m) => arr[Math.min(1439, Math.max(0, m))];

  // learn forecast errors
  const wf = at(f.wind, t);
  const ratio = wf > 50 ? F.wind.available / wf : 1;
  memory.wr = memory.wr === undefined ? ratio : memory.wr * 0.9 + ratio * 0.1;
  const dErr = state.demand + (state.dr.active ? state.dr.mw : 0) - at(f.demand, t);
  memory.de = memory.de === undefined ? 0 : memory.de * 0.95 + dErr * 0.05;
  // track losses: available capacity dropping means things are breaking
  let firm = nuc;
  for (const id of ['coal', 'gas', 'peaker']) firm += F[id].capacity;
  if (memory.firm !== undefined && firm < memory.firm - 1) memory.losses = (memory.losses || 0) + 1;
  memory.firm = firm;
  const stormy = (memory.losses || 0) > 0 || memory.wr < 0.8;

  const net = (m) => at(f.demand, m) + memory.de - at(f.wind, m) * Math.min(1, memory.wr) - at(f.solar, m) - nuc;

  // ---- battery plan: water-fill the remaining day's peaks with usable energy
  const keep = stormy ? 0.05 : 0.1;
  const usable = Math.max(0, B.soc - keep * B.mwh) * Math.sqrt(B.eff);
  let lo = -5000, hi = 20000;
  for (let it = 0; it < 22; it++) {
    const T = (lo + hi) / 2;
    let e = 0;
    for (let m = t; m < 1440; m += 5) e += Math.min(B.mw, Math.max(0, net(m) - T)) * (5 / 60);
    if (e > usable) lo = T; else hi = T;
  }
  const T = hi;
  // charge threshold: cheapest third of the remaining day
  if (memory.qT === undefined || t % 60 === 0) {
    const xs = [];
    for (let m = t; m < 1440; m += 10) xs.push(net(m));
    xs.sort((a, b) => a - b);
    memory.qT = xs.length ? xs[Math.floor(xs.length * 0.33)] : -Infinity;
  }
  const n = net(t);
  // learn whether demand can vanish suddenly (e.g. a data centre pausing); if so keep room to absorb it
  if (memory.lastDemand !== undefined && memory.lastDemand - state.demand > 600) memory.jumpy = true;
  memory.lastDemand = state.demand;
  const cap = stormy ? 1.0 : memory.jumpy ? 0.8 : 0.95;
  let battery = 0;
  if (n > T) battery = Math.min(B.mw, n - T);
  else if (n < memory.qT && B.socFrac < cap && n < T - 300) battery = -B.mw * 0.7;

  // ---- unit commitment for what the battery will not cover
  let biggest = 0;
  for (const id of ['coal', 'gas', 'peaker']) if (F[id].online > 0) biggest = Math.max(biggest, F[id].unitMW);
  const reserve = stormy ? Math.max(500, biggest + 100) : 300;
  const out = { battery, wind: F.wind.capacity, solar: F.solar.capacity, commit: {} };
  let covered = 0;
  for (const id of ['coal', 'gas', 'peaker']) {
    const d = F[id];
    let peak = -Infinity;
    const horizon = d.startMin + 20;
    for (let m = t; m <= t + horizon; m += 5) {
      const bat = Math.min(B.mw, Math.max(0, net(m) - T));
      peak = Math.max(peak, net(m) - bat);
    }
    let want = Math.max(0, Math.min(d.capacity, peak + reserve - covered));
    // don't start a coal unit for a short bump
    const units = Math.ceil(want / d.unitMW - 0.15);
    out.commit[id] = Math.max(0, Math.min(d.available, units));
    covered += out.commit[id] * d.unitMW;
  }

  // ---- real-time dispatch in merit order
  let need = state.demand - F.wind.available - F.solar.available - nuc - battery - 1200 * state.deviation;
  let floors = 0, dispatched = 0;
  for (const id of ['coal', 'gas', 'peaker']) {
    const d = F[id];
    const capNow = Math.max(d.onlineMW, 0);
    const v = Math.max(0, Math.min(capNow, need));
    out[id] = Math.max(v, out.commit[id] * d.unitMW * d.minFrac);
    need -= v;
    floors += out.commit[id] * d.unitMW * d.minFrac;
    dispatched += v;
  }
  const surplus = Math.max(0, floors - dispatched) + Math.max(0, -need);
  if (surplus > 0) {
    // soak surplus into the battery first, then curtail
    const room = B.socFrac < 0.97 ? B.mw + Math.min(0, battery) : 0;
    const soak = Math.min(surplus, room);
    out.battery = battery - soak;
    const rest = surplus - soak;
    if (rest > 0) out.solar = Math.max(0, F.solar.available - rest);
    if (rest > F.solar.available) out.wind = Math.max(0, F.wind.available - (rest - F.solar.available));
  }
  // demand response: only when short even with everything online
  // (it costs ~$1M a call, so wait until the shortfall is real and lasting)
  let firmNow = nuc;
  for (const id of ['coal', 'gas', 'peaker']) firmNow += (F[id].online + (F[id].startingIn <= 8 ? F[id].starting : 0)) * F[id].unitMW;
  const batAvail = B.socFrac > 0.12 ? B.mw : 0;
  let forecastShort = false;
  for (let m = t + 8; m <= t + 25; m++) {
    if (at(f.demand, m) + memory.de - at(f.wind, m) * Math.min(1, memory.wr) - at(f.solar, m) - batAvail - firmNow > -60) forecastShort = true;
  }
  const desperate = need > 80 && B.socFrac < 0.15;
  memory.short = desperate ? (memory.short || 0) + 1 : 0;
  if ((forecastShort || memory.short >= 6) && !state.dr.active && !state.dr.pending && state.dr.callsLeft > 0) out.dr = true;
  return out;
}

// A simple tuned policy, hidden from the game and used only to set par. It is the policy that
// README.md used to print: a merit-order dispatch like the one in the README now, plus a
// forecast-driven gas commitment, battery shifting around sunset and solar curtailment.
// It stays out of the README on purpose, because on the heatwave it sits exactly at par.
export function tunedSimple(state, memory) {
  const F = state.fleets;
  const t = state.t;
  let need = state.demand - F.wind.available - F.solar.available - F.nuclear.output - 1500 * state.deviation;
  const later = state.forecast.demand[Math.min(1439, t + 90)]
              - state.forecast.wind[Math.min(1439, t + 90)]
              - state.forecast.solar[Math.min(1439, t + 90)] - F.nuclear.output;
  const gasUnits = Math.ceil(Math.max(0, later - F.coal.capacity) / F.gas.unitMW);
  const out = { commit: { gas: gasUnits }, battery: 0 };
  for (const id of ['coal', 'gas', 'peaker']) {
    out[id] = Math.max(0, Math.min(F[id].capacity, need));
    need -= Math.min(out[id], F[id].onlineMW);
  }
  if (need < 0) out.solar = F.solar.available + need;
  if (state.hour > 11 && state.hour < 15) out.battery = -400;
  if (state.hour > 18 && state.hour < 21) out.battery = 600;
  return out;
}

// A plain reactive policy (merit order + frequency feedback, no look-ahead, no DR).
// Simple, but on the heatwave it is the cheapest thing we know, so it counts toward par.
export function reactive(state) {
  const F = state.fleets;
  let need = state.demand - F.wind.available - F.solar.available - F.nuclear.output - 1500 * state.deviation;
  const out = { battery: 0 };
  for (const id of ['coal', 'gas', 'peaker']) {
    out[id] = Math.max(0, Math.min(F[id].capacity, need));
    need -= Math.min(out[id], F[id].onlineMW);
  }
  if (need < 0) out.solar = F.solar.available + need;
  return out;
}

// Gas first. Under the score's prices (CO2 at $100/t) a MWh from combined-cycle gas costs about
// $77 and one from coal about $130, so this fills gas before coal, keeps enough gas warm for the
// next 90 minutes of net load plus a reserve, charges the battery from late morning and spends it
// in the evening. It is the "code par" policy: it beats the manual par on days 1, 2 and 5. It
// blacks out on the winter storm and the windless day, where the expert policy is the best known.
// (Parameters found by a small grid search over the five days; this is a target, not an optimum.)
export function gasFirst(state) {
  const F = state.fleets, f = state.forecast, t = state.t;
  const nuc = F.nuclear.output;
  let peak = 0;
  for (let m = t; m <= t + 90; m += 5) {
    const i = Math.min(1439, m);
    peak = Math.max(peak, f.demand[i] - f.wind[i] - f.solar[i] - nuc);
  }
  const out = { battery: 0, commit: { gas: Math.min(F.gas.units, Math.ceil((peak + 800) / F.gas.unitMW - 0.2)) } };
  let need = state.demand - F.wind.available - F.solar.available - nuc - 2000 * state.deviation;
  for (const id of ['gas', 'coal', 'peaker']) {
    out[id] = Math.max(0, Math.min(F[id].capacity, need));
    need -= Math.min(out[id], F[id].onlineMW);
  }
  if (need < 0) out.solar = Math.max(0, F.solar.available + need);
  if (state.hour > 9 && state.hour < 15) out.battery = -600;
  if (state.hour > 17 && state.hour < 22) out.battery = 400;
  return out;
}

/** Zero-blackout score of a policy on a scenario, or Infinity if it blacked anyone out. */
export function cleanScore(sc, fn) {
  const r = runDay(sc, fn).result;
  return r.unservedMWh > 0.5 ? Infinity : r.societal;
}

const ceil10k = (x) => Math.ceil(x / 10000) * 10000;

/**
 * Par and code par for any scenario (including a daily variant), computed from our own policies.
 * par      = best zero-blackout result of the three baselines + the hidden expert, reactive and tuned policies
 * codePar  = the same set plus gas-first (the best known policy; programmers' target)
 * Both are rounded up to the next $10k. Takes about 0.3 s.
 */
export function referencePars(sc) {
  const base = [...BASELINES.map((b) => b.fn), expert, reactive, tunedSimple];
  const par = Math.min(...base.map((fn) => cleanScore(sc, fn)));
  const code = Math.min(par, cleanScore(sc, gasFirst));
  return { par: ceil10k(par), codePar: ceil10k(code) };
}
