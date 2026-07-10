-- user_steam_wishlist: caches the signed-in user's Steam wishlist so the home
-- filter panel can show "reports for games I actually want to buy next" (#266
-- Phase 1). Mirrors user_steam_library: single row per user, upserted every
-- time the sync-steam-wishlist edge function runs.
--
-- GDPR: this table stores user-linked data. Any user erase path (admin_erase_user)
-- must delete rows here too. Follow the same pattern as user_steam_library.

CREATE TABLE IF NOT EXISTS public.user_steam_wishlist (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    steam_id TEXT NOT NULL,
    -- Total items in the wishlist as reported by Steam. Stored separately from
    -- the appids array because Steam may return a subset if the user's list is
    -- private but their profile grants friend-visibility.
    item_count INTEGER NOT NULL DEFAULT 0,
    -- Ordered list of Steam appids the user has wishlisted. Order preserved
    -- so the frontend can honor Steam's own priority sort.
    appids INTEGER[] NOT NULL DEFAULT '{}',
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_steam_wishlist_steam_id
    ON public.user_steam_wishlist (steam_id);

ALTER TABLE public.user_steam_wishlist ENABLE ROW LEVEL SECURITY;

-- Read: each user can see their own row.
DROP POLICY IF EXISTS wishlist_owner_select ON public.user_steam_wishlist;
CREATE POLICY wishlist_owner_select ON public.user_steam_wishlist
    FOR SELECT
    USING (auth.uid() = user_id);

-- Write: no direct client writes. The edge function uses the service role
-- to upsert, so no policy for INSERT / UPDATE from clients.
-- Delete: owner-only (used by the admin erase-user path via service role too).
DROP POLICY IF EXISTS wishlist_owner_delete ON public.user_steam_wishlist;
CREATE POLICY wishlist_owner_delete ON public.user_steam_wishlist
    FOR DELETE
    USING (auth.uid() = user_id);

COMMENT ON TABLE public.user_steam_wishlist IS
    'Cached Steam wishlist for the signed-in user. Populated by the '
    'sync-steam-wishlist edge function; drives the Wishlist filter chip (#266).';
