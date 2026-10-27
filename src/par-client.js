// Main-thread side of the par worker, with a main-thread fallback so a missing or broken Worker never loses a par.
// `makeWorker` and `compute` are injectable so the fallback paths are unit-tested in Node.

import { referencePars } from './reference.js';

export const PAR_TIMEOUT_MS = 15000;

const defaultMakeWorker = () => new Worker(new URL('./par-worker.js', import.meta.url), { type: 'module' });

/**
 * @param {object} sc  a (cloneable) scenario
 * @param {{makeWorker?: () => Worker, compute?: (sc: object) => {par: number, codePar: number}, timeoutMs?: number}} [opts]
 * @returns {Promise<{par: number, codePar: number, via: 'worker'|'main'}>}  never rejects with a worker problem:
 *   if the worker can't be created, errors, times out or answers badly, the same numbers are computed on the main thread.
 */
export function computePars(sc, { makeWorker = defaultMakeWorker, compute = referencePars, timeoutMs = PAR_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let worker = null, timer = 0, done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { worker && worker.terminate(); } catch { /* already gone */ }
      fn();
    };
    const fallback = () => finish(() => {
      try { resolve({ ...compute(sc), via: 'main' }); } catch (err) { reject(err); }
    });
    try {
      worker = makeWorker();
      worker.onmessage = (e) => {
        const m = e.data;
        if (m && m.ok && m.pars && typeof m.pars.par === 'number' && typeof m.pars.codePar === 'number') finish(() => resolve({ ...m.pars, via: 'worker' }));
        else fallback();
      };
      worker.onerror = (e) => { e && e.preventDefault && e.preventDefault(); fallback(); };
      worker.onmessageerror = fallback;
      timer = setTimeout(fallback, timeoutMs);
      worker.postMessage({ id: 1, sc });
    } catch {
      fallback();
    }
  });
}
