import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML_URL = new URL('../index.html', import.meta.url);

const EXPORTS = [
  // ICT data
  'ASSETS', 'GATE_ITEMS', 'METHODS', 'SESSION_DEFS', 'CHECK_LABELS',
  'NON_BINANCE_ASSETS', 'BINANCE_HOSTS', 'OUTCOME_CHECKS',
  // time + sessions
  'getGST', 'fmtTime', 'fmt12hm', 'fmtCountdown', 'totalMinutes',
  'getCurrentSession', 'getNextKillZone',
  // signal pipeline
  'getSignal', 'getConfidencePct', 'getMTFAligned', 'getCHoCHStatus',
  'analyzeAsset', 'distToEntry',
  // journal pipeline
  'loadJournal', 'saveJournal', 'logCall', 'scheduleOutcomeChecks',
  'fetchOutcomeAtTime', 'checkPendingOutcomes', 'setManualOutcome',
  // alerts + news + funding + invalidation + macro
  'checkArmedAlerts', 'tagHeadline', 'getNewsContext',
  'getFundingContext', 'isInvalidated',
  'getMacroBlackout', 'ECON_EVENTS', 'isMTFStale',
  // live stream + sparkline + backtest
  'parseTickerMessage', 'recordSignalState', 'renderSparkline',
  'SIGNAL_HISTORY_MS', 'BINANCE_WS_URL',
  'simulateTradeOutcome', 'reconstructMTFAt', 'runBacktestSync',
  'summarizeBacktest', 'runBacktest', 'runBacktestAll',
  // hard guardrails
  'gstDateKey', 'nominalR', 'getDailyR', 'getSessionTradeCount',
  'bumpSessionTradeCount', 'isInRevengeCooldown',
  'DAILY_LOSS_LIMIT_R', 'MAX_TRADES_PER_SESSION', 'REVENGE_COOLDOWN_MS',
  // real CHoCH
  'findSwings', 'detectCHoCH', 'isCHoCHStale', 'fetchCHoCH', 'fetchAllCHoCH',
  // refresh-resilient guardrails
  'serializeGuardrailState', 'deserializeGuardrailState',
  'saveGuardrailState', 'loadGuardrailState',
  'GUARDRAIL_STATE_KEY', 'GUARDRAIL_STATE_VERSION', 'GUARDRAIL_MAX_AGE_MS',
  // EOD recap
  'summarizeDay', 'maybeRenderEodRecap', 'renderEodRecapModal', 'EOD_LAST_KEY',
  // sentiment
  'scoreHeadlineSentiment', 'aggregateAssetSentiment', 'getSentimentContext',
  'BULLISH_KEYWORDS', 'BEARISH_KEYWORDS', 'SENTIMENT_DECAY_MS',
  // performance
  'getCachedAssetState', 'invalidateAssetStateCache',
  'getTodaysJournalEntries', 'invalidateTodaysJournalCache',
  'recordTickPerf', 'getPerfStats', 'ASSET_STATE_TTL_MS',
  // backtest comparison
  'diffBacktests', 'runBacktestComparison',
  // non-Binance price feeds (Binance proxy symbols)
  'parseBinanceTicker', 'fetchProxyTicker', 'fetchNonBinancePrices',
  'PRICE_PROXY_SYMBOLS',
  // exchange routing
  '_exchangeUrl', 'openOnExchange',
  // trade-mode policy
  '_isFuturesAsset', 'setTradeMode', 'loadTradeModes', 'DEFAULT_TRADE_MODES',
  // live trading (real signed call via user-deployed Worker)
  'loadLiveTradingState', 'liveTradingStatus',
  'setLiveTradingEnabled', 'setLiveTradingDryRun',
  'getMexcApiKey', 'getMexcApiSecret', 'saveMexcKeys', 'clearMexcKeys',
  'getMexcWorkerUrl', 'setMexcWorkerUrl',
  'getSilverLeverage', 'setSilverLeverage',
  '_hmacSha256Hex', '_signMexcRequest', '_mexcContractSymbol',
  'computeMexcOrderQty',
  'placeMexcFuturesOrder', 'testMexcConnection', 'testFireSilver',
  // scalp mode + cooldown
  'getScalpTf', 'setScalpTf',
  'isMexcInCooldown', 'clearMexcCooldown', 'MEXC_COOLDOWN_MS',
  'scalpMonitorTick', '_normalizeBiasDir', '_suggestedEntryForTf',
];

function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>\s*<!--\s*═*\s*MOBILE/);
  if (!m) throw new Error('Could not locate the main inline <script> in index.html');
  return m[1];
}

function makeStubElement() {
  const el = {
    textContent: '', innerHTML: '', value: '', checked: false,
    style: new Proxy({}, { set() { return true; } }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    children: [], childNodes: [],
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    click() {}, focus() {}, blur() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, replaceChild() {},
    remove() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    getContext: () => ({
      fillRect() {}, strokeRect() {}, clearRect() {},
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
      fillText() {}, strokeText() {}, measureText: () => ({ width: 0 }),
      save() {}, restore() {}, setLineDash() {},
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    }),
  };
  return el;
}

function makeStorage(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
    _store: store,
  };
}

/**
 * Loads index.html into an isolated vm context with stubs and returns the
 * closure-exported app surface.
 *
 * @param {object} [opts]
 * @param {Date|number} [opts.now]      Fix the wall clock used by `new Date()` and `Date.now()`.
 * @param {string} [opts.tz]            Process TZ for the duration of load (default 'UTC').
 * @param {object} [opts.storage]       Initial localStorage entries.
 * @param {Function} [opts.fetch]       Stubbed fetch.
 * @param {Function} [opts.setTimeout]  Stubbed setTimeout (default: no-op returning 0).
 */
