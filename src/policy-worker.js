// Runs the player's dispatch() in isolation. The page can terminate this worker at
// any time, which is how an infinite loop gets stopped without freezing the tab.
/* eslint-env worker */
'use strict';

let dispatchFn = null;
let memory = {};
let forecast = null;
let logCount = 0;
const MAX_LOGS = 300;
const NONFINITE_PREFIX = '__nonfinite:'; // keep in step with src/policy-check.js

function lineOffset() {
  try {
    // eslint-disable-next-line no-new-func
    new Function('throw new Error("probe")')();
  } catch (e) {
    const m = /(?:<anonymous>|Function|eval)[^:]*:(\d+):\d+/.exec(String(e.stack));
    if (m) return Number(m[1]) - 1;
  }
  return 0;
}
const OFFSET = lineOffset();

function describe(err) {
  const msg = err && err.message ? `${err.name || 'Error'}: ${err.message}` : String(err);
  const m = /(?:<anonymous>|Function|eval)[^:]*:(\d+):(\d+)/.exec(String(err && err.stack));
  const line = m ? Number(m[1]) - OFFSET : null;
  return { message: msg, line: line && line > 0 ? line : null };
}

function fmtArg(a) {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)); } catch { return String(a); }
}

const userConsole = {
  log: (...args) => {
    if (logCount++ < MAX_LOGS) self.postMessage({ type: 'log', text: args.map(fmtArg).join(' ') });
    else if (logCount === MAX_LOGS + 1) self.postMessage({ type: 'log', text: '… more console output hidden' });
  },
};
userConsole.info = userConsole.warn = userConsole.error = userConsole.debug = userConsole.log;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    memory = {};
    logCount = 0;
    forecast = msg.forecast;
    try {
      // eslint-disable-next-line no-new-func
      const factory = new Function('console', msg.code + '\n;return typeof dispatch === "function" ? dispatch : undefined;');
      dispatchFn = factory(userConsole);
      if (typeof dispatchFn !== 'function') throw new Error('Define a function named dispatch(state, memory).');
      self.postMessage({ type: 'ready' });
    } catch (err) {
      // a SyntaxError from new Function carries no usable position (any "line" in its stack is the worker's own),
      // so leave the line empty and let the page find it
      const d = describe(err);
      if (err instanceof SyntaxError) d.line = null;
      self.postMessage({ type: 'error', phase: 'compile', ...d });
    }
  } else if (msg.type === 'tick') {
    const state = msg.state;
    state.forecast = forecast;
    try {
      const out = dispatchFn(state, memory);
      // `kind` lets the page warn about odd return values; NaN/Infinity would become null in JSON, so they get a marker
      const kind = out === null ? 'null' : Array.isArray(out) ? 'array' : typeof out;
      let action = null;
      if (out && typeof out === 'object') {
        try {
          action = JSON.parse(JSON.stringify(out, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? NONFINITE_PREFIX + String(v) : v)));
        } catch { action = null; }
      }
      self.postMessage({ type: 'action', id: msg.id, action, kind: out && typeof out === 'object' && !action ? 'unserializable' : kind });
    } catch (err) {
      self.postMessage({ type: 'error', phase: 'tick', id: msg.id, ...describe(err) });
    }
  }
};
