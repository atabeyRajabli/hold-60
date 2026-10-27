// The hero element: an analog frequency gauge, 59.0 to 61.0 Hz.

import { OVERFREQ_HZ } from '../sim.js';

/** The trip headroom cue starts here: 0.2 Hz before the 60.5 Hz over-frequency trip. */
export const HEADROOM_FROM_HZ = 60.3;
/** Inside this many Hz of the trip the cue turns red and pulses, like the shed zone does below. */
export const HEADROOM_URGENT_HZ = 0.1;

/**
 * How close the grid is to the over-frequency trip, or null while there is plenty of room.
 * level: 'warn' (above 60.3 Hz), 'bad' (within 0.1 Hz of the trip, or past it).
 */
export function headroom(f) {
  if (!Number.isFinite(f) || f <= HEADROOM_FROM_HZ) return null;
  const hz = Math.max(0, OVERFREQ_HZ - f);
  return { hz, level: hz < HEADROOM_URGENT_HZ ? 'bad' : 'warn', text: hz > 0 ? `Trip in ${hz.toFixed(2)} Hz` : 'Tripping' };
}

const NS = 'http://www.w3.org/2000/svg';
const LO = 59.0, HI = 61.0;
const CX = 150, CY = 154, R = 118;

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

const angleOf = (f) => (-90 + ((Math.min(HI, Math.max(LO, f)) - LO) / (HI - LO)) * 180) * (Math.PI / 180);
const pt = (a, r) => [CX + r * Math.sin(a), CY - r * Math.cos(a)];

function arc(f1, f2, r) {
  const [x1, y1] = pt(angleOf(f1), r);
  const [x2, y2] = pt(angleOf(f2), r);
  const large = angleOf(f2) - angleOf(f1) > Math.PI ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export function createDial(container) {
  container.classList.add('dial');
  const svg = el('svg', { viewBox: '0 0 300 172', role: 'img', 'aria-label': 'Frequency gauge' }, container);
  const bands = [
    [59.0, 59.3, 'var(--bad)'], [59.3, 59.8, 'var(--warn)'], [59.8, 60.2, 'var(--ok)'],
    [60.2, 60.5, 'var(--warn)'], [60.5, 61.0, 'var(--bad)'],
  ];
  for (const [a, b, c] of bands) el('path', { d: arc(a, b, R), class: 'band', style: `stroke:${c};opacity:.85` }, svg);
  for (let i = 0; i <= 20; i++) {
    const f = LO + i * 0.1;
    const major = i % 5 === 0;
    const a = angleOf(f);
    const [x1, y1] = pt(a, R - 10);
    const [x2, y2] = pt(a, R - (major ? 22 : 16));
    el('line', { x1, y1, x2, y2, class: 'tick' + (major ? ' major' : '') }, svg);
    if (major) {
      const [lx, ly] = pt(a, R + 17);
      const t = el('text', { x: lx, y: ly + 4, class: 'lbl' + (i === 10 ? ' center' : '') }, svg);
      t.textContent = f.toFixed(1);
    }
  }
  const [sx, sy] = pt(angleOf(59.15), R - 27);
  el('text', { x: sx, y: sy, class: 'zone-txt' }, svg).textContent = 'shed';
  const [tx, ty] = pt(angleOf(60.75), R - 27);
  const tripTxt = el('text', { x: tx, y: ty, class: 'zone-txt' }, svg);
  tripTxt.textContent = 'trip';
  // headroom: the stretch between the needle and the trip line lights up, like the shed zone does when sagging
  const room = el('path', { class: 'room', d: '' }, svg);

  // recent min/max trace
  const trace = el('path', { class: 'trace', d: '' }, svg);
  const g = el('g', {}, svg);
  const tail = el('line', { class: 'needle-tail', x1: CX, y1: CY, x2: CX, y2: CY + 14 }, g);
  const needle = el('line', { class: 'needle', x1: CX, y1: CY, x2: CX, y2: CY - (R - 6) }, g);
  el('circle', { class: 'hub', cx: CX, cy: CY, r: 8 }, svg);
  void tail; void needle;

  let lo = 60, hi = 60, roomKey = '';
  return {
    set(f) {
      const a = (angleOf(f) * 180) / Math.PI;
      g.setAttribute('transform', `rotate(${a.toFixed(2)} ${CX} ${CY})`);
    },
    /** Light up the gap between `f` and the trip line (and the "trip" label) once f > 60.3 Hz. */
    headroom(f) {
      const h = headroom(f);
      const key = h ? h.level + Math.round(f * 100) : '';
      if (key === roomKey) return;
      roomKey = key;
      tripTxt.setAttribute('class', 'zone-txt' + (h ? ' ' + h.level : ''));
      room.setAttribute('class', 'room' + (h ? ' ' + h.level : ''));
      room.setAttribute('d', h && f < OVERFREQ_HZ ? arc(Math.max(f, HEADROOM_FROM_HZ), OVERFREQ_HZ, R) : '');
    },
    trace(min, max) {
      if (min === lo && max === hi) return;
      lo = min; hi = max;
      if (max - min < 0.01) { trace.setAttribute('d', ''); return; }
      trace.setAttribute('d', arc(Math.max(LO, min), Math.min(HI, max), R - 4));
    },
  };
}

/** Maps a frequency to a status level: 'ok' | 'warn' | 'bad'. */
export function statusOf(f, shedding = false) {
  if (shedding || f < 59.3 || f > 60.5) return 'bad';
  if (Math.abs(f - 60) > 0.2) return 'warn';
  return 'ok';
}
