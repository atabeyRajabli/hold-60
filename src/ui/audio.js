// Optional "grid hum": a 120 Hz transformer-style buzz whose pitch follows frequency
// (deviation exaggerated 40x so you can hear it), plus a short alarm on load shedding.
// Off by default; only created after the player turns it on.

let ctx = null, osc = null, gain = null, filter = null;
let on = false;

export function soundOn() { return on; }

export function setSound(enabled) {
  on = enabled;
  if (enabled && !ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { on = false; return false; }
    ctx = new AC();
    osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 120;
    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start();
  }
  if (!ctx) return on;
  if (enabled && ctx.state === 'suspended') ctx.resume();
  gain.gain.setTargetAtTime(enabled ? 0.035 : 0, ctx.currentTime, 0.08);
  return on;
}

export function setHum(freqHz, running) {
  if (!ctx || !on) return;
  const pitch = 120 + (freqHz - 60) * 40;
  osc.frequency.setTargetAtTime(Math.max(40, pitch), ctx.currentTime, 0.05);
  gain.gain.setTargetAtTime(running ? 0.035 : 0.012, ctx.currentTime, 0.1);
}

export function alarm() {
  if (!ctx || !on) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'square';
  o.frequency.value = 880;
  g.gain.value = 0.0001;
  o.connect(g).connect(ctx.destination);
  const t = ctx.currentTime;
  g.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  o.start(t);
  o.stop(t + 0.3);
}
