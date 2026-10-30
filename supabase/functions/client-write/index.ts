// client-write: signed writes from the web site's anonymous client (#62).
//
// verify_jwt = false (config.toml): the caller is an anonymous browser with
// no Supabase session. Instead each request is signed by the browser's
// non-extractable ECDSA P-256 key (js/shared/client-key.js) and checked
// against the public key stored for that client id. Rate limited per IP.
//
// Flow:
//   1. parseSignedRequest validates the body and the signed payload
//      (action allowlist, client id format, timestamp within 5 minutes,
//      per-action argument checks).
//   2. client_web_key returns the stored public key, registering the one in
//      the request on first use when the id is free.
//   3. The signature is verified against the STORED key.
//   4. client_web_write rejects stale or replayed timestamps, refuses banned
//      clients, and performs the write.
// Error responses never echo the request body.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getClientIp, isRateLimited, rateLimitResponse } from "../_shared/rateLimit.ts";
import { ClientWriteError, parseSignedRequest, verifySignature } from "../_shared/clientWrite.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RATE_LIMIT = 60;

// Postgres error codes raised by client_web_key / client_web_write.
function statusForDbError(code: string | undefined): number {
  if (code === "42501") return 403;
  if (code === "22023" || code === "22P02") return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405, headers: corsHeaders });
  }

  const ip = getClientIp(req);
  if (isRateLimited("client-write", ip, RATE_LIMIT)) return rateLimitResponse(corsHeaders);

  let request;
  try {
    request = parseSignedRequest(await req.json());
  } catch (err) {
    const status = err instanceof ClientWriteError ? err.status : 400;
    const message = err instanceof ClientWriteError ? err.message : "body is not JSON";
    console.warn("[client-write] rejected request", { status, reason: message });
    return Response.json({ error: message }, { status, headers: corsHeaders });
  }
  const { action, clientId, ts, args, payload, signature, publicKey } = request;
  const idPrefix = clientId.slice(0, 8);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: storedKey, error: keyError } = await supabase.rpc("client_web_key", {
    p_client_id: clientId,
    p_public_key: publicKey,
  });
  if (keyError || !storedKey) {
    const status = statusForDbError(keyError?.code);
    console.warn("[client-write] key lookup failed", { idPrefix, action, status, code: keyError?.code, message: keyError?.message });
    return Response.json({ error: status === 500 ? "key lookup failed" : keyError?.message }, { status, headers: corsHeaders });
  }

  let valid = false;
  try {
    valid = await verifySignature(storedKey, payload, signature);
  } catch (err) {
    console.warn("[client-write] signature check threw", { idPrefix, action, error: String(err) });
  }
  if (!valid) {
    console.warn("[client-write] bad signature", { idPrefix, action });
    return Response.json({ error: "signature does not match this client's key" }, { status: 401, headers: corsHeaders });
  }

  const { data, error } = await supabase.rpc("client_web_write", {
    p_client_id: clientId,
    p_ts: ts,
    p_action: action,
    p_args: args,
  });
  if (error) {
    const status = statusForDbError(error.code);
    console.warn("[client-write] write refused", { idPrefix, action, status, code: error.code, message: error.message });
    return Response.json({ error: status === 500 ? "write failed" : error.message }, { status, headers: corsHeaders });
  }

  console.log("[client-write] ok", { idPrefix, action, source: "rpc/client_web_write" });
  return Response.json(data ?? { ok: true }, { headers: corsHeaders });
});
