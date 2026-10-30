// Signed writes for this browser's anonymous web client (#62).
//
// The browser keeps an ECDSA P-256 key pair in IndexedDB. The private key
// is generated with extractable = false, so page scripts can sign with it
// but can never read or export it. Each write is a JSON payload signed with
// that key and sent to the client-write edge function, which checks the
// signature against the public key it stored on first use. The public key
// is sent with every request; the server only uses it to register.

const DB_NAME = 'proton-pulse-keys';
const STORE = 'keys';
const KEY_ID = 'web-client';
const LAST_TS_KEY = 'proton-pulse:web-client-last-ts';

let keyPairPromise = null;
let writeChain = Promise.resolve();

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function openKeyStore() {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  return idbRequest(open);
}

async function loadOrCreateKeyPair() {
  const db = await openKeyStore();
  const existing = await idbRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY_ID));
  if (existing?.privateKey && existing?.publicJwk) return existing;

  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, // private key is non-extractable; the public key is always exportable
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const record = { privateKey: pair.privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
  await idbRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).put(record, KEY_ID));
  return record;
}

/**
 * The browser's signing key pair, created on first use.
 * @returns {Promise<{privateKey: CryptoKey, publicJwk: {kty: string, crv: string, x: string, y: string}}>}
 */
export function getClientKeyPair() {
  if (!keyPairPromise) {
    keyPairPromise = loadOrCreateKeyPair().catch((err) => {
      keyPairPromise = null; // let the next write retry
      throw err;
    });
  }
  return keyPairPromise;
}

// Strictly increasing request timestamp (ms). The server rejects any ts not
// newer than the last one it accepted for this client, which blocks replays.
function nextTimestamp() {
  let last = 0;
  try { last = Number(localStorage.getItem(LAST_TS_KEY)) || 0; } catch { /* storage blocked */ }
  const ts = Math.max(Date.now(), last + 1);
  try { localStorage.setItem(LAST_TS_KEY, String(ts)); } catch { /* storage blocked */ }
  return ts;
}

export function bytesToBase64Url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendSignedWrite(sbUrl, sbKey, clientId, action, args) {
  const { privateKey, publicJwk } = await getClientKeyPair();
  const payload = JSON.stringify({ action, clientId, ts: nextTimestamp(), args });
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(payload),
  );
  const base = sbUrl.replace(/\/rest\/v1\/?$/, '');
  const r = await fetch(`${base}/functions/v1/client-write`, {
    method: 'POST',
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, signature: bytesToBase64Url(signature), publicKey: publicJwk }),
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty or non-JSON body */ }
  return { ok: r.ok, status: r.status, data };
}

/**
 * Sign and send one write as this browser's web client. Writes are sent one
 * at a time so their timestamps reach the server in order.
 * @param {string} sbUrl PostgREST base (".../rest/v1"); the functions URL is derived from it.
 * @param {string} sbKey anon key.
 * @param {string} clientId this browser's web client id.
 * @param {'cast_vote'|'delete_cloud_config'} action
 * @param {object} args action arguments (see supabase/functions/_shared/clientWrite.js).
 * @returns {Promise<{ok: boolean, status: number, data: object|null}>}
 */
export function clientWrite(sbUrl, sbKey, clientId, action, args) {
  const run = writeChain.then(() => sendSignedWrite(sbUrl, sbKey, clientId, action, args));
  writeChain = run.catch(() => {});
  return run;
}
