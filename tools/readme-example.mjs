// Runs the example policy from README.md on every day, so the docs never lie.
// Usage: node tools/readme-example.mjs
import { readFileSync } from 'node:fs';
import { SCENARIOS } from '../src/scenarios.js';
import { runDay } from '../src/sim.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const code = readme.split('```js')[1].split('```')[0];
const dispatch = new Function(code + ';return dispatch;')();
for (const sc of SCENARIOS) {
  const r = runDay(sc, dispatch).result;
  console.log(sc.id.padEnd(9), r.grade.padEnd(3), `${r.unservedMWh.toFixed(0)} MWh dark`, `$${(r.societal / 1e6).toFixed(2)}M`);
}
