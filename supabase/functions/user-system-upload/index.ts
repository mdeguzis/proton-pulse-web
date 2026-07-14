import { createServiceClient } from "../_shared/auth.ts";

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

// Thrown for any bad input so the handler can map it to HTTP 400 instead of 500.
class ValidationError extends Error {}

function requireString(value: unknown, name: string): string {
  if (!value || typeof value !== "string") throw new ValidationError(`${name} is required`);
  return value;
}

// Field validation mirrors the user_systems CHECK constraints
// (20260712170000_user_systems_field_validation.sql). The DB is the
// authoritative gate; this just returns a clearer 400 to the plugin.
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]+$/;
// Control chars other than tab (09), newline (0A), carriage return (0D).
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const MAX_SYSINFO_LEN = 16384;
const MAX_DEVICE_ID_LEN = 128;

function validateDeviceId(deviceId: string): string {
  if (deviceId.length > MAX_DEVICE_ID_LEN || !DEVICE_ID_RE.test(deviceId)) {
    throw new ValidationError("deviceId is invalid");
  }
  return deviceId;
}

function validateSysinfoText(sysinfoText: string): string {
  if (sysinfoText.length > MAX_SYSINFO_LEN) {
    throw new ValidationError("sysinfoText is too long");
  }
  if (CONTROL_CHARS_RE.test(sysinfoText)) {
    throw new ValidationError("sysinfoText contains invalid control characters");
  }
  return sysinfoText;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const parts = ["message", "error", "details", "hint", "code"]
      .map((key) => {
        const value = (error as Record<string, unknown>)[key];
        return typeof value === "string" && value.trim() ? `${key}: ${value}` : null;
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join("; ");

    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createServiceClient();

  try {
    const body = await req.json();
    const installationId = requireString(body.installationId, "installationId");
    const installationSecret = requireString(body.installationSecret, "installationSecret");
    const deviceId = validateDeviceId(requireString(body.deviceId, "deviceId"));
    const sysinfoText = validateSysinfoText(requireString(body.sysinfoText, "sysinfoText"));
    const label = typeof body.label === "string" && body.label.trim()
      ? body.label.trim().slice(0, 160)
      : "Uploaded system";

    const installationSecretHash = await hashInstallationSecret(installationSecret);
    const { data: link, error: linkError } = await supabase
      .from("plugin_links")
      .select("installation_id, installation_secret_hash, linked_user_id")
      .eq("installation_id", installationId)
      .maybeSingle();
    if (linkError) throw linkError;
    if (!link?.linked_user_id) {
      return Response.json({ error: "Installation is not linked" }, { status: 403, headers: corsHeaders });
    }
    if (link.installation_secret_hash && link.installation_secret_hash !== installationSecretHash) {
      return Response.json({ error: "Installation proof mismatch" }, { status: 403, headers: corsHeaders });
    }

    const now = new Date().toISOString();
    await supabase
      .from("plugin_links")
      .update({
        last_seen_at: now,
        installation_secret_hash: link.installation_secret_hash ?? installationSecretHash,
      })
      .eq("installation_id", installationId);

    const { data: existing, error: existingError } = await supabase
      .from("user_systems")
      .select("device_id")
      .eq("proton_pulse_user_id", link.linked_user_id)
      .eq("device_id", deviceId)
      .maybeSingle();
    if (existingError) throw existingError;

    const { count, error: countError } = await supabase
      .from("user_systems")
      .select("device_id", { count: "exact", head: true })
      .eq("proton_pulse_user_id", link.linked_user_id);
    if (countError) throw countError;

    const inserted = !existing;
    const isDefault = inserted && (count ?? 0) === 0;
    const { error: upsertError } = await supabase
      .from("user_systems")
      .upsert({
        proton_pulse_user_id: link.linked_user_id,
        installation_id: installationId,
        device_id: deviceId,
        label,
        sysinfo_text: sysinfoText,
        is_default: isDefault,
        updated_at: now,
      }, { onConflict: "proton_pulse_user_id,device_id" });
    if (upsertError) throw upsertError;

    return Response.json({ ok: true, inserted, isDefault }, { headers: corsHeaders });
  } catch (error) {
    const message = formatUnknownError(error);
    const status = error instanceof ValidationError ? 400 : 500;
    return Response.json({ error: message }, { status, headers: corsHeaders });
  }
});
