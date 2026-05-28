// Pure label collapse: LC sentiment lives on a 1-5 scale across both
// topic and news endpoints. Anything outside [1, 5] or non-finite is
// "no signal" (null) — distinct from explicit neutral. Caller decides
// fail-open semantics.

export function _resolveLabel(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || typeof value !== 'number' || n < 1 || n > 5) return null;
  if (n <= 2.5) return 'bear';
  if (n >= 3.5) return 'bull';
  return 'neutral';
}
