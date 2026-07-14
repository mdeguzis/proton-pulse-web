// Create a status-page announcement from the admin panel (#286 phase 2).
//
// Files a GitHub issue labeled "announcement" (+ optional extra labels) in the
// proton-pulse-web repo, using the GITHUB_ANNOUNCE_TOKEN secret. The issue shows
// on the status page (title + markdown body) and, once the workflow is on main,
// auto-posts to Discord. Only a super_admin may call this: the browser can never
// hold a GitHub token, so this server-side function is the only writer.

import { createServiceClient, requireRequestUser } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REPO = "mdeguzis/proton-pulse-web";
// Labels the composer may add alongside the always-on "announcement" label.
const ALLOWED_EXTRA_LABELS = new Set(["bug", "incident", "enhancement"]);
const MAX_TITLE = 200;
const MAX_BODY = 10000;

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: corsHeaders });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // 1. Caller must be authenticated.
    const { user, error: authErr } = await requireRequestUser(req);
    if (!user) return json({ error: authErr || "Authentication required" }, 401);

    // 2. Caller must be a super_admin. Checked with the service client so RLS
    //    on the admins table cannot hide the row.
    const svc = createServiceClient();
    const { data: adminRow, error: adminErr } = await svc
      .from("admins")
      .select("role")
      .eq("proton_pulse_user_id", user.id)
      .maybeSingle();
    if (adminErr) throw adminErr;
    if (!adminRow || adminRow.role !== "super_admin") {
      console.warn("create-announcement: non-super-admin blocked", { userId: user.id, role: adminRow?.role ?? null });
      return json({ error: "super_admin required" }, 403);
    }

    // 3. Validate the payload.
    const body = await req.json().catch(() => ({}));
    const title = String(body?.title ?? "").trim();
    const markdown = String(body?.body ?? "").trim();
    if (!title) return json({ error: "title is required" }, 400);
    if (title.length > MAX_TITLE) return json({ error: `title exceeds ${MAX_TITLE} characters` }, 400);
    if (markdown.length > MAX_BODY) return json({ error: `body exceeds ${MAX_BODY} characters` }, 400);

    const extra = Array.isArray(body?.labels)
      ? [...new Set(body.labels.filter((l: unknown) => typeof l === "string" && ALLOWED_EXTRA_LABELS.has(l)))]
      : [];
    const labels = ["announcement", ...extra];

    // 4. Create the GitHub issue.
    const ghToken = Deno.env.get("GITHUB_ANNOUNCE_TOKEN");
    if (!ghToken) {
      console.error("create-announcement: GITHUB_ANNOUNCE_TOKEN not set");
      return json({ error: "server not configured for announcements" }, 500);
    }

    const ghRes = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "proton-pulse-announce",
      },
      body: JSON.stringify({ title, body: markdown, labels }),
    });

    if (!ghRes.ok) {
      const detail = (await ghRes.text().catch(() => "")).slice(0, 300);
      console.error("create-announcement: GitHub issue create failed", { status: ghRes.status, detail });
      return json({ error: `GitHub issue creation failed (${ghRes.status})` }, 502);
    }

    const issue = await ghRes.json();
    console.info("create-announcement: created", { number: issue.number, by: user.id, labels });
    return json({ ok: true, number: issue.number, html_url: issue.html_url });
  } catch (e) {
    console.error("create-announcement: unexpected", { error: String(e) });
    return json({ error: "Unexpected error creating announcement" }, 500);
  }
});
