// Pure helpers for code mode: warnings about what dispatch() returned, and a line number for syntax errors.
// No DOM and no Worker here, so both are unit-tested in Node.

/** Marker the worker puts in place of NaN / Infinity, because JSON would turn them into null. */
export const NONFINITE_PREFIX = '__nonfinite:';

const NUMERIC = ['coal', 'gas', 'peaker', 'wind', 'solar', 'battery'];
const COMMIT_KEYS = ['coal', 'gas', 'peaker'];
const TOP_KEYS = [...NUMERIC, 'dr', 'commit', 'setpoints'];

/** Edit distance, small strings only (used for "did you mean"). */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** The known key closest to `key` (within 2 edits, or differing only by case), else null. */
export function suggestKey(key, known = TOP_KEYS) {
  let best = null, bestD = 3;
  for (const k of known) {
    const dd = key.toLowerCase() === k.toLowerCase() ? 0 : distance(key, k);
    if (dd < bestD) { best = k; bestD = dd; }
  }
  return best;
}

function describeValue(v) {
  if (typeof v === 'string' && v.startsWith(NONFINITE_PREFIX)) return v.slice(NONFINITE_PREFIX.length); // NaN, Infinity, -Infinity
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return `the string ${JSON.stringify(v.length > 12 ? v.slice(0, 12) + '…' : v)}`;
  if (typeof v === 'object') return 'an object';
  return String(v);
}

function checkNumber(path, v, out) {
  if (typeof v === 'number' && Number.isFinite(v)) return;
  const what = describeValue(v);
  const nonFinite = typeof v === 'string' && v.startsWith(NONFINITE_PREFIX);
  out.push({
    id: `value:${path}`,
    key: path,
    text: nonFinite
      ? `"${path}" is ${what}, not a finite number, so it was ignored and the plant keeps its last value`
      : `"${path}" should be a number of MW but is ${what}, so it was ignored`,
  });
}

function checkFlat(obj, path, out, { nested }) {
  for (const k of Object.keys(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (k === 'setpoints' && !nested) continue; // checked separately below
    if (NUMERIC.includes(k)) checkNumber(p, obj[k], out);
    else if (k === 'dr') {
      if (obj[k] !== true && obj[k] !== false && obj[k] != null) out.push({ id: `value:${p}`, key: p, text: `"${p}" should be true or false but is ${describeValue(obj[k])}, so it was ignored` });
    } else if (k === 'commit') {
      const c = obj[k];
      if (c === null) continue; // allowed: releases every commitment
      if (typeof c !== 'object' || Array.isArray(c)) { out.push({ id: `value:${p}`, key: p, text: `"${p}" should be an object like { gas: 4 } but is ${describeValue(c)}, so it was ignored` }); continue; }
      for (const ck of Object.keys(c)) {
        const cp = `${p}.${ck}`;
        if (!COMMIT_KEYS.includes(ck)) {
          const s = suggestKey(ck, COMMIT_KEYS);
          out.push({ id: `key:${cp}`, key: cp, text: `unknown key "${cp}"${s ? ` (did you mean "${p}.${s}"?)` : ' (commit takes coal, gas or peaker)'}, so it was ignored` });
        } else if (c[ck] !== null) checkNumber(cp, c[ck], out);
      }
    } else {
      const s = suggestKey(k, nested ? TOP_KEYS.filter((x) => x !== 'setpoints') : TOP_KEYS);
      const extra = k === 'nuclear' ? ' (nuclear cannot be dispatched)' : '';
      out.push({ id: `key:${p}`, key: p, text: `unknown key "${p}"${s ? ` (did you mean "${s}"?)` : extra}, so it was ignored` });
    }
  }
}

/**
 * Warnings for one dispatch() result. Never throws and never changes the result.
 * @param {*} action  what the worker sent back (null / object, with NaN replaced by NONFINITE_PREFIX markers)
 * @param {string} kind  `typeof` the raw return value ('undefined', 'object', 'array', 'number', ...)
 * @returns {{id: string, key: string, text: string}[]} `id` is stable per problem, so callers can show each once
 */
export function checkAction(action, kind = 'object') {
  const out = [];
  if (kind === 'undefined') return out; // returning nothing is fine: every setpoint keeps its value
  if (kind !== 'object' || action == null) {
    const what = { array: 'an array', null: 'null', object: 'nothing usable', unserializable: 'an object that could not be copied (circular?)' }[kind] || `a ${kind}`;
    out.push({ id: 'return', key: 'return', text: `dispatch() returned ${what}, not an object like { gas: 900 }, so nothing changed` });
    return out;
  }
  checkFlat(action, '', out, { nested: false });
  if (action.setpoints && typeof action.setpoints === 'object') checkFlat(action.setpoints, 'setpoints', out, { nested: true });
  return out;
}

// ---------------------------------------------------------------- syntax errors

const CLOSER = { '{': '}', '(': ')', '[': ']', '${': '}', '`': '`' };

/**
 * A rough lexer: which brackets, template literals and block comments are still open at the end of `src`?
 * @returns {{stack: string[], inComment: boolean, bad: boolean}} `bad` = a closer that matches nothing, or a string
 *   that is cut off, i.e. already a real error that no amount of closing can fix.
 */
export function openThings(src) {
  const stack = [];
  const n = src.length;
  let i = 0, prev = '';
  const out = (extra) => ({ stack, inComment: false, bad: false, ...extra });
  while (i < n) {
    const c = src[i];
    if (stack[stack.length - 1] === '`') { // inside template text
      if (c === '\\') i += 2;
      else if (c === '`') { stack.pop(); prev = 'v'; i++; }
      else if (c === '$' && src[i + 1] === '{') { stack.push('${'); prev = '{'; i += 2; }
      else i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) return out({ inComment: true });
      i = e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c) { if (src[i] === '\n') return out({ bad: true }); i += src[i] === '\\' ? 2 : 1; }
      if (i >= n) return out({ bad: true });
      i++; prev = 'v';
      continue;
    }
    if (c === '`') { stack.push('`'); i++; continue; }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) { // a regex literal
      i++;
      let cls = false;
      while (i < n && (cls || src[i] !== '/')) {
        if (src[i] === '\n') return out({ bad: true });
        if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false;
        i++;
      }
      i++; prev = 'v';
      continue;
    }
    if (c === '{' || c === '(' || c === '[') stack.push(c);
    else if (c === '}' || c === ')' || c === ']') {
      const top = stack[stack.length - 1];
      if (top && CLOSER[top] === c) stack.pop();
      else return out({ bad: true });
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out();
}

