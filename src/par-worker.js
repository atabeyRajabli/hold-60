// Computes a daily grid's par and code par off the main thread (about 0.3 s of sim, which used to cause a hitch).
// A module worker, because it imports the same reference policies the page uses.
import { referencePars } from './reference.js';

self.onmessage = (e) => {
  const { id, sc } = e.data;
  try {
    self.postMessage({ id, ok: true, pars: referencePars(sc) });
  } catch (err) {
    self.postMessage({ id, ok: false, message: String(err && err.message ? err.message : err) });
  }
};
