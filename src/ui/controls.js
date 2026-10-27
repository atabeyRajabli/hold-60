// Manual controls: one row per fleet. Sliders set targets; fills show what is actually produced.

import { THERMAL, CARBON_PRICE } from '../sim.js';

const fmt = (x) => Math.round(x).toLocaleString('en-US');
const KEYS = { coal: 'Q/A', gas: 'W/S', peaker: 'E/D', battery: 'R/F', solar: 'T/G', wind: 'Y/H' };

function row(id, name, extraClass = '') {
  const d = document.createElement('div');
  d.className = 'ctl ' + extraClass;
  d.id = 'ctl-' + id;
  d.style.setProperty('--sw', `var(--c-${id})`);
  d.innerHTML = `<div class="ctl-head"><span class="sw" style="background:var(--c-${id})"></span><span class="name">${name}</span>${KEYS[id] ? `<span class="key" title="Keyboard">${KEYS[id]}</span>` : ''}<span class="val mono"></span></div>`;
  return d;
}

export function createControls(root, sim, onChange) {
  root.innerHTML = '';
  const F = sim.f;
  const parts = {};

  // nuclear: information only
  {
    const d = row('nuclear', 'Nuclear');
    d.insertAdjacentHTML('beforeend', `<div class="units" data-units></div><div class="ctl-sub"><span>Always on, can't ramp. Cheapest power you have.</span><span>$${F.nuclear.cost}/MWh · 0 t CO₂</span></div>`);
    root.appendChild(d);
    parts.nuclear = { el: d, val: d.querySelector('.val'), units: d.querySelector('[data-units]') };
  }

  for (const id of THERMAL) {
    const f = F[id];
    const max = f.units * f.unitMW;
    const d = row(id, f.name);
    d.insertAdjacentHTML('beforeend', `
      <div class="units" data-units></div>
      <div class="slider">
        <div class="track"><div class="online"></div><div class="fill"></div></div>
        <input type="range" min="0" max="${max}" step="10" aria-label="${f.name} target output in MW">
      </div>
      <div class="ctl-sub"><span class="state"></span><span title="Fuel $${f.cost}/MWh + ${f.co2} t CO₂ × $${CARBON_PRICE}/t. The score counts both.">${f.startMin >= 60 ? f.startMin / 60 + ' h' : f.startMin + ' min'} hot start · $${Math.round(f.cost + f.co2 * CARBON_PRICE)}/MWh with CO₂</span></div>`);
    root.appendChild(d);
    const input = d.querySelector('input');
    input.addEventListener('input', () => onChange(id, +input.value));
    parts[id] = {
      el: d, input, max, val: d.querySelector('.val'), fill: d.querySelector('.fill'),
      online: d.querySelector('.online'), units: d.querySelector('[data-units]'), state: d.querySelector('.state'),
    };
  }

  for (const id of ['wind', 'solar']) {
    const f = F[id];
    const d = row(id, f.name);
    d.insertAdjacentHTML('beforeend', `
      <div class="slider">
        <div class="track"><div class="avail"></div><div class="fill"></div></div>
        <input type="range" min="0" max="${f.mw}" step="10" aria-label="${f.name} curtailment cap in MW">
      </div>
      <div class="ctl-sub"><span class="state"></span><span>Free, zero CO₂. Slider caps output.</span></div>`);
    root.appendChild(d);
    const input = d.querySelector('input');
    input.addEventListener('input', () => onChange(id, +input.value));
    parts[id] = { el: d, input, max: f.mw, val: d.querySelector('.val'), fill: d.querySelector('.fill'), avail: d.querySelector('.avail'), state: d.querySelector('.state') };
  }

  {
    const B = F.battery;
    const d = row('battery', 'Battery', 'span2');
    d.insertAdjacentHTML('beforeend', `
      <div class="soc"><span>Charge</span><div class="soc-bar"><i></i></div><span class="mono soc-pct">50%</span><span class="mono soc-mwh"></span></div>
      <div class="slider">
        <div class="track"><div class="fill bi"></div><div class="zero"></div></div>
        <input type="range" min="${-B.mw}" max="${B.mw}" step="10" aria-label="Battery setpoint in MW, negative charges, positive discharges">
      </div>
      <div class="slider-labels"><span>◀ charge ${fmt(B.mw)} MW</span><span>idle</span><span>discharge ${fmt(B.mw)} MW ▶</span></div>
      <div class="ctl-sub"><span class="state"></span><span>Reacts to frequency on its own (until empty or full).</span></div>`);
    root.appendChild(d);
    const input = d.querySelector('input');
    input.addEventListener('input', () => {
      // snap to idle near the middle
      if (Math.abs(+input.value) < B.mw * 0.04) input.value = 0;
      onChange('battery', +input.value);
    });
    input.addEventListener('dblclick', () => { input.value = 0; onChange('battery', 0); });
    parts.battery = {
      el: d, input, max: B.mw, val: d.querySelector('.val'), fill: d.querySelector('.fill'),
      socBar: d.querySelector('.soc-bar i'), socPct: d.querySelector('.soc-pct'), socMwh: d.querySelector('.soc-mwh'), state: d.querySelector('.state'),
    };
  }

  {
    const D = F.dr;
    const d = row('dr', 'Demand response', 'span2');
    d.insertAdjacentHTML('beforeend', `
      <div class="dr-row">
        <button type="button" class="btn btn-small" data-dr>Call ${fmt(D.mw)} MW <span class="muted" style="font-size:12px">(X)</span></button>
        <span class="muted state"></span>
      </div>
      <div class="ctl-sub"><span>Factories and smart thermostats cut use for ${D.minutes / 60} h, ${D.delay} min after you call.</span><span>$${fmt(D.cost)}/MWh</span></div>`);
    root.appendChild(d);
    const btn = d.querySelector('[data-dr]');
    btn.addEventListener('click', () => onChange('dr', true));
    parts.dr = { el: d, btn, val: d.querySelector('.val'), state: d.querySelector('.state') };
  }

  function unitsHTML(total, on, starting, out) {
    let s = '';
    for (let i = 0; i < total; i++) {
      const cls = i < on ? 'on' : i < on + starting ? 'starting' : i >= total - out ? 'out' : '';
      s += `<i class="${cls}"></i>`;
    }
    return s;
  }

  const cache = new Map();
  const setHTML = (node, html) => { if (cache.get(node) !== html) { cache.set(node, html); node.innerHTML = html; } };
  const setText = (node, txt) => { if (cache.get(node) !== txt) { cache.set(node, txt); node.textContent = txt; } };

  return {
    parts,
    /** Pull slider positions from the sim (e.g. at start or after a policy ran). */
    syncInputs() {
      for (const id of THERMAL) parts[id].input.value = sim.units[id].target;
      for (const id of ['wind', 'solar']) parts[id].input.value = sim.ren[id].target;
      parts.battery.input.value = sim.battery.setpoint;
    },
    setDisabled(disabled) {
      for (const p of Object.values(parts)) {
        if (p.input) p.input.disabled = disabled;
        if (p.btn) { p.btn.dataset.locked = disabled ? '1' : '0'; p.btn.disabled = disabled; }
      }
    },
    update() {
      const nu = sim.units.nuclear;
      setHTML(parts.nuclear.val, `${fmt(nu.output)} <small>MW</small>`);
      setHTML(parts.nuclear.units, unitsHTML(F.nuclear.units, nu.online, 0, nu.out));
      for (const id of THERMAL) {
        const p = parts[id], u = sim.units[id], f = F[id];
        setHTML(p.val, `${fmt(u.output)} <small>/ ${fmt(u.target)} MW</small>`);
        p.fill.style.width = (u.output / p.max) * 100 + '%';
        p.online.style.width = ((u.online * f.unitMW) / p.max) * 100 + '%';
        setHTML(p.units, unitsHTML(f.units, u.online, u.starting.length, u.out));
        let st;
        if (u.starting.length) st = `<span class="state-starting">Starting ${u.starting.length} unit${u.starting.length > 1 ? 's' : ''}: ${Math.min(...u.starting)} min</span>`;
        else if (u.out) st = `<span class="state-out">${u.out} unit${u.out > 1 ? 's' : ''} broken</span> · ${u.online}/${f.units} on`;
        else st = `${u.online}/${f.units} units on`;
        const floor = u.online * f.unitMW * f.minFrac;
        if (u.online && u.target < floor - 1 && !u.starting.length) st += ` · min ${fmt(floor)} MW`;
        setHTML(p.state, st);
      }
      for (const id of ['wind', 'solar']) {
        const p = parts[id], r = sim.ren[id];
        setHTML(p.val, `${fmt(r.output)} <small>MW</small>`);
        p.fill.style.width = (r.output / p.max) * 100 + '%';
        p.avail.style.width = (r.avail / p.max) * 100 + '%';
        const cut = Math.max(0, r.avail - r.output);
        setText(p.state, cut > 5 ? `Curtailing ${fmt(cut)} MW` : r.avail < 5 ? (id === 'solar' ? 'Dark out' : 'Calm') : `Available ${fmt(r.avail)} MW`);
      }
      {
        const p = parts.battery, B = F.battery, b = sim.battery;
        const out = b.output;
        setHTML(p.val, `${out >= 0 ? '+' : '−'}${fmt(Math.abs(out))} <small>MW</small>`);
        const w = (Math.abs(out) / B.mw) * 50;
        p.fill.style.left = (out >= 0 ? 50 : 50 - w) + '%';
        p.fill.style.width = w + '%';
        const frac = b.soc / B.mwh;
        p.socBar.style.width = frac * 100 + '%';
        p.socBar.classList.toggle('low', frac < 0.12);
        setText(p.socPct, Math.round(frac * 100) + '%');
        setText(p.socMwh, `${fmt(b.soc)} / ${fmt(B.mwh)} MWh`);
        const auto = out - b.setpoint;
        setText(p.state, Math.abs(auto) > 15 ? `Auto-response ${auto > 0 ? '+' : '−'}${fmt(Math.abs(auto))} MW` : b.setpoint === 0 ? 'Idle, standing by' : b.setpoint > 0 ? 'Discharging' : 'Charging');
      }
      {
        const p = parts.dr, D = sim.dr;
        const active = sim.t >= D.start && sim.t < D.end;
        const pending = sim.t < D.start;
        setHTML(p.val, active ? `−${fmt(F.dr.mw)} <small>MW</small>` : `${D.callsLeft} <small>left</small>`);
        setText(p.state, active ? `Active, ${D.end - sim.t} min left` : pending ? `Starting in ${D.start - sim.t} min` : D.callsLeft ? `${D.callsLeft} of ${F.dr.calls} calls left today` : 'No calls left today');
        p.btn.disabled = !D.callsLeft || active || pending || p.btn.dataset.locked === '1';
      }
    },
  };
}
