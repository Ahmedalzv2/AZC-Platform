// Pure label collapse: LC sentiment lives on a 1-5 scale across both
// topic and news endpoints. Anything outside [1, 5] or non-finite is
// "no signal" (null) — distinct from explicit neutral. Caller decides
// fail-open semantics.

export function _resolveLabel(value) {
  if (!Number.isFinite(value) || value < 1 || value > 5) return null;
  if (value <= 2.5) return 'bear';
  if (value >= 3.5) return 'bull';
  return 'neutral';
}
