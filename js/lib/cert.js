// Pure helpers for TLS cert health (#359). One authoritative definition of the
// bucket math, shared by the public status page (a single green/orange/red dot)
// and the admin Infrastructure tab (full detail + burndown graph). No DOM, no
// network -- fully unit-testable.
//
// The cron (scripts/cert-monitor.sh) records only raw cert facts (not_before,
// not_after, checked_at). Everything derived -- days remaining, total validity
// window, bucket -- is computed here so the two consumers can never drift.

const MS_PER_DAY = 86400000;

// Bucket thresholds, in days remaining until not_after. green > 30, orange
// 14..30, red <= 14 (includes already-expired / negative). Kept as constants so
// the admin graph can draw threshold guide-lines from the same numbers.
export const CERT_GREEN_MIN_DAYS = 30;
export const CERT_ORANGE_MIN_DAYS = 14;

// Whole days from `fromIso` to `toIso`. Positive when toIso is later. Returns
// null if either timestamp is missing or unparseable so callers can render an
// 'unknown' state rather than NaN.
export function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.floor((to - from) / MS_PER_DAY);
}

// Days until the cert expires, relative to `nowIso` (defaults to real now).
// Negative once expired. null when not_after is missing/unparseable.
export function daysRemaining(notAfter, nowIso) {
  const now = nowIso || new Date().toISOString();
  return daysBetween(now, notAfter);
}

// Full validity window of the cert (not_before -> not_after). Let's Encrypt is
// ~90. Used as the graph's y-axis ceiling so the sawtooth reads against the
// cert's own lifetime, not a hard-coded 90.
export function totalDays(notBefore, notAfter) {
  return daysBetween(notBefore, notAfter);
}

// Classify days-remaining into a health bucket. null/unknown days -> 'unknown'.
export function certBucket(days) {
  if (days === null || days === undefined || Number.isNaN(days)) return 'unknown';
  if (days > CERT_GREEN_MIN_DAYS) return 'green';
  if (days >= CERT_ORANGE_MIN_DAYS) return 'orange';
  return 'red';
}

// Convenience: bucket straight from a status object ({ok, not_after}). A record
// with ok:false (cert unreadable) is 'unknown', not a false 'red'.
export function bucketForStatus(status, nowIso) {
  if (!status || status.ok === false || !status.not_after) return 'unknown';
  return certBucket(daysRemaining(status.not_after, nowIso));
}

const BUCKET_COLORS = {
  green: '#3aaa5b',
  orange: '#d98b1f',
  red: '#d0453f',
  unknown: '#8a8f98',
};

const BUCKET_LABELS = {
  green: 'Healthy',
  orange: 'Renew soon',
  red: 'Action needed',
  unknown: 'Unknown',
};

export function bucketColor(bucket) {
  return BUCKET_COLORS[bucket] || BUCKET_COLORS.unknown;
}

export function bucketLabel(bucket) {
  return BUCKET_LABELS[bucket] || BUCKET_LABELS.unknown;
}

// A specific cert state for the public card. Says what is actually wrong (or
// right) instead of the vague bucket -- "Expired" reads better than "Action
// needed", and "Unreachable" tells the operator the probe itself failed rather
// than the cert being bad. Still no numbers, so the public/admin split holds.
//   unreachable -> the probe could not read a cert (ok:false)
//   expired     -> served cert is past not_after
//   expiring    -> red but not yet expired (<= 14 days)
//   renew_soon  -> orange band (14..30 days)
//   valid       -> green (> 30 days)
//   unknown     -> no not_after / unparseable
export function certState(status, nowIso) {
  if (!status || status.ok === false) return 'unreachable';
  if (!status.not_after) return 'unknown';
  const days = daysRemaining(status.not_after, nowIso);
  if (days === null) return 'unknown';
  if (days < 0) return 'expired';
  const bucket = certBucket(days);
  if (bucket === 'green') return 'valid';
  if (bucket === 'orange') return 'renew_soon';
  return 'expiring';
}

const STATE_LABELS = {
  valid: 'Valid',
  renew_soon: 'Renew soon',
  expiring: 'Expiring soon',
  expired: 'Expired',
  unreachable: 'Unreachable',
  unknown: 'Unknown',
};

// Map each state to the page's dot data-state (green/yellow/red/grey).
const STATE_DOT = {
  valid: 'operational',
  renew_soon: 'degraded',
  expiring: 'down',
  expired: 'down',
  unreachable: 'unknown',
  unknown: 'unknown',
};

export function certStateLabel(state) {
  return STATE_LABELS[state] || STATE_LABELS.unknown;
}

export function certStateDot(state) {
  return STATE_DOT[state] || 'unknown';
}

// State for one cert in the two-cert model (edge / origin). A cert object is
// { not_after, ... } or null/{reachable:false} when the probe could not read
// it. Same bands as certState, just sourced from a sub-object rather than the
// flat status.
export function certStateForCert(cert, nowIso) {
  if (!cert || cert.reachable === false) return 'unreachable';
  if (!cert.not_after) return 'unknown';
  const days = daysRemaining(cert.not_after, nowIso);
  if (days === null) return 'unknown';
  if (days < 0) return 'expired';
  const bucket = certBucket(days);
  if (bucket === 'green') return 'valid';
  if (bucket === 'orange') return 'renew_soon';
  return 'expiring';
}
