// Main-thread side of the policy sandbox: one Web Worker per run, a timeout per tick.

import { locateSyntaxError } from './policy-check.js';

export const TICK_TIMEOUT_MS = 250;
export const INIT_TIMEOUT_MS = 2000;

export class PolicyError extends Error {
  constructor(message, { line = null, phase = 'tick', t = null } = {}) {
    super(message);
    this.line = line;
    this.phase = phase;
    this.t = t;
  }
}

export class PolicyRunner {
  constructor({ onLog } = {}) {
    this.onLog = onLog || (() => {});
    this.worker = null;
    this.pending = null;
    this.nextId = 1;
    this.lastKind = 'object'; // typeof what dispatch() returned last time ('undefined', 'array', ...)
  }

  _spawn() {
    this.stop();
    this.worker = new Worker(new URL('./policy-worker.js', import.meta.url));
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this._settle(new PolicyError(e.message || 'Worker crashed', { phase: 'worker' }));
    };
  }

  _onMessage(m) {
    if (m.type === 'log') { this.onLog(m.text); return; }
    if (!this.pending) return;
    if (m.type === 'ready') this._settle(null, true);
    else if (m.type === 'action' && m.id === this.pending.id) { this.lastKind = m.kind; this._settle(null, m.action); }
    else if (m.type === 'error') this._settle(new PolicyError(m.message, { line: m.line, phase: m.phase }));
  }

  _settle(err, value) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (err) p.reject(err); else p.resolve(value);
  }

  _request(msg, timeoutMs, what) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending = null;
        this.stop();
        reject(new PolicyError(`${what} took longer than ${timeoutMs} ms, so the run was stopped. Infinite loop?`, { phase: 'timeout' }));
      }, timeoutMs);
      this.pending = { id, resolve, reject, timer };
      this.worker.postMessage({ ...msg, id });
    });
  }

  /** Compile the player's code in a fresh worker. Rejects with PolicyError on syntax errors. */
  async start(code, forecast) {
    this._spawn();
    try {
      await this._request({ type: 'init', code, forecast }, INIT_TIMEOUT_MS, 'Loading your code');
    } catch (err) {
      // engines give no line for a syntax error from new Function: find it here (parsing never runs the code)
      if (err instanceof PolicyError && err.phase === 'compile' && !err.line && /SyntaxError/.test(err.message)) {
        try {
          const loc = locateSyntaxError(code);
          if (loc) {
            err.line = loc.line;
            if (loc.atEnd) err.message = 'SyntaxError: the code ends before it is complete (look for a { ( or [ that is never closed)';
          }
        } catch { /* keep the message without a line */ }
      }
      throw err;
    }
  }

  /** Ask the policy for this minute's setpoints. */
  async decide(state, timeoutMs = TICK_TIMEOUT_MS) {
    if (!this.worker) throw new PolicyError('Policy is not running');
    try {
      return await this._request({ type: 'tick', state }, timeoutMs, `dispatch() at ${state.time}`);
    } catch (err) {
      if (err instanceof PolicyError) err.t = state.t;
      throw err;
    }
  }

  stop() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new PolicyError('stopped', { phase: 'stopped' }));
      this.pending = null;
    }
    if (this.worker) { this.worker.terminate(); this.worker = null; }
  }
}
