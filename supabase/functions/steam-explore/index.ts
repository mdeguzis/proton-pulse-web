// steam-explore: admin API Explorer proxy (issue #186).
//
// The stores' public endpoints are not CORS-enabled, so the admin panel cannot
// call them from the browser. This function fetches a whitelisted endpoint
// server-side and returns the raw JSON, for manual debugging of Steam / GOG /
// Epic game data. Read-only, whitelisted. verify_jwt=false -- it exposes
// nothing beyond the public store responses.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EPIC_SEARCH_QUERY = `query searchStoreQuery($keywords: String!, $country: String!, $locale: String!) {
  Catalog {
    searchStore(keywords: $keywords, country: $country, locale: $locale, count: 20) {
      elements { title id namespace productSlug urlSlug offerType releaseDate
        keyImages { type url } categories { path } price(country: $country) { totalPrice { discountPrice originalPrice } } }
    }
  }
}`;

type EndpointDef = {
  // Whether the endpoint takes a numeric id or a free-text term.
  arg: "id" | "term";
  method: "GET" | "POST";
  url: (arg: string) => string;
  headers?: Record<string, string>;
  body?: (arg: string) => string;
};

// key = "<store>_<endpoint>". Keep in sync with the admin component.
const ENDPOINTS: Record<string, EndpointDef> = {
  steam_appdetails: {
    arg: "id",
    method: "GET",
    url: (id) => `https://store.steampowered.com/api/appdetails?appids=${id}`,
  },
  steam_deck: {
    arg: "id",
    method: "GET",
    url: (id) => `https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${id}`,
  },
  gog_product: {
    arg: "id",
    method: "GET",
    url: (id) => `https://api.gog.com/products/${id}?expand=description,screenshots,videos,rating`,
  },
  gog_search: {
    arg: "term",
    method: "GET",
    url: (t) =>
      `https://catalog.gog.com/v1/catalog?query=${encodeURIComponent(t)}&limit=20&locale=en-US&currencyCode=USD&countryCode=US`,
  },
  epic_search: {
    arg: "term",
    method: "POST",
    url: () => "https://store.epicgames.com/graphql",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://store.epicgames.com",
      Referer: "https://store.epicgames.com/en-US/browse",
    },
    body: (t) =>
      JSON.stringify({
        query: EPIC_SEARCH_QUERY,
        variables: { keywords: t, country: "US", locale: "en-US" },
      }),
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "POST only" }, { status: 405, headers: corsHeaders });
  }

  let body: { endpoint?: string; app_id?: string; id?: string; term?: string } | null = null;
  try { body = await req.json(); } catch { /* fall through */ }
  const endpoint = String(body?.endpoint ?? "").trim();
  // app_id kept for backward compatibility with the original steam-only client.
  const id = String(body?.id ?? body?.app_id ?? "").trim();
  const term = String(body?.term ?? "").trim();

  const def = ENDPOINTS[endpoint];
  if (!def) {
    return Response.json(
      { ok: false, error: `unknown endpoint "${endpoint}" (allowed: ${Object.keys(ENDPOINTS).join(", ")})` },
      { status: 400, headers: corsHeaders },
    );
  }

  let arg: string;
  if (def.arg === "id") {
    if (!/^\d+$/.test(id)) {
      return Response.json({ ok: false, error: "id must be numeric for this endpoint" }, { status: 400, headers: corsHeaders });
    }
    arg = id;
  } else {
    if (!term) {
      return Response.json({ ok: false, error: "term is required for this endpoint" }, { status: 400, headers: corsHeaders });
    }
    arg = term;
  }

  const url = def.url(arg);
  try {
    const init: RequestInit = { method: def.method, headers: def.headers ?? { Accept: "application/json" } };
    if (def.method === "POST" && def.body) init.body = def.body(arg);
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    console.log(`[steam-explore] endpoint=${endpoint} arg=${arg} status=${upstream.status}`);
    return Response.json(
      { ok: upstream.ok, endpoint, arg, url, status: upstream.status, data },
      { status: 200, headers: corsHeaders },
    );
  } catch (e) {
    return Response.json(
      { ok: false, endpoint, arg, url, error: `fetch failed: ${(e as Error).message}` },
      { status: 200, headers: corsHeaders },
    );
  }
});
