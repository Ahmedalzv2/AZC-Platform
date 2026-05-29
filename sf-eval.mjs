// Read-only client core for the StrategyFactory webhook service
// (fastcloud.daviddtech.com). EVALUATION ONLY: this module is structurally
// incapable of placing or mutating a trade. It exposes an allowlist of
// instant, non-trading modes and a payload builder that never emits a
// position/qty/leverage field. Trading and state-changing modes (set_leverage,
// cancel_order, etc.) are deliberately excluded.
//
// Custody note: even read-only calls send exchange API keys to a third-party
// server that can decrypt them. Use trade-only, IP-allowlisted keys on an
// isolated sub-account. Never log decrypted credentials — redactCreds first.

// Instant, side-effect-free modes only. State-changing modes are NOT here.
export const READ_ONLY_MODES = [
  'check_api_active',
  'accountinfo',
  'accountbalance',
  'tradingfunds',
  'tradingfunds_extension',
  'open_orders_snapshot',
  'positions_snapshot',
  'instrument_metadata',
  'market_ticker',
  'recent_trades',
  'trade_history',
  'account_config',
  'fetch_exchange_data',
  'fetch_pnl',
  'fetch_closed_pnl',
  'pop_data',
];

const CRED_FIELDS = ['api_key', 'api_secret', 'secret_key', 'passphrase'];

export function assertReadOnlyMode(mode) {
  if (!mode || typeof mode !== 'string') throw new Error(`mode required; got ${JSON.stringify(mode)}`);
  if (!READ_ONLY_MODES.includes(mode)) {
    throw new Error(`mode "${mode}" is not read-only / not allowed in eval client`);
  }
  return mode;
}

export function buildEvalPayload({ exchange, mode, api_key, api_secret, secret_key, passphrase, encryptor }) {
  assertReadOnlyMode(mode);
  const payload = {
    exchange,
    mode,
    api_key,
    api_secret,
    secret_key: secret_key ?? api_secret,   // webhook contract mirrors the secret
    passphrase: passphrase ?? '',
    encryptor: encryptor ?? '2',
  };
  // Belt-and-suspenders: guarantee no trade/sizing field ever rides along.
  for (const k of ['position', 'qty', 'qty_in_percentage', 'buy_leverage', 'sell_leverage', 'margin_mode', 'force_tp']) {
    delete payload[k];
  }
  return payload;
}

export function redactCreds(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const f of CRED_FIELDS) {
    if (f in out && out[f]) out[f] = '***redacted***';
  }
  return out;
}
