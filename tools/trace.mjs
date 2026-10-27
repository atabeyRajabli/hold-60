import { getScenario } from '../src/scenarios.js';
import { runDay } from '../src/sim.js';
import * as P0 from '../src/policies.js';
import { expert } from './expert-policy.mjs';
const P = { ...P0, expert };
const [sid, pid, from = 0, to = 24, stepMin = 30] = process.argv.slice(2);
const { sim } = runDay(getScenario(sid), P[pid] || null);
const h = sim.hist;
for (let m = from * 60; m < to * 60; m += +stepMin) {
  const r = (x) => String(Math.round(x)).padStart(5);
  console.log(`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')} f=${h.freq[m].toFixed(2)} D=${r(h.demand[m])} nuc=${r(h.nuclear[m])} coal=${r(h.coal[m])} gas=${r(h.gas[m])} pk=${r(h.peaker[m])} wind=${r(h.wind[m])} sol=${r(h.solar[m])} bat=${r(h.battery[m])} shed=${r(h.shed[m])}`);
}
console.log(sim.log.map(e => `${Math.floor(e.t/60)}:${String(e.t%60).padStart(2,'0')} ${e.msg}`).slice(0, 40).join('\n'));
