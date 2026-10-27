// Hold 60 — grid simulation.
// Pure module: no DOM, no timers, no Math.random. Everything random comes from a
// seeded generator, and all of it is drawn up front when profiles are built, so a
// run is a deterministic function of (scenario, seed, actions).
//
// One tick = one minute of the simulated day. 1440 ticks per day.

export const DAY_MIN = 1440;
export const F0 = 60;
export const UFLS_HZ = 59.3; // under-frequency load shedding threshold
export const OVERFREQ_HZ = 60.5; // over-frequency generator trip threshold
export const STRAIN_HZ = 0.2; // |deviation| above this counts as "strained"
export const SUBSTEPS = 10; // frequency integration substeps per tick
export const VOLL = 10000; // $/MWh value of lost load (unserved energy)
export const CARBON_PRICE = 100; // $/t CO2 used in the score
export const LOAD_DAMPING = 0.04; // load falls 4% per Hz of under-frequency
export const SHED_BLOCK = 0.05; // each UFLS stage sheds 5% of demand
export const MAX_BLOCKS = 20;
export const RESTORE_AFTER = 20; // minutes of healthy frequency before a block is restored
export const TRIP_MINUTES = 90; // an over-frequency trip keeps the unit offline this long
export const THERMAL = ['coal', 'gas', 'peaker'];
export const CONTROLLABLE = ['coal', 'gas', 'peaker', 'wind', 'solar', 'battery'];
export const FLEET_ORDER = ['nuclear', 'coal', 'gas', 'peaker', 'wind', 'solar', 'battery'];

// ---------------------------------------------------------------- utilities

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  // Box-Muller, deterministic given rng
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Periodic Catmull-Rom interpolation of a 25-point hourly shape at hour h. */
export function interpHourly(shape, h) {
  const n = shape.length - 1; // 24
  const hh = ((h % n) + n) % n;
  const i = Math.floor(hh);
  const u = hh - i;
  const p = (k) => shape[((k % n) + n) % n];
  const p0 = p(i - 1), p1 = p(i), p2 = p(i + 1), p3 = p(i + 2);
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
}

export function solarShape(h, s) {
  if (h <= s.rise || h >= s.set) return 0;
  const x = (h - s.rise) / (s.set - s.rise);
  return s.cf * Math.pow(Math.sin(Math.PI * x), 1.3);
}

