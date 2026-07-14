import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Per-isolate rate limiter: 10 requests per IP per 60 seconds
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function hashInstallationSecret(secret: string) {
  const bytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makeLinkCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(clientIp)) {
    return Response.json({ error: "Too many requests" }, { status: 429, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { installationId, installationSecret } = await req.json();
    if (!installationId || typeof installationId !== "string") {
      return Response.json({ error: "installationId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!installationSecret || typeof installationSecret !== "string") {
      return Response.json({ error: "installationSecret is required" }, { status: 400, headers: corsHeaders });
    }

    const now = new Date().toISOString();
    const installationSecretHash = await hashInstallationSecret(installationSecret);
    const { data: existing, error: readError } = await supabase
      .from("plugin_links")
      .select("installation_id, linked_user_id, linked_at, installation_secret_hash")
      .eq("installation_id", installationId)
      .maybeSingle();

    if (readError) throw readError;
    if (existing?.installation_secret_hash && existing.installation_secret_hash !== installationSecretHash) {
      return Response.json({ error: "Installation proof mismatch" }, { status: 403, headers: corsHeaders });
    }

    if (existing?.linked_user_id) {
      await supabase
        .from("plugin_links")
        .update({
          last_seen_at: now,
          installation_secret_hash: existing.installation_secret_hash ?? installationSecretHash,
        })
        .eq("installation_id", installationId);
      return Response.json({
        installationId,
        linked: true,
        linkedUserId: existing.linked_user_id,
        linkedAt: existing.linked_at,
        linkCode: null,
        linkCodeExpiresAt: null,
      }, { headers: corsHeaders });
    }

    const linkCode = makeLinkCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const { error: upsertError } = await supabase
      .from("plugin_links")
      .upsert({
        installation_id: installationId,
        installation_secret_hash: installationSecretHash,
        link_code: linkCode,
        link_code_expires_at: expiresAt,
        last_seen_at: now,
      }, { onConflict: "installation_id" });
    if (upsertError) throw upsertError;

    return Response.json({
      installationId,
      linked: false,
      linkedUserId: null,
      linkedAt: null,
      linkCode,
      linkCodeExpiresAt: expiresAt,
    }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500, headers: corsHeaders });
  }
});
