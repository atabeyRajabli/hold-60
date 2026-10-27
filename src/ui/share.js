// Spoiler-free share text: grade, the score (societal cost, lower is better) and how it compares with par, a 24-hour emoji timeline, link.
// Also the native share sheet (navigator.share) with a clipboard fallback.

const EMOJI = { green: '🟩', yellow: '🟨', red: '🟥' };

export function money(x) {
  if (x >= 1e9) return '$' + (x / 1e9).toFixed(1) + 'B';
  if (x >= 1e6) return '$' + (x / 1e6).toFixed(1) + 'M';
  if (x >= 1e3) return '$' + Math.round(x / 1e3) + 'k';
  return '$' + Math.round(x);
}

/** Score-sized money with two decimals ($10.39M), so close runs can be told apart. */
export function moneyM(x) {
  if (x >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M';
  return money(x);
}

/** "+8.7% vs par" / "−1.2% vs par" */
export function vsPar(total, par) {
  if (!par) return '';
  const p = (total / par - 1) * 100;
  return `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}% vs par`;
}

export function tonnes(t) {
  if (t >= 1000) return (t / 1000).toFixed(1) + ' kt';
  return Math.round(t) + ' t';
}

export function mwh(x) {
  if (x < 0.5) return '0 MWh';
  if (x >= 10000) return (x / 1000).toFixed(1) + ' GWh';
  return Math.round(x).toLocaleString('en-US') + ' MWh';
}

/**
 * The link under the share text. A daily link carries its date, so a post opens the same grid on any day, and
 * the sharer's grade and score ($M), which drive the "can you beat it?" banner: `#daily/2026-11-17?g=B&s=11.3`.
 */
export function shareURL(scenarioId, mode, dailyDate = null, result = null) {
  const base = location.href.split('#')[0];
  const head = mode === 'code' ? 'code/' : '';
  if (!dailyDate) return `${base}#${head}${scenarioId}`;
  const q = result ? `?g=${encodeURIComponent(result.grade)}&s=${(result.societal / 1e6).toFixed(1)}` : '';
  return `${base}#${head}daily/${dailyDate}${q}`;
}

const STATUS_NOTE = { first: 'best', improved: 'best', kept: 'replay', template: 'template run' };

/** "(+2.1% vs par)" for manual runs; code runs also get the gap to code par, the best known policy. */
function parBits(scenario, result, mode) {
  const bits = [];
  if (scenario.par) bits.push(vsPar(result.societal, scenario.par));
  if (mode === 'code' && scenario.codePar) bits.push(vsPar(result.societal, scenario.codePar).replace('vs par', 'vs code par'));
  return bits.length ? ` (${bits.join(' · ')})` : '';
}

/**
 * Spoiler-free result text. The daily challenge leads with "HOLD 60 · Daily #N · date"; `status` is the
 * counted-run outcome ('first' | 'improved' -> "best today", 'kept' -> "replay", 'template' -> "template run").
 */
export function shareText({ scenario, result, mode, assisted = false, status = null, today = new Date().toISOString().slice(0, 10) }) {
  const who = mode === 'code' ? ' (my code)' : assisted ? ' (tutorial, autopilot)' : '';
  const dark = result.unservedMWh > 0.5 ? `${mwh(result.unservedMWh)} dark` : 'no blackouts';
  const daily = scenario.daily;
  const head = daily
    ? [`HOLD 60 · Daily #${daily.n} · ${daily.key}`, `${scenario.name}${who}${STATUS_NOTE[status] ? ' · ' + (STATUS_NOTE[status] === 'best' ? (daily.key === today ? 'best today' : 'best run') : STATUS_NOTE[status]) : ''}`]
    : [`Hold 60: ${scenario.name}${who}`];
  return [
    ...head,
    `Grade ${result.grade} · ${dark} · score ${moneyM(result.societal)}${parBits(scenario, result, mode)} · ${tonnes(result.co2)} CO2`,
    result.cells.map((c) => EMOJI[c]).join(''),
    shareURL(scenario.id, mode, daily ? daily.key : null, result),
  ].join('\n');
}

export const canShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

/** Native share sheet when there is one, otherwise the clipboard. Returns 'shared' | 'copied' | 'cancelled' | 'failed'. */
export async function shareResult(text) {
  if (canShare()) {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      /* any other failure: fall back to the clipboard */
    }
  }
  return (await copyText(text)) ? 'copied' : 'failed';
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
