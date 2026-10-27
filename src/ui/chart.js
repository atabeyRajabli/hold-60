// Day chart: stacked generation for the past, forecast lines for the future.

import { DAY_MIN } from '../sim.js';
import { GHOST_STEP } from '../ghost.js';

export const STACK = ['nuclear', 'coal', 'gas', 'peaker', 'wind', 'solar', 'battery'];
export const LABELS = {
  nuclear: 'Nuclear', coal: 'Coal', gas: 'Gas CC', peaker: 'Peakers', wind: 'Wind', solar: 'Solar', battery: 'Battery',
};

export function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const c = {};
  for (const id of STACK) c[id] = v('--c-' + id);
  Object.assign(c, {
    ink: v('--ink'), muted: v('--muted'), line: v('--line'), panel: v('--panel'),
    ok: v('--ok'), warn: v('--warn'), bad: v('--bad'),
  });
  return c;
}

export function createChart(canvas, legendEl) {
  const ctx = canvas.getContext('2d');
  let colors = readColors();
  let W = 0, H = 0, dpr = 1;
  let lastSim = null;
  let ghost = null; // deviation (Hz) from 60 of your best earlier run on this same day, every GHOST_STEP minutes

  if (legendEl) {
    legendEl.innerHTML = STACK.map((id) => `<li><i style="background:var(--c-${id})"></i>${LABELS[id]}</li>`).join('') +
      '<li><i class="line" style="background:var(--ink)"></i>Demand</li>' +
      '<li><i class="dash"></i>Forecast</li>' +
      '<li><i class="dash" style="border-top-style:dotted;border-color:var(--ink)"></i>Net demand</li>' +
      '<li class="ghost-key" hidden><i class="line" style="background:var(--muted);opacity:.8"></i>Best run (Hz)</li>';
  }
  const ghostKey = legendEl && legendEl.querySelector('.ghost-key');

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(10, r.width); H = Math.max(10, r.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (lastSim) draw(lastSim);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  function draw(sim) {
    lastSim = sim;
    if (!W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const narrow = W < 520;
    const pl = narrow ? 34 : 42, pr = 8, pt = 8, pb = 30;
    const stripH = 6;
    const laneH = H >= 250 ? 30 : 22; // the frequency lane under the plot
    const pw = W - pl - pr, ph = H - pt - pb - stripH - 4 - laneH - 6;
    const P = sim.prof;
    let ymax = 0;
    for (let m = 0; m < DAY_MIN; m += 10) ymax = Math.max(ymax, P.demandF[m], P.demand[m]);
    ymax = Math.ceil((ymax * 1.15) / 1000) * 1000;
    const X = (m) => pl + (m / DAY_MIN) * pw;
    const Y = (mw) => pt + ph - (Math.max(0, mw) / ymax) * ph;

    // grid
    ctx.font = `11px ui-monospace, Consolas, monospace`;
    ctx.fillStyle = colors.muted;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const ystep = ymax > 8000 ? 2000 : 1000;
    for (let y = 0; y <= ymax; y += ystep) {
      ctx.beginPath(); ctx.moveTo(pl, Math.round(Y(y)) + 0.5); ctx.lineTo(W - pr, Math.round(Y(y)) + 0.5); ctx.stroke();
      ctx.fillText(y === 0 ? '0' : `${y / 1000} GW`, pl - 5, Y(y));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xstep = narrow ? 6 : 3;
    for (let h = 0; h <= 24; h += xstep) ctx.fillText(String(h).padStart(2, '0'), X(h * 60), H - pb + stripH + 10);

    const t = sim.t;
    const step = W < 700 ? 2 : 1;
    // stacked areas for the past
    if (t > 1) {
      const base = new Float32Array(t);
      for (const id of STACK) {
        const arr = sim.hist[id];
        ctx.beginPath();
        ctx.moveTo(X(0), Y(base[0]));
        for (let m = 0; m < t; m += step) ctx.lineTo(X(m), Y(base[m] + Math.max(0, arr[m])));
        ctx.lineTo(X(t - 1), Y(base[t - 1] + Math.max(0, arr[t - 1])));
        for (let m = t - 1; m >= 0; m -= step) ctx.lineTo(X(m), Y(base[m]));
        ctx.closePath();
        ctx.fillStyle = colors[id];
        ctx.globalAlpha = 0.82;
        ctx.fill();
        ctx.globalAlpha = 1;
        for (let m = 0; m < t; m++) base[m] += Math.max(0, arr[m]);
      }
      // load shed (red) between served and demand
      let anyShed = false;
      for (let m = 0; m < t; m++) if (sim.hist.shed[m] > 0.5) { anyShed = true; break; }
      if (anyShed) {
        ctx.fillStyle = colors.bad;
        ctx.globalAlpha = 0.55;
        for (let m = 0; m < t; m++) {
          const s = sim.hist.shed[m];
          if (s > 0.5) ctx.fillRect(X(m), Y(sim.hist.demand[m]), Math.max(1, pw / DAY_MIN + 0.5), Y(sim.hist.served[m]) - Y(sim.hist.demand[m]));
        }
        ctx.globalAlpha = 1;
      }
      // demand line (what customers wanted)
      ctx.beginPath();
      for (let m = 0; m < t; m += step) (m ? ctx.lineTo : ctx.moveTo).call(ctx, X(m), Y(sim.hist.demand[m]));
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // forecast demand (dashed) and net demand (dotted) for the whole day
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors.muted;
    ctx.beginPath();
    for (let m = 0; m < DAY_MIN; m += 5) (m ? ctx.lineTo : ctx.moveTo).call(ctx, X(m), Y(P.demandF[m]));
    ctx.stroke();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    for (let m = 0; m < DAY_MIN; m += 5) {
      const net = P.demandF[m] - P.windF[m] - P.solarF[m];
      (m ? ctx.lineTo : ctx.moveTo).call(ctx, X(m), Y(net));
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // future shading
    if (t < DAY_MIN) {
      ctx.fillStyle = colors.panel;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(X(t), pt, X(DAY_MIN) - X(t), ph);
      ctx.globalAlpha = 1;
    }
    // now line
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(X(t)) + 0.5, pt); ctx.lineTo(Math.round(X(t)) + 0.5, pt + ph); ctx.stroke();

    // frequency lane: this run's frequency, with the ghost of your best earlier run under it
    {
      const ly = pt + ph + 6, lo = 59.2, hi = 60.6;
      const FY = (f) => ly + laneH - ((Math.min(hi, Math.max(lo, f)) - lo) / (hi - lo)) * laneH;
      ctx.lineWidth = 1;
      ctx.strokeStyle = colors.line;
      ctx.beginPath(); ctx.moveTo(pl, Math.round(FY(60)) + 0.5); ctx.lineTo(W - pr, Math.round(FY(60)) + 0.5); ctx.stroke();
      ctx.strokeStyle = colors.bad;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(pl, Math.round(FY(59.3)) + 0.5); ctx.lineTo(W - pr, Math.round(FY(59.3)) + 0.5); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.muted;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('60 Hz', pl - 5, FY(60));
      if (ghost) {
        ctx.strokeStyle = colors.muted;
        ctx.globalAlpha = 0.8;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < ghost.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(i * GHOST_STEP), FY(60 + ghost[i]));
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (t > 1) {
        ctx.strokeStyle = colors.ink;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let m = 0; m < t; m += step) (m ? ctx.lineTo : ctx.moveTo).call(ctx, X(m), FY(sim.hist.freq[m]));
        ctx.stroke();
      }
    }

    // frequency strip
    const sy = pt + ph + 6 + laneH + 3;
    ctx.fillStyle = colors.line;
    ctx.fillRect(pl, sy, pw, stripH);
    const cw = pw / DAY_MIN;
    for (let m = 0; m < t; m++) {
      const f = sim.hist.freq[m];
      const d = Math.abs(f - 60);
      ctx.fillStyle = sim.hist.shed[m] > 0.5 || f < 59.3 || f > 60.5 ? colors.bad : d > 0.2 ? colors.warn : colors.ok;
      ctx.fillRect(pl + m * cw, sy, cw + 0.6, stripH);
    }
  }

  return {
    draw,
    /** Faint line for your best earlier run of this same day (or null). */
    setGhost(g) {
      ghost = g && g.length ? g : null;
      if (ghostKey) ghostKey.hidden = !ghost;
      if (lastSim) draw(lastSim);
    },
    refreshColors() { colors = readColors(); if (lastSim) draw(lastSim); },
    destroy() { ro.disconnect(); },
  };
}
