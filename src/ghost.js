// Hold 60 — ghost runs. Your best previous run of the same day is stored as a compact frequency trace
// (one sample every 3 minutes, in mHz, as integers) and drawn faintly under the live chart on replays.
// Pure functions only; localStorage lives in app.js.

export const GHOST_STEP = 3;

/** Float frequency history (Hz, one value per minute) -> small integer array of deviation in mHz. */
export function packGhost(freq) {
  const out = [];
  for (let m = 0; m < freq.length; m += GHOST_STEP) out.push(Math.round((freq[m] - 60) * 1000));
  return out;
}

/** Back to deviation in Hz per sample, or null if the stored value is not a usable ghost. */
export function unpackGhost(packed) {
  if (!Array.isArray(packed) || packed.length < 10 || packed.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  return packed.map((v) => v / 1000);
}

/** Should this finished run replace the stored ghost? Lower score wins; a blackout-free run beats any blackout. */
export function isBetterRun(result, prev) {
  if (!prev || typeof prev.societal !== 'number') return true;
  return result.societal < prev.societal;
}

export function makeGhost(result, freq) {
  return { societal: result.societal, grade: result.grade, f: packGhost(freq) };
}
