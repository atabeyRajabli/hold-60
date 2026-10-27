// Hold 60 — scenario data. Pure data, no DOM.
//
// Demand, wind and solar arrays are hand-built 25-point hourly shapes (hour 0..24)
// that follow the typical daily shapes visible in the US EIA Hourly Electric Grid
// Monitor (EIA-930) for Texas / central US balancing areas in the matching season.
// They are not copies of any single day; they are smoothed, normalised "typical"
// curves scaled to a fictional mid-sized grid. See README "Data" section.

/** The fictional grid you operate. Scenarios override parts of it. */
export const BASE_FLEET = {
  nuclear: { name: 'Nuclear', units: 2, unitMW: 600, cost: 12, co2: 0 },
  coal: {
    name: 'Coal', units: 3, unitMW: 550, minFrac: 0.45, rampPerUnit: 5,
    startMin: 240, cost: 30, co2: 1.0, startCost: 40000,
  },
  gas: {
    name: 'Gas CC', units: 6, unitMW: 450, minFrac: 0.4, rampPerUnit: 12,
    startMin: 60, cost: 40, co2: 0.37, startCost: 12000,
  },
  peaker: {
    name: 'Gas peakers', units: 12, unitMW: 100, minFrac: 0.25, rampPerUnit: 25,
    startMin: 10, cost: 140, co2: 0.6, startCost: 1500,
  },
  wind: { name: 'Wind', mw: 3000 },
  solar: { name: 'Solar', mw: 3500 },
  battery: { name: 'Battery', mw: 700, mwh: 2800, eff: 0.88, soc0: 0.5, wearCost: 10 },
  dr: { name: 'Demand response', calls: 3, mw: 500, minutes: 120, delay: 10, cost: 1000 },
};

function fleet(overrides = {}) {
  const out = {};
  for (const k of Object.keys(BASE_FLEET)) out[k] = { ...BASE_FLEET[k], ...(overrides[k] || {}) };
  return out;
}

const hm = (h, m = 0) => h * 60 + m;

