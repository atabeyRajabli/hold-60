// Prints how each policy does on each scenario. Usage: node tools/tune.mjs [extraPolicyModule]
import { SCENARIOS } from '../src/scenarios.js';
import { runDay } from '../src/sim.js';
import { BASELINES } from '../src/policies.js';
import { pathToFileURL } from 'node:url';
const extra = process.argv[2] ? await import(pathToFileURL(process.argv[2]).href) : null;
const pols = [...BASELINES.map((b) => [b.name, b.fn])];
if (extra) pols.push(['EXPERT', extra.expert]);
pols.unshift(['(no action)', null]);
for (const sc of SCENARIOS) {
  console.log(`\n== ${sc.name}`);
  for (const [name, fn] of pols) {
    const { result: r, sim } = runDay(sc, fn);
    const minF = Math.min(...sim.hist.freq), maxF = Math.max(...sim.hist.freq);
    console.log(`${name.padEnd(20)} shed ${r.unservedMWh.toFixed(0).padStart(6)} MWh  cost $${(r.cost/1e6).toFixed(2)}M  co2 ${(r.co2/1000).toFixed(1)}kt  soc ${(sim.battery.soc).toFixed(0)} societal $${(r.societal/1e6).toFixed(2)}M  trips ${r.trips}  f[${minF.toFixed(2)},${maxF.toFixed(2)}]  ${r.cells.map(c=>c[0]).join('')} ${r.grade}`);
  }
}
