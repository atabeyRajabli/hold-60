// Hold 60 — built-in baseline dispatch policies.
// Each one is a self-contained `function dispatch(state, memory)` so its source can
// be shown in the in-game editor with Function.prototype.toString().

// 1. Day-ahead schedule: plans each hour from the forecast and never looks at the needle.
export function dayAhead(state) {
  const f = state.forecast, F = state.fleets;
  // plan for the middle of the current hour
  const m = Math.min(1439, Math.floor(state.t / 60) * 60 + 30);
  let need = f.demand[m] - f.wind[m] - f.solar[m] - F.nuclear.output;
  const out = { wind: F.wind.capacity, solar: F.solar.capacity, battery: 0 };
  for (const id of ['coal', 'gas', 'peaker']) {
    const v = Math.max(0, Math.min(F[id].capacity, need));
    out[id] = v;
    need -= v;
  }
  if (need < 0) out.solar = Math.max(0, f.solar[m] + need); // surplus: curtail solar
  return out;
}

// 2. Chase the needle: real-time merit order with frequency feedback, no look-ahead.
export function chaseNeedle(state) {
  const F = state.fleets;
  let need = state.demand - F.wind.available - F.solar.available - F.nuclear.output - 1500 * state.deviation;
  const out = { wind: F.wind.capacity, solar: F.solar.capacity, battery: 0 };
  for (const id of ['coal', 'gas', 'peaker']) {
    const v = Math.max(0, Math.min(F[id].capacity, need));
    out[id] = v;
    // only count what is already online; the rest has to start up first
    need -= Math.min(v, Math.max(F[id].output, F[id].onlineMW));
  }
  if (need < 0) out.solar = Math.max(0, F.solar.available + need);
  if (need > 200 && !state.dr.active && !state.dr.pending) out.dr = true;
  return out;
}

// 3. Look-ahead: commits units early enough for their start-up time, shifts solar
//    into the evening with the battery, and calls demand response when short.
export function lookAhead(state, memory) {
  const f = state.forecast, F = state.fleets, t = state.t;
  const nuclear = F.nuclear.output;
  const net = (m) => {
    m = Math.min(1439, Math.max(0, m));
    return f.demand[m] - f.wind[m] - f.solar[m] - nuclear;
  };
  if (memory.lo === undefined) {
    const xs = [];
    for (let m = 0; m < 1440; m += 10) xs.push(net(m));
    xs.sort((a, b) => a - b);
    memory.lo = xs[Math.floor(xs.length * 0.35)];
    memory.hi = xs[Math.floor(xs.length * 0.75)];
  }
  // forecast error right now; assume it persists for a while
  const bias = (state.demand - f.demand[t]) - (F.wind.available - f.wind[t]) - (F.solar.available - f.solar[t]);
  const n = net(t);
  let battery = 0;
  if (n < memory.lo && F.battery.socFrac < 0.95) battery = -F.battery.mw * 0.5;
  else if (n > memory.hi && F.battery.socFrac > 0.05) battery = Math.min(F.battery.mw, n - memory.hi);

  const out = { wind: F.wind.capacity, solar: F.solar.capacity, battery, commit: {} };
  const reserve = 350;
  let covered = 0;
  for (const id of ['coal', 'gas', 'peaker']) {
    const d = F[id];
    let peak = -Infinity;
    for (let m = t; m <= t + d.startMin + 30; m += 5) peak = Math.max(peak, net(m) + bias);
    const want = Math.max(0, Math.min(d.capacity, peak + reserve - covered));
    const units = Math.ceil(want / d.unitMW - 1e-9);
    out.commit[id] = units;
    covered += units * d.unitMW;
  }
  let need = state.demand - F.wind.available - F.solar.available - nuclear - battery - 1500 * state.deviation;
  let floors = 0;
  for (const id of ['coal', 'gas', 'peaker']) {
    const d = F[id];
    const cap = Math.max(d.online, out.commit[id]) * d.unitMW;
    const v = Math.max(0, Math.min(cap, need));
    out[id] = v;
    need -= Math.min(v, Math.max(d.output, d.onlineMW)); // starting units can't help yet
    floors += out.commit[id] * d.unitMW * d.minFrac;
  }
  const dispatched = out.coal + out.gas + out.peaker;
  const surplus = floors - dispatched + Math.max(0, -need);
  if (surplus > 0) out.solar = Math.max(0, F.solar.available - surplus);
  if (need > 150 && state.deviation < -0.15 && !state.dr.active && !state.dr.pending) out.dr = true;
  return out;
}

export const BASELINES = [
  { id: 'dayAhead', name: 'Day-ahead schedule', fn: dayAhead, about: 'Plans each hour from the forecast. Never looks at the frequency.' },
  { id: 'chaseNeedle', name: 'Chase the needle', fn: chaseNeedle, about: 'Reacts to the frequency right now. Never looks ahead.' },
  { id: 'lookAhead', name: 'Look-ahead', fn: lookAhead, about: 'Starts plants early, shifts solar into the evening with the battery.' },
];

export const STARTER_POLICY = `// Called once per simulated minute. Return setpoints in MW.
// state.demand, state.frequency, state.fleets.*, state.forecast.*  (API cheat sheet below)
// memory is an object you can keep things in between calls.
function dispatch(state, memory) {
  const F = state.fleets;

  // What the fossil plants must cover after nuclear, wind and solar.
  let need = state.demand - F.wind.available - F.solar.available - F.nuclear.output;

  // Frequency below 60 means we're short: push a bit harder.
  need -= 1000 * state.deviation;

  // Fixed order: coal first, then gas for whatever coal can't do right now.
  // But is coal really the cheapest? The score counts CO2 at $100/t, so per MWh:
  //   coal $30 + 1.00 t = $130,  gas $40 + 0.37 t = $77,  peaker $140 + 0.6 t = $200.
  // Swap the order and see what happens to your score.
  const coal = Math.min(need, F.coal.capacity);
  const gas = Math.max(0, need - F.coal.output);

  return { coal, gas };

  // Ideas: peakers start in 10 min (F.peaker). The battery can charge at noon
  // and discharge at 8 pm (battery: +MW out, -MW in). Look ahead with
  // state.forecast.demand[state.t + 90] so slow plants are ready in time.
  // Curtail solar (solar: MW cap) when there's too much. Call dr: true when desperate.
}
`;