export const SCENARIOS = [
  {
    id: 'spring',
    order: 1,
    name: 'Mild Spring Day',
    short: 'Spring',
    blurb: 'April. Breezy night, sunny afternoon, gentle evening peak. Learn the controls.',
    tip: 'Midday solar pushes everything else down. Curtail before the needle runs high.',
    seed: 1101,
    peakMW: 6000,
    demandShape: [0.72, 0.68, 0.66, 0.65, 0.66, 0.70, 0.77, 0.84, 0.87, 0.88, 0.89, 0.90, 0.90, 0.90, 0.90, 0.91, 0.93, 0.96, 0.99, 1.00, 0.98, 0.92, 0.84, 0.77, 0.72],
    windShape: [0.48, 0.50, 0.51, 0.50, 0.48, 0.45, 0.40, 0.34, 0.30, 0.28, 0.27, 0.27, 0.28, 0.29, 0.30, 0.32, 0.34, 0.36, 0.40, 0.44, 0.47, 0.49, 0.50, 0.50, 0.48],
    solar: { rise: 6.6, set: 19.8, cf: 0.82 },
    demandNoise: 0.0012, windNoise: 0.006, solarNoise: 0.004,
    fleet: fleet(),
    events: [],
    par: 5_500_000, // score of the best zero-blackout reference policy (baselines, expert, tunedSimple in src/reference.js)
    codePar: 4_430_000, // best known zero-blackout score incl. the gas-first policy (src/reference.js): the target for code mode
  },
  {
    id: 'heatwave',
    order: 2,
    name: 'Texas-Style Heatwave',
    short: 'Heatwave',
    blurb: 'August, 104°F. Air conditioners peak at 5 pm, then the sun sets on 3.5 GW of solar.',
    tip: 'The hard part is not the peak. It is 7 to 9 pm, when solar fades and demand does not.',
    seed: 2207,
    peakMW: 8500,
    demandShape: [0.70, 0.66, 0.63, 0.61, 0.60, 0.61, 0.64, 0.68, 0.72, 0.77, 0.82, 0.87, 0.91, 0.94, 0.97, 0.99, 1.00, 1.00, 0.99, 0.97, 0.94, 0.90, 0.84, 0.77, 0.70],
    windShape: [0.40, 0.42, 0.42, 0.40, 0.37, 0.33, 0.27, 0.20, 0.14, 0.11, 0.10, 0.10, 0.11, 0.12, 0.14, 0.16, 0.18, 0.21, 0.26, 0.32, 0.37, 0.40, 0.42, 0.42, 0.40],
    solar: { rise: 6.9, set: 20.4, cf: 0.88 },
    demandNoise: 0.0012, windNoise: 0.007, solarNoise: 0.003,
    fleet: fleet(),
    events: [
      { at: hm(18, 20), type: 'trip', fleet: 'gas', units: 1, minutes: 150, msg: 'Gas unit tripped: cooling water too hot' },
    ],
    par: 10_400_000, // score of the best zero-blackout reference policy (baselines, expert, tunedSimple in src/reference.js)
    codePar: 10_300_000, // best known zero-blackout score incl. the gas-first policy (src/reference.js): the target for code mode
  },
  {
    id: 'storm',
    order: 3,
    name: 'Winter Storm',
    short: 'Storm',
    blurb: 'February, 9°F. Heating load all night. Gas lines freeze, turbines ice up, plants trip one by one.',
    tip: 'Every plant you have will be needed. Things break, so keep spare capacity running and the battery charged.',
    seed: 3313,
    peakMW: 6300,
    demandShape: [0.86, 0.85, 0.85, 0.86, 0.88, 0.92, 0.97, 1.00, 0.99, 0.95, 0.91, 0.88, 0.86, 0.85, 0.85, 0.86, 0.89, 0.94, 0.98, 0.99, 0.97, 0.94, 0.91, 0.88, 0.86],
    windShape: [0.42, 0.42, 0.41, 0.40, 0.40, 0.39, 0.38, 0.37, 0.36, 0.35, 0.35, 0.35, 0.35, 0.36, 0.37, 0.38, 0.39, 0.40, 0.41, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42],
    solar: { rise: 7.2, set: 18.3, cf: 0.35 },
    demandNoise: 0.0015, windNoise: 0.008, solarNoise: 0.006,
    fleet: fleet(),
    real: {
      title: 'This really happened, sort of',
      text: 'This day is shaped after the February 2021 winter storm in Texas: extreme cold froze gas supply and equipment, power plants tripped or could not start, and the grid operator ordered rolling outages that left millions of people without power. Here it is squeezed into one day on a small fictional grid, with invented timings and sizes, and the outages start automatically at 59.3 Hz, whereas the real ones were directed by the operator. It leaves out the gas-and-power interdependence, prices, transmission, and what the cold did to people. For what actually happened, read the joint FERC and NERC report on the event (see the README for sources).',
    },
    events: [
      { at: hm(0, 40), type: 'windDerate', factor: 0.45, until: hm(24), msg: 'Wind turbines icing up: output down by half' },
      { at: hm(2, 40), type: 'trip', fleet: 'gas', units: 1, msg: 'Gas unit tripped: frozen instrument lines' },
      { at: hm(4, 15), type: 'trip', fleet: 'peaker', units: 3, msg: 'Three peakers lost: gas pressure too low' },
      { at: hm(5, 30), type: 'trip', fleet: 'nuclear', units: 1, msg: 'Nuclear unit tripped: frozen feedwater sensor' },
      { at: hm(6, 10), type: 'trip', fleet: 'gas', units: 1, minutes: 540, msg: 'Gas unit tripped: fuel supply curtailed' },
      { at: hm(9, 30), type: 'trip', fleet: 'coal', units: 1, minutes: 300, msg: 'Coal unit down: frozen coal pile' },
    ],
    par: 14_100_000, // score of the best zero-blackout reference policy (baselines, expert, tunedSimple in src/reference.js)
    codePar: 14_070_000, // best known zero-blackout score incl. the gas-first policy (src/reference.js): the target for code mode
  },
  {
    id: 'windless',
    order: 4,
    name: 'The Wind Stopped',
    short: 'Windless',
    blurb: 'A warm, still September day. 3 GW of wind turbines barely turn. Everything burns.',
    tip: 'Cheap power is gone. Every MW is a cost and CO2 trade-off, and the evening is tight.',
    seed: 4421,
    peakMW: 7300,
    demandShape: [0.70, 0.66, 0.64, 0.63, 0.64, 0.68, 0.75, 0.81, 0.84, 0.86, 0.88, 0.90, 0.92, 0.94, 0.96, 0.98, 0.99, 1.00, 1.00, 0.98, 0.94, 0.88, 0.80, 0.74, 0.70],
    windShape: [0.06, 0.05, 0.05, 0.04, 0.04, 0.03, 0.03, 0.02, 0.02, 0.02, 0.02, 0.02, 0.03, 0.03, 0.03, 0.03, 0.04, 0.04, 0.05, 0.05, 0.06, 0.06, 0.06, 0.06, 0.06],
    solar: { rise: 7.1, set: 19.4, cf: 0.8 },
    demandNoise: 0.0012, windNoise: 0.01, solarNoise: 0.004,
    fleet: fleet(),
    events: [],
    par: 10_200_000, // score of the best zero-blackout reference policy (baselines, expert, tunedSimple in src/reference.js)
    codePar: 10_160_000, // best known zero-blackout score incl. the gas-first policy (src/reference.js): the target for code mode
  },
  {
    id: 'ai2030',
    order: 5,
    name: '2030: The AI Boom',
    short: 'AI 2030',
    blurb: 'A 1.8 GW AI training campus came online. It never sleeps, except when it checkpoints and drops 1.3 GW in seconds.',
    tip: 'Flat load is easy. Sudden load drops send frequency up. Keep room in the battery to absorb them.',
    seed: 5531,
    peakMW: 6000,
    flatLoadMW: 1800,
    demandShape: [0.72, 0.68, 0.66, 0.65, 0.66, 0.70, 0.77, 0.84, 0.87, 0.88, 0.89, 0.90, 0.91, 0.92, 0.93, 0.94, 0.96, 0.98, 1.00, 1.00, 0.98, 0.92, 0.84, 0.77, 0.72],
    windShape: [0.46, 0.48, 0.49, 0.48, 0.46, 0.43, 0.38, 0.32, 0.28, 0.26, 0.25, 0.25, 0.26, 0.27, 0.28, 0.30, 0.32, 0.34, 0.38, 0.42, 0.45, 0.47, 0.48, 0.48, 0.46],
    solar: { rise: 6.6, set: 20.0, cf: 0.84 },
    demandNoise: 0.0012, windNoise: 0.006, solarNoise: 0.004,
    fleet: fleet({
      coal: { units: 2 },
      gas: { units: 8 },
      wind: { mw: 3500 },
      solar: { mw: 6500 },
      battery: { mw: 1500, mwh: 6000 },
    }),
    events: [
      { at: hm(2, 20), type: 'load', mw: -1300, minutes: 12, msg: 'AI campus checkpoint: 1.3 GW of load vanished' },
      { at: hm(9, 45), type: 'load', mw: -1300, minutes: 10, msg: 'AI campus checkpoint: 1.3 GW of load vanished' },
      { at: hm(14, 10), type: 'load', mw: -1300, minutes: 15, msg: 'AI campus checkpoint: 1.3 GW of load vanished' },
      { at: hm(18, 30), type: 'load', mw: -1300, minutes: 12, msg: 'AI campus checkpoint: 1.3 GW of load vanished' },
      { at: hm(22, 50), type: 'load', mw: -1300, minutes: 10, msg: 'AI campus checkpoint: 1.3 GW of load vanished' },
    ],
    par: 7_300_000, // score of the best zero-blackout reference policy (baselines, expert, tunedSimple in src/reference.js)
    codePar: 6_670_000, // best known zero-blackout score incl. the gas-first policy (src/reference.js): the target for code mode
  },
];

export function getScenario(id) {
  return SCENARIOS.find((s) => s.id === id) || null;
}

/** The tutorial is the spring day with a coal unit tripping at midnight. */
export function tutorialScenario() {
  const sc = structuredClone(getScenario('spring'));
  sc.events = [{ at: 0, type: 'trip', fleet: 'coal', units: 1, minutes: 300, msg: 'A coal unit tripped: broken coal mill. 550 MW gone.' }, ...sc.events];
  sc.tutorial = true;
  return sc;
}