export function fmtTime(t) {
  const m = Math.max(0, Math.min(DAY_MIN, Math.round(t)));
  const h = Math.floor(m / 60) % 25;
  const mm = m % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

// ---------------------------------------------------------------- profiles

/**
 * Builds per-minute profiles for a scenario. `forecast` arrays are what policies
 * get to see; actual arrays include weather noise and unannounced events.
 */
export function buildProfiles(sc, seed = sc.seed) {
  const rng = mulberry32(seed);
  const N = DAY_MIN;
  const demandF = new Float64Array(N), demand = new Float64Array(N);
  const windF = new Float64Array(N), wind = new Float64Array(N);
  const solarF = new Float64Array(N), solar = new Float64Array(N);
  const windCap = sc.fleet.wind.mw, solarCap = sc.fleet.solar.mw;
  let dn = 0, wn = 0, sn = 0;
  for (let m = 0; m < N; m++) {
    const h = m / 60;
    demandF[m] = sc.peakMW * interpHourly(sc.demandShape, h) + (sc.flatLoadMW || 0);
    dn = 0.96 * dn + sc.demandNoise * gauss(rng);
    demand[m] = demandF[m] * (1 + dn);
    windF[m] = windCap * clamp(interpHourly(sc.windShape, h), 0, 1);
    wn = 0.985 * wn + sc.windNoise * gauss(rng);
    wind[m] = clamp(windF[m] * (1 + wn), 0, windCap);
    solarF[m] = solarCap * solarShape(h, sc.solar);
    sn = 0.95 * sn + sc.solarNoise * gauss(rng);
    solar[m] = clamp(solarF[m] * (1 + sn), 0, solarCap);
  }
  for (const ev of sc.events) {
    if (ev.type === 'windDerate') {
      for (let m = ev.at; m < Math.min(N, ev.until); m++) {
        // icing creeps in over half an hour
        const k = clamp((m - ev.at) / 30, 0, 1);
        wind[m] *= 1 - k * (1 - ev.factor);
      }
    } else if (ev.type === 'load') {
      for (let m = ev.at; m < Math.min(N, ev.at + ev.minutes); m++) demand[m] += ev.mw;
    }
  }
  return { demandF, demand, windF, wind, solarF, solar };
}

// ---------------------------------------------------------------- simulation

export class GridSim {
  constructor(scenario, opts = {}) {
    this.sc = scenario;
    this.seed = opts.seed ?? scenario.seed;
    this.prof = buildProfiles(scenario, this.seed);
    this.t = 0;
    this.done = false;
    this.df = 0; // frequency deviation from 60 Hz
    this.f = scenario.fleet;
    const F = this.f;

    this.units = {};
    for (const id of ['nuclear', ...THERMAL]) {
      this.units[id] = { id, out: 0, outages: [], online: 0, starting: [], output: 0, target: 0, commit: 0 };
    }
    this.units.nuclear.online = F.nuclear.units;
    this.units.nuclear.output = F.nuclear.units * F.nuclear.unitMW;
    this.ren = {
      wind: { avail: this.prof.wind[0], output: this.prof.wind[0], target: F.wind.mw },
      solar: { avail: this.prof.solar[0], output: this.prof.solar[0], target: F.solar.mw },
    };
    this.battery = { soc: F.battery.mwh * F.battery.soc0, setpoint: 0, output: 0 };
    this.dr = { callsLeft: F.dr.calls, start: -1, end: -1 };
    this.shed = []; // MW of each shed block, most recent last
    this.healthy = 0;
    this.shedCooldown = 0;
    this.tripCooldown = 0;
    this.eventIdx = 0;
    this.log = [];
    this.totals = {
      unservedMWh: 0, cost: 0, co2: 0, startCost: 0, drMWh: 0, curtailedMWh: 0,
      energy: { nuclear: 0, coal: 0, gas: 0, peaker: 0, wind: 0, solar: 0, battery: 0 },
      batteryIn: 0, batteryOut: 0, starts: 0, trips: 0, shedEvents: 0, maxShedMW: 0,
    };
    this.hourly = Array.from({ length: 24 }, () => ({ shedMWh: 0, strainedMin: 0, trips: 0, maxDev: 0 }));
    const H = (k) => new Float32Array(DAY_MIN);
    this.hist = {
      freq: H(), demand: H(), served: H(), nuclear: H(), coal: H(), gas: H(), peaker: H(),
      wind: H(), solar: H(), battery: H(), shed: H(),
    };
    this.last = null;
    this._warmStart();
    this.last = this._snapshot(this.prof.demand[0], this.prof.demand[0], 0);
  }

  // Commit and dispatch thermal units so tick 0 starts balanced.
  _warmStart() {
    const F = this.f;
    let need = this.prof.demand[0] - this.units.nuclear.output - this.ren.wind.output - this.ren.solar.output;
    let prev = null;
    for (const id of THERMAL) {
      const d = F[id];
      const cap = d.units * d.unitMW;
      let v = clamp(need, 0, cap);
      const u = this.units[id];
      // a sliver below one unit's minimum stable output: shift it from the cheaper fleet
      const floor = d.unitMW * d.minFrac;
      if (v > 0 && v < floor && prev) {
        const p = this.units[prev], pd = F[prev];
        const give = Math.min(floor - v, p.output - p.online * pd.unitMW * pd.minFrac);
        if (give > 0) { p.output -= give; p.target = p.output; v += give; need += give; }
      }
      u.target = v;
      u.online = Math.max(0, Math.min(d.units, Math.ceil(v / d.unitMW - 1e-9)));
      u.output = v;
      need -= v;
      prev = id;
    }
    if (need < 0) {
      // too much wind at midnight: curtail it
      this.ren.wind.target = Math.max(0, this.ren.wind.output + need);
      this.ren.wind.output = this.ren.wind.target;
    }
  }

  get time() { return fmtTime(this.t); }

  /** Fleet capacity currently not on forced outage. */
  availableUnits(id) {
    return this.f[id].units - this.units[id].out;
  }

  _logEvent(type, msg) {
    this.log.push({ t: this.t, type, msg });
  }

  _trip(id, n, minutes, msg, type = 'outage') {
    const d = this.f[id];
    const u = this.units[id];
    let tripped = 0;
    for (let i = 0; i < n; i++) {
      if (u.out >= d.units) break;
      u.out++;
      tripped++;
      u.outages.push(minutes == null ? Infinity : this.t + minutes);
      const avail = d.units - u.out;
      if (id === 'nuclear') {
        u.online = avail;
        u.output = avail * d.unitMW;
      } else if (u.online > avail) {
        u.online = avail;
        // the tripped unit takes its share of output with it
        u.output = Math.min(u.output * (avail / (avail + 1)), avail * d.unitMW);
      } else if (u.online + u.starting.length > avail) {
        u.starting.pop();
      }
    }
    if (tripped > 0) this._logEvent(type, msg);
    return tripped;
  }

  _applyEvents() {
    const evs = this.sc.events;
    while (this.eventIdx < evs.length && evs[this.eventIdx].at <= this.t) {
      const ev = evs[this.eventIdx++];
      if (ev.type === 'trip') this._trip(ev.fleet, ev.units, ev.minutes, ev.msg);
      else this._logEvent(ev.type === 'load' ? 'load' : 'weather', ev.msg);
    }
    for (const id of ['nuclear', ...THERMAL]) {
      const u = this.units[id];
      for (let i = u.outages.length - 1; i >= 0; i--) {
        if (u.outages[i] <= this.t) {
          u.outages.splice(i, 1);
          u.out--;
          if (id === 'nuclear') { u.online++; u.output = u.online * this.f.nuclear.unitMW; }
          this._logEvent('return', `${this.f[id].name} unit back in service`);
        }
      }
    }
  }

  _applyAction(a) {
    if (!a || typeof a !== 'object') return;
    if (a.setpoints && typeof a.setpoints === 'object') a = { ...a.setpoints, dr: a.dr ?? a.setpoints.dr, commit: a.commit ?? a.setpoints.commit };
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const F = this.f;
    for (const id of THERMAL) {
      const v = num(a[id]);
      if (v != null) this.units[id].target = clamp(v, 0, F[id].units * F[id].unitMW);
      const c = a.commit && num(a.commit[id]);
      if (c != null) this.units[id].commit = clamp(Math.round(c), 0, F[id].units);
      else if (a.commit === null || (a.commit && a.commit[id] === null)) this.units[id].commit = 0;
    }
    for (const id of ['wind', 'solar']) {
      const v = num(a[id]);
      if (v != null) this.ren[id].target = clamp(v, 0, F[id].mw);
    }
    const b = num(a.battery);
    if (b != null) this.battery.setpoint = clamp(b, -F.battery.mw, F.battery.mw);
    if (a.dr === true && this.dr.callsLeft > 0 && this.t >= this.dr.end) {
      this.dr.callsLeft--;
      this.dr.start = this.t + F.dr.delay;
      this.dr.end = this.dr.start + F.dr.minutes;
      this._logEvent('dr', `Demand response called: ${F.dr.mw} MW off in ${F.dr.delay} min`);
    }
  }

  _dispatchThermal() {
    const F = this.f;
    for (const id of THERMAL) {
      const d = F[id];
      const u = this.units[id];
      const avail = d.units - u.out;
      // starting units count down
      for (let i = 0; i < u.starting.length; i++) u.starting[i]--;
      while (u.starting.length && u.starting[0] <= 0) {
        u.starting.shift();
        u.online = Math.min(avail, u.online + 1);
      }
      const needed = Math.max(0, Math.min(avail, Math.max(Math.ceil(u.target / d.unitMW - 1e-9), u.commit)));
      if (needed > u.online + u.starting.length) {
        const add = needed - u.online - u.starting.length;
        for (let i = 0; i < add; i++) {
          u.starting.push(d.startMin);
          this.totals.startCost += d.startCost;
          this.totals.cost += d.startCost;
          this.totals.starts++;
        }
      } else if (needed < u.online + u.starting.length) {
        while (u.starting.length && needed < u.online + u.starting.length) u.starting.pop();
      }
      // ramp toward target, honouring min stable output of the units we want online
      const floor = needed * d.unitMW * d.minFrac;
      const eff = clamp(Math.max(u.target, floor), 0, u.online * d.unitMW);
      const ramp = Math.max(u.online, 1) * d.rampPerUnit;
      if (u.output < eff) u.output = Math.min(eff, u.output + ramp);
      else u.output = Math.max(eff, u.output - ramp);
      if (u.online === 0) u.output = 0;
      // decommit units once output has been ramped below what the remaining units carry
      while (u.online > needed && u.output <= (u.online - 1) * d.unitMW + 1e-6) u.online--;
    }
  }

  /** Inertia-like constant (MW·min/Hz). Spinning machines add inertia; inverters do not. */
  inertia() {
    let sync = this.units.nuclear.output;
    for (const id of THERMAL) sync += this.units[id].output;
    return 250 + 0.18 * sync;
  }

  /** Advance one minute. `action` is a setpoints object (see README). Returns this. */
  step(action) {
    if (this.done) return this;
    const F = this.f;
    const t = this.t;
    this._applyEvents();
    this._applyAction(action);
    this._dispatchThermal();

    // renewables: output = min(available, curtailment cap)
    const wAvail = this.prof.wind[t], sAvail = this.prof.solar[t];
    this.ren.wind.avail = wAvail;
    this.ren.solar.avail = sAvail;
    this.ren.wind.output = Math.min(wAvail, this.ren.wind.target);
    this.ren.solar.output = Math.min(sAvail, this.ren.solar.target);

    // demand
    const drActive = t >= this.dr.start && t < this.dr.end;
    const drMW = drActive ? F.dr.mw : 0;
    const demand = Math.max(0, this.prof.demand[t] - drMW);

    let thermalMW = this.units.nuclear.output;
    for (const id of THERMAL) thermalMW += this.units[id].output;
    const M = this.inertia();
    const B = F.battery;
    const etaC = Math.sqrt(B.eff), etaD = Math.sqrt(B.eff);
    const droopK = B.mw / 0.5; // full battery power at 0.5 Hz deviation
    const hSub = 1 / 60 / SUBSTEPS; // hours per substep
    let bSum = 0, shedSum = 0, strained = false, maxDev = 0;

    for (let k = 0; k < SUBSTEPS; k++) {
      const shedMW = this.shed.reduce((s, x) => s + x, 0);
      const served = Math.max(0, demand - shedMW);
      // battery: setpoint plus automatic fast frequency response (droop)
      let b = clamp(this.battery.setpoint - droopK * this.df, -B.mw, B.mw);
      if (b > 0) b = Math.min(b, (this.battery.soc * etaD) / hSub);
      else b = Math.max(b, -((B.mwh - this.battery.soc) / etaC) / hSub);
      if (b > 0) { this.battery.soc -= (b * hSub) / etaD; this.totals.batteryOut += b * hSub; }
      else { this.battery.soc -= b * hSub * etaC; this.totals.batteryIn += -b * hSub; }
      this.battery.soc = clamp(this.battery.soc, 0, B.mwh);
      bSum += b;
      const gen = thermalMW + this.ren.wind.output + this.ren.solar.output + b;
      const imbalance = gen - served;
      const damping = LOAD_DAMPING * served; // MW per Hz
      this.df += ((imbalance - damping * this.df) / M) / SUBSTEPS;
      shedSum += shedMW;
      const f = F0 + this.df;
      maxDev = Math.max(maxDev, Math.abs(this.df));
      if (Math.abs(this.df) > STRAIN_HZ) strained = true;

      if (this.shedCooldown > 0) this.shedCooldown--;
      if (this.tripCooldown > 0) this.tripCooldown--;
      // under-frequency load shedding
      if (f < UFLS_HZ && this.shedCooldown === 0 && this.shed.length < MAX_BLOCKS) {
        this.shed.push(SHED_BLOCK * demand);
        this.shedCooldown = 4;
        this.healthy = 0;
        this.totals.shedEvents++;
        this._logEvent('shed', `Frequency hit ${f.toFixed(2)} Hz: automatic load shedding, ${this.shed.length * 5}% of customers dark`);
      }
      // over-frequency protection trips a generator
      if (f > OVERFREQ_HZ && this.tripCooldown === 0) {
        this.tripCooldown = 3 * SUBSTEPS;
        let best = null;
        for (const id of THERMAL) {
          const u = this.units[id];
          if (u.online > 0 && (!best || u.output > this.units[best].output)) best = id;
        }
        if (best) {
          const before = this.units[best].output;
          this._trip(best, 1, TRIP_MINUTES, `Over-frequency (${f.toFixed(2)} Hz): a ${F[best].name.toLowerCase()} unit tripped offline`, 'trip');
          thermalMW -= before - this.units[best].output;
        } else {
          // no spinning units left: inverters back off on their own
          const excess = imbalance;
          for (const id of ['solar', 'wind']) {
            const r = this.ren[id];
            const cut = Math.min(r.output, excess);
            r.output -= cut;
            r.target = r.output;
          }
          this._logEvent('trip', `Over-frequency (${f.toFixed(2)} Hz): renewables forced to curtail`);
        }
        this.totals.trips++;
        this.hourly[Math.floor(t / 60)].trips++;
      }
    }

    // restoration of shed blocks once frequency has been healthy for a while
    if (this.shed.length && this.df > -0.1) {
      this.healthy++;
      if (this.healthy >= RESTORE_AFTER) {
        this.shed.pop();
        this.healthy = 0;
        this._logEvent('restore', this.shed.length ? `Power restored to some customers (${this.shed.length * 5}% still dark)` : 'All customers back on');
      }
    } else if (this.shed.length) this.healthy = 0;

    // accounting (per minute)
    const shedAvg = shedSum / SUBSTEPS;
    const bAvg = bSum / SUBSTEPS;
    this.battery.output = bAvg;
    const tot = this.totals;
    const hr = 1 / 60;
    const E = tot.energy;
    E.nuclear += this.units.nuclear.output * hr;
    tot.cost += this.units.nuclear.output * hr * F.nuclear.cost;
    for (const id of THERMAL) {
      const e = this.units[id].output * hr;
      E[id] += e;
      tot.cost += e * F[id].cost;
      tot.co2 += e * F[id].co2;
    }
    E.wind += this.ren.wind.output * hr;
    E.solar += this.ren.solar.output * hr;
    E.battery += bAvg * hr;
    tot.curtailedMWh += (wAvail - this.ren.wind.output + sAvail - this.ren.solar.output) * hr;
    if (bAvg > 0) tot.cost += bAvg * hr * F.battery.wearCost;
    if (drMW > 0) { tot.drMWh += drMW * hr; tot.cost += drMW * hr * F.dr.cost; }
    tot.unservedMWh += shedAvg * hr;
    tot.maxShedMW = Math.max(tot.maxShedMW, shedAvg);
    const H = this.hourly[Math.floor(t / 60)];
    H.shedMWh += shedAvg * hr;
    if (strained) H.strainedMin++;
    H.maxDev = Math.max(H.maxDev, maxDev);

    const h = this.hist;
    h.freq[t] = F0 + this.df;
    h.demand[t] = demand;
    h.served[t] = demand - shedAvg;
    h.nuclear[t] = this.units.nuclear.output;
    for (const id of THERMAL) h[id][t] = this.units[id].output;
    h.wind[t] = this.ren.wind.output;
    h.solar[t] = this.ren.solar.output;
    h.battery[t] = bAvg;
    h.shed[t] = shedAvg;

    this.last = this._snapshot(demand, demand - shedAvg, drMW);
    this.t++;
    if (this.t >= DAY_MIN) this.done = true;
    return this;
  }

  _snapshot(demand, served, drMW) {
    let gen = 0;
    for (const id of ['nuclear', ...THERMAL]) gen += this.units[id].output;
    gen += this.ren.wind.output + this.ren.solar.output + this.battery.output;
    return { demand, served, drMW, gen };
  }

  /**
   * The read-only view a dispatch policy gets each minute. Plain data only so it
   * can be posted to a Web Worker. Forecast arrays are sent separately (once).
   */
  observe() {
    const F = this.f;
    const fleets = {};
    for (const id of THERMAL) {
      const d = F[id], u = this.units[id];
      fleets[id] = {
        output: u.output, target: u.target, online: u.online, starting: u.starting.length,
        startingIn: u.starting.length ? Math.min(...u.starting) : 0,
        available: d.units - u.out, units: d.units, unitMW: d.unitMW,
        capacity: (d.units - u.out) * d.unitMW, onlineMW: u.online * d.unitMW,
        minFrac: d.minFrac, rampPerMin: Math.max(u.online, 1) * d.rampPerUnit, rampPerUnit: d.rampPerUnit,
        startMin: d.startMin, cost: d.cost, co2: d.co2, commit: u.commit,
      };
    }
    const nu = this.units.nuclear;
    fleets.nuclear = { output: nu.output, online: nu.online, units: F.nuclear.units, unitMW: F.nuclear.unitMW, cost: F.nuclear.cost, co2: 0 };
    for (const id of ['wind', 'solar']) {
      const r = this.ren[id];
      fleets[id] = { available: r.avail, output: r.output, target: r.target, capacity: F[id].mw };
    }
    const B = F.battery;
    fleets.battery = { soc: this.battery.soc, socFrac: this.battery.soc / B.mwh, mwh: B.mwh, mw: B.mw, output: this.battery.output, setpoint: this.battery.setpoint, eff: B.eff };
    const drActive = this.t >= this.dr.start && this.t < this.dr.end;
    return {
      t: this.t,
      time: fmtTime(this.t),
      hour: this.t / 60,
      frequency: F0 + this.df,
      deviation: this.df,
      demand: this.last.demand,
      served: this.last.served,
      shedMW: this.last.demand - this.last.served,
      generation: this.last.gen,
      imbalance: this.last.gen - this.last.served,
      fleets,
      dr: { callsLeft: this.dr.callsLeft, active: drActive, pending: this.t < this.dr.start, mw: F.dr.mw, minutes: F.dr.minutes, delay: F.dr.delay, endsAt: this.dr.end },
    };
  }

  /** Forecast arrays (per minute, MW). What a real operator would have from day-ahead forecasts. */
  forecast() {
    return {
      demand: Array.from(this.prof.demandF),
      wind: Array.from(this.prof.windF),
      solar: Array.from(this.prof.solarF),
    };
  }

  result() {
    return scoreRun(this);
  }
}

// ---------------------------------------------------------------- scoring

export function hourCell(h) {
  if (h.shedMWh > 0.01) return 'red';
  if (h.strainedMin >= 3 || h.trips > 0) return 'yellow';
  return 'green';
}

export const GRADE_ORDER = ['A+', 'A', 'B', 'C', 'D', 'F'];

export function gradeFor(unservedMWh, societal, par) {
  if (unservedMWh > 0.5) {
    if (unservedMWh < 100) return 'C';
    if (unservedMWh < 1000) return 'D';
    return 'F';
  }
  if (!par) return 'A';
  const r = societal / par;
  if (r <= 1.0) return 'A+';
  if (r <= 1.06) return 'A';
  if (r <= 1.18) return 'B';
  return 'C';
}

export function scoreRun(sim) {
  const T = sim.totals;
  const societal = T.cost + T.unservedMWh * VOLL + T.co2 * CARBON_PRICE;
  const cells = sim.hourly.map(hourCell);
  const genMWh = Object.values(T.energy).reduce((a, b) => a + b, 0);
  return {
    scenario: sim.sc.id,
    complete: sim.done,
    minutes: sim.t,
    unservedMWh: T.unservedMWh,
    cost: T.cost,
    co2: T.co2,
    societal,
    grade: gradeFor(T.unservedMWh, societal, sim.sc.par),
    cells,
    trips: T.trips,
    shedEvents: T.shedEvents,
    maxShedMW: T.maxShedMW,
    curtailedMWh: T.curtailedMWh,
    cleanShare: genMWh > 0 ? (T.energy.nuclear + T.energy.wind + T.energy.solar) / genMWh : 0,
    starts: T.starts,
  };
}

/** Run a whole day with a synchronous policy function (used by tests and baselines). */
export function runDay(scenario, policy, opts = {}) {
  const sim = new GridSim(scenario, opts);
  const forecast = sim.forecast();
  const memory = {};
  while (!sim.done) {
    const state = sim.observe();
    state.forecast = forecast;
    let action = null;
    if (policy) action = policy(state, memory);
    sim.step(action);
  }
  return { sim, result: sim.result() };
}
