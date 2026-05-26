// Thin Telegram notifier for the autonomous trader. Sends messages
// directly to the Bot API — the trader systemd unit already reads
// relay.env (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID), so no extra wiring.
// Best-effort: if Telegram is down or creds are missing, log and move
// on. Never let a notify failure interrupt the trade loop.
//
// Message formatters are exported pure so tests can pin the prose
// without making HTTP calls.

const MAX_LEN = 4000;
const TG_API  = 'https://api.telegram.org/bot';

export function fmtFireAlert({ symbol, dir, tier, entry, sl, tp, riskUsd, riskPct, candidateCount, totalSymbols }) {
  const sym  = String(symbol || '?').replace(/_USDT$/, '');
  const side = String(dir || '').toLowerCase() === 'bull' ? 'LONG' : 'SHORT';
  const cand = (Number.isFinite(candidateCount) && Number.isFinite(totalSymbols))
    ? ` · ${candidateCount}/${totalSymbols} cand`
    : '';
  return [
    `🔥 FIRE · ${sym} ${side}`,
    `tier=${tier || '?'}${cand}`,
    `entry=${entry} sl=${sl} tp=${tp}`,
    `risk≈$${Number(riskUsd).toFixed(2)} (${(Number(riskPct) * 100).toFixed(1)}%)`,
  ].join('\n');
}

export function fmtCloseAlert({ symbol, dir, outcome, rMultiple, realizedUsd, holdMs }) {
  const sym   = String(symbol || '?').replace(/_USDT$/, '');
  const side  = String(dir || '').toLowerCase() === 'bull' ? 'LONG' : 'SHORT';
  const icon  = outcome === 'win' ? '✅' : outcome === 'loss' ? '❌' : '⚖️';
  const r     = Number.isFinite(Number(rMultiple)) ? (rMultiple >= 0 ? '+' : '') + Number(rMultiple).toFixed(2) + 'R' : '—';
  const usd   = Number.isFinite(Number(realizedUsd))
    ? (realizedUsd >= 0 ? '+$' : '-$') + Math.abs(Number(realizedUsd)).toFixed(2)
    : '—';
  const hold  = Number.isFinite(Number(holdMs)) && holdMs > 0
    ? `held ${(holdMs / 60000).toFixed(0)}m`
    : '';
  return [
    `${icon} ${String(outcome || '?').toUpperCase()} · ${sym} ${side}`,
    `${r} · ${usd}${hold ? ' · ' + hold : ''}`,
  ].join('\n');
}

// Status-flip alert. Only sent on meaningful transitions — enabled→downshifted,
// downshifted→blocked, blocked→enabled (gate recovered). Same-status ticks
// stay silent so the operator's phone doesn't buzz every 5s.
export function fmtDriftAlert({ gate, key, fromStatus, toStatus, reason }) {
  const direction = (
    (fromStatus === 'enabled' && toStatus !== 'enabled') ? '⚠️' :
    (fromStatus !== 'enabled' && toStatus === 'enabled') ? '🟢' :
    '🔄'
  );
  return [
    `${direction} ${gate}-gate · ${String(key).toUpperCase()} ${fromStatus} → ${toStatus}`,
    String(reason || '').slice(0, 220),
  ].join('\n');
}

export async function sendTelegram(text, opts = {}) {
  const token = opts.token || process.env.TELEGRAM_BOT_TOKEN || '';
  const chat  = opts.chat  || process.env.TELEGRAM_CHAT_ID   || '';
  if (!token || !chat) return { ok: false, reason: 'no-creds' };
  try {
    const r = await fetch(TG_API + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: String(text).slice(0, MAX_LEN),
        disable_web_page_preview: true,
      }),
    });
    if (!r.ok) return { ok: false, reason: `http-${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
