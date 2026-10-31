// Request checks for the client-write edge function (#62).
//
// Plain JS with no Deno APIs so the edge function and Jest both import it.
// The browser signs the exact `payload` string with a non-extractable ECDSA
// P-256 key (js/shared/client-key.js). The server parses and validates the
// payload, then verifies the signature against the public key it stored
// when the client first registered (client_web_key), never against the key
// the request carries.

export const ACTIONS = new Set(['cast_vote', 'delete_cloud_config']);
export const MAX_SKEW_MS = 5 * 60 * 1000;
export const MAX_PAYLOAD_CHARS = 2048;
const CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const APP_ID_RE = /^\d{1,12}$/;
const B64URL_RE = /^[A-Za-z0-9_-]{40,200}$/;

export class ClientWriteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bad(message) {
  return new ClientWriteError(400, message);
}

function checkArgs(action, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw bad('args must be an object');
  if (action === 'cast_vote') {
    if (typeof args.app_id !== 'string' || !APP_ID_RE.test(args.app_id)) throw bad('app_id must be a numeric string');
    if (typeof args.report_key !== 'string' || args.report_key.length < 1 || args.report_key.length > 200) {
      throw bad('report_key must be 1-200 characters');
    }
    if (![-1, 0, 1].includes(args.vote)) throw bad('vote must be -1, 0 or 1');
    return { app_id: args.app_id, report_key: args.report_key, vote: args.vote };
  }
  // delete_cloud_config
  if (typeof args.app_id !== 'string' || !APP_ID_RE.test(args.app_id)) throw bad('app_id must be a numeric string');
  if (args.profile_name != null && (typeof args.profile_name !== 'string' || args.profile_name.length > 100)) {
    throw bad('profile_name must be a string of at most 100 characters');
  }
  return { app_id: args.app_id, profile_name: args.profile_name ?? null };
}

// Validates the request body. Returns the parsed request or throws
// ClientWriteError(400). `now` is injectable for tests.
export function parseSignedRequest(body, now = Date.now()) {
  if (!body || typeof body !== 'object') throw bad('body must be a JSON object');
  const { payload, signature, publicKey } = body;
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_PAYLOAD_CHARS) {
    throw bad('payload must be a non-empty string');
  }
  if (typeof signature !== 'string' || !B64URL_RE.test(signature)) throw bad('signature must be base64url');
  if (publicKey != null && (typeof publicKey !== 'object' || Array.isArray(publicKey))) {
    throw bad('publicKey must be a JWK object');
  }

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw bad('payload is not JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw bad('payload must be an object');
  const { action, clientId, ts } = parsed;
  if (!ACTIONS.has(action)) throw bad('unknown action');
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) throw bad('invalid client id');
  if (!Number.isSafeInteger(ts) || ts <= 0) throw bad('ts must be a positive integer');
  if (Math.abs(now - ts) > MAX_SKEW_MS) throw bad('ts is too far from server time');

  return {
    action,
    clientId,
    ts,
    args: checkArgs(action, parsed.args),
    payload,
    signature,
    publicKey: publicKey ?? null,
  };
}

export function base64UrlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// True when `signature` (base64url, IEEE P1363 r||s as WebCrypto produces)
// is a valid ECDSA P-256 / SHA-256 signature of `payload` under publicJwk.
export async function verifySignature(publicJwk, payload, signature, subtle = globalThis.crypto.subtle) {
  if (!publicJwk || publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256') return false;
  const key = await subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    base64UrlToBytes(signature),
    new TextEncoder().encode(payload),
  );
}
