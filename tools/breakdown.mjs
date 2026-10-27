import { SCENARIOS } from '../src/scenarios.js';
import { runDay } from '../src/sim.js';
import { BASELINES } from '../src/policies.js';
import { expert } from './expert-policy.mjs';
const sid = process.argv[2];
for (const [n, fn] of [...BASELINES.map(b => [b.name, b.fn]), ['EXPERT', expert]]) {
  const { sim } = runDay(SCENARIOS.find(s => s.id === sid), fn);
  const T = sim.totals, E = T.energy;
  console.log(n.padEnd(20), 'starts', T.starts, 'startCost', (T.startCost/1e6).toFixed(2), 'dr', T.drMWh.toFixed(0), 'curt', T.curtailedMWh.toFixed(0), Object.entries(E).map(([k,v])=>k+':'+(v/1000).toFixed(1)).join(' '), 'bIn', T.batteryIn.toFixed(0));
}
