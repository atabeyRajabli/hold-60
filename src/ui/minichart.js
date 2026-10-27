// A compact day chart for the phone's sticky header: forecast demand (dashed), net demand (dotted),
// what customers actually wanted (ink), what your plants made (status colour), and a "now" marker.
// Drawn only while the header is on screen.

import { DAY_MIN } from '../sim.js';
import { STACK, readColors } from './chart.js';

export function createMiniChart(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1, lastSim = null, filled = 0;
  const gen = new Float32Array(DAY_MIN); // total generation per minute, filled lazily from sim.hist

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(10, r.width); H = Math.max(10, r.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (lastSim) draw(lastSim);
  }
  new ResizeObserver(resize).observe(canvas);

  function draw(sim) {
    lastSim = sim;
    if (!W || !canvas.offsetParent) return; // hidden (display: none) -> nothing to paint
    if (sim.t < filled) filled = 0; // a new run
    for (; filled < sim.t; filled++) {
      let g = 0;
      for (const id of STACK) g += Math.max(0, sim.hist[id][filled]);
      gen[filled] = g;
    }
    const c = readColors();
    const P = sim.prof, t = sim.t;
    let ymax = 0;
    for (let m = 0; m < DAY_MIN; m += 10) ymax = Math.max(ymax, P.demandF[m]);
    ymax *= 1.1;
    const pad = 3, w = W - 2 * pad, h = H - 2 * pad;
    const X = (m) => pad + (m / DAY_MIN) * w;
    const Y = (mw) => pad + h - (Math.max(0, mw) / ymax) * h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const line = (fn, from, to, step) => { ctx.beginPath(); for (let m = from; m < to; m += step) (m === from ? ctx.moveTo : ctx.lineTo).call(ctx, X(m), Y(fn(m))); ctx.stroke(); };

    ctx.lineWidth = 1;
    ctx.strokeStyle = c.line;
    for (const hr of [6, 12, 18]) { ctx.beginPath(); ctx.moveTo(Math.round(X(hr * 60)) + 0.5, pad); ctx.lineTo(Math.round(X(hr * 60)) + 0.5, H - pad); ctx.stroke(); }

    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.2;
    line((m) => P.demandF[m], 0, DAY_MIN, 10);
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = c.ink;
    ctx.globalAlpha = 0.6;
    line((m) => P.demandF[m] - P.windF[m] - P.solarF[m], 0, DAY_MIN, 10);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    if (t > 1) {
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = c.ink;
      line((m) => sim.hist.demand[m], 0, t, 3);
      const f = 60 + sim.df;
      ctx.strokeStyle = f < 59.3 || f > 60.5 ? c.bad : Math.abs(f - 60) > 0.2 ? c.warn : c.ok;
      ctx.lineWidth = 2.2;
      line((m) => gen[m], 0, t, 3);
    }
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(t) + 0.5, pad); ctx.lineTo(X(t) + 0.5, H - pad); ctx.stroke();
  }
  return { draw };
}