export function loadApp(opts = {}) {
  const { now, tz = 'UTC', storage, fetch: fetchStub, setTimeout: stStub } = opts;
  const prevTZ = process.env.TZ;
  if (tz) process.env.TZ = tz;

  const html = readFileSync(HTML_URL, 'utf8');
  const scriptText = extractScript(html);

  const RealDate = Date;
  let DateClass = RealDate;
  if (now !== undefined) {
    const fixed = now instanceof Date ? now.getTime() : Number(now);
    DateClass = class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(fixed);
        else super(...args);
      }
      static now() { return fixed; }
    };
  }

  const document = {
    getElementById: () => makeStubElement(),
    querySelector: () => makeStubElement(),
    querySelectorAll: () => [],
    createElement: () => makeStubElement(),
    addEventListener() {}, removeEventListener() {},
    body: makeStubElement(),
    documentElement: makeStubElement(),
    cookie: '',
    visibilityState: 'visible',
  };

  const sandbox = {
    Date: DateClass,
    Math, JSON,
    Array, Object, String, Number, Boolean, Symbol, RegExp, Error, Function,
    Promise, Map, Set, WeakMap, WeakSet,
    parseInt, parseFloat, isNaN, isFinite,
    Infinity, NaN, undefined,
    AbortSignal,
    crypto: globalThis.crypto,
    TextEncoder, TextDecoder,
    console,
    document,
    localStorage: makeStorage(storage),
    sessionStorage: makeStorage(),
    fetch: fetchStub || (async () => { throw new Error('fetch called without stub'); }),
    setTimeout: stStub || (() => 0),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node-test' },
    location: { href: 'http://localhost/', search: '', hash: '' },
    history: { pushState() {}, replaceState() {} },
    alert: () => {}, confirm: () => true, prompt: () => null,
    Notification: function () {},
    Audio: function () { return { play() {}, pause() {} }; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const exporter = `
;(globalThis.__app = {
${EXPORTS.map((n) => `  get ${n}() { return typeof ${n} === 'undefined' ? undefined : ${n}; }`).join(',\n')},
  get journal() { return typeof journal === 'undefined' ? undefined : journal; },
  set journal(v) { journal = v; },
  get mtfCache() { return typeof mtfCache === 'undefined' ? undefined : mtfCache; },
  set mtfCache(v) { mtfCache = v; },
  get alertLog() { return typeof alertLog === 'undefined' ? undefined : alertLog; },
  set alertLog(v) { alertLog = v; },
  get assetNewsMap() { return typeof assetNewsMap === 'undefined' ? undefined : assetNewsMap; },
  set assetNewsMap(v) { assetNewsMap = v; },
  get firstSyncDone() { return typeof firstSyncDone === 'undefined' ? undefined : firstSyncDone; },
  set firstSyncDone(v) { firstSyncDone = v; },
  get prevSignalMap() { return typeof prevSignalMap === 'undefined' ? undefined : prevSignalMap; },
  set prevSignalMap(v) { prevSignalMap = v; },
  get consecutiveSyncFails() { return typeof consecutiveSyncFails === 'undefined' ? undefined : consecutiveSyncFails; },
  set consecutiveSyncFails(v) { consecutiveSyncFails = v; },
  get lastSuccessfulSyncMs() { return typeof lastSuccessfulSyncMs === 'undefined' ? undefined : lastSuccessfulSyncMs; },
  set lastSuccessfulSyncMs(v) { lastSuccessfulSyncMs = v; },
  get lastAlertMs() { return typeof lastAlertMs === 'undefined' ? undefined : lastAlertMs; },
  set lastAlertMs(v) { lastAlertMs = v; },
  get fundingRateMap() { return typeof fundingRateMap === 'undefined' ? undefined : fundingRateMap; },
  set fundingRateMap(v) { fundingRateMap = v; },
  get signalHistory() { return typeof signalHistory === 'undefined' ? undefined : signalHistory; },
  set signalHistory(v) { signalHistory = v; },
  get lastLossMs() { return typeof lastLossMs === 'undefined' ? undefined : lastLossMs; },
  set lastLossMs(v) { lastLossMs = v; },
  get sessionTradeCounts() { return typeof sessionTradeCounts === 'undefined' ? undefined : sessionTradeCounts; },
  set sessionTradeCounts(v) { sessionTradeCounts = v; },
  get chochCache() { return typeof chochCache === 'undefined' ? undefined : chochCache; },
  set chochCache(v) { chochCache = v; },
  get sentimentEnabled() { return typeof sentimentEnabled === 'undefined' ? undefined : sentimentEnabled; },
  set sentimentEnabled(v) { sentimentEnabled = v; },
});
`;

  vm.createContext(sandbox);
  try {
    vm.runInContext(scriptText + exporter, sandbox, { filename: 'index.html' });
  } finally {
    if (tz) process.env.TZ = prevTZ;
  }

  return { sandbox, app: sandbox.__app };
}

/**
 * Build a Date whose .getHours()/.getMinutes()/.getSeconds() return the given
 * GST clock values when read by the app. Because session functions only ever
 * call .getHours/.getMinutes on the value they receive, we just need a Date
 * with the right local-time fields — the underlying epoch ms is irrelevant.
 */
export function gstDate(hour, minute = 0, second = 0) {
  return new Date(2024, 5, 15, hour, minute, second);
}
