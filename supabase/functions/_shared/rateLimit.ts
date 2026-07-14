// Per-isolate IP rate limiter for edge functions.
// Not globally distributed (each Deno isolate has its own map) but still
// prevents single-source burst abuse which is the main threat vector.

const maps = new Map<string, Map<string, { count: number; resetAt: number }>>();

export function isRateLimited(
  bucket: string,
  ip: string,
  limit = 30,
  windowMs = 60_000,
): boolean {
  if (!maps.has(bucket)) maps.set(bucket, new Map());
  const map = maps.get(bucket)!;
  const now = Date.now();
  const entry = map.get(ip);
  if (!entry || now > entry.resetAt) {
    map.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > limit;
}

export function getClientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function rateLimitResponse(corsHeaders: Record<string, string>) {
  return Response.json(
    { error: "Too many requests. Please try again later." },
    { status: 429, headers: corsHeaders },
  );
}