/** `src` plus whatever closes its open brackets, template literals and comments (so a cut-off prefix can be test-compiled). */
export function completed(src) {
  const o = openThings(src);
  if (o.bad) return src;
  return src + '\n' + (o.inComment ? '*/\n' : '') + o.stack.map((x) => CLOSER[x]).reverse().join('');
}

const compileDefault = (src) => {
  // eslint-disable-next-line no-new-func
  new Function('console', src);
};

const MAX_LOCATE_LINES = 3000;

/**
 * Engines do not report a line for a syntax error thrown by `new Function`, so find it. Compile the first k lines
 * (closing any open brackets first) for every k: a prefix that fails only because a statement continues on the next
 * line stops failing later, but a real error keeps failing for every longer prefix. The culprit is therefore the first
 * line from which every prefix fails. If no prefix fails once closed, the code simply ends too early (an unclosed bracket).
 * @param {string} src
 * @param {(src: string) => void} [compile] throws for bad code (injectable for tests)
 * @returns {{line: number, atEnd: boolean, message: string} | null}  null when the code compiles
 */
export function locateSyntaxError(src, compile = compileDefault) {
  src = String(src ?? '');
  let fullErr = null;
  try { compile(src); } catch (e) { fullErr = e; }
  if (!fullErr) return null;
  const message = String(fullErr && fullErr.message);
  const lines = src.split('\n');
  if (lines.length > MAX_LOCATE_LINES) return null;
  let last = lines.length;
  while (last > 1 && !lines[last - 1].trim()) last--;
  const fails = [];
  for (let k = 1; k <= lines.length; k++) {
    try { compile(completed(lines.slice(0, k).join('\n'))); fails.push(false); } catch { fails.push(true); }
  }
  let k = lines.length;
  while (k >= 1 && fails[k - 1]) k--;
  if (k === lines.length) return { line: last, atEnd: true, message }; // every prefix compiles once closed: the code just ends too early
  return k + 1 <= lines.length ? { line: k + 1, atEnd: false, message } : { line: last, atEnd: true, message };
}
