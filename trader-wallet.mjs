// Pure helpers for the MEXC wallet-balance cache. Lives outside
// azc-trader.mjs so tests can import without tripping the MEXC-creds
// check that aborts module load when env vars are missing.

// Returns true when the cached wallet figure is old enough to warrant
// another signed-API fetch. `lastAt = 0` means "never fetched" → always
// refresh. Boundary (`now - lastAt === intervalMs`) refreshes, matching
// the original inline gate's `< intervalMs` skip predicate.
export function shouldRefreshWallet(lastAt, now, intervalMs) {
  if (!lastAt) return true;
  return (now - lastAt) >= intervalMs;
}
