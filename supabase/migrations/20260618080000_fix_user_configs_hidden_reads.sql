-- Make is_hidden actually hide rows, and drop redundant moderation policies.
--
-- user_configs had two leftover SELECT policies, `public read` and
-- `public read configs`, both USING (true). Because RLS policies are ORed, they
-- exposed every row regardless of is_hidden, so shadow ban and the banned-user
-- hiding trigger (which both rely on is_hidden) never actually hid anything.
-- Drop them; `public read non-hidden configs` (is_hidden = false OR owner) plus
-- `moderators read all configs` are the correct read policies.
--
-- Also drop the duplicate write policies added in 20260618070000. The
-- pre-existing `manage_reports update configs` and `delete_reports delete
-- configs` already scope writes to the right permissions.

DROP POLICY IF EXISTS "public read" ON public.user_configs;
DROP POLICY IF EXISTS "public read configs" ON public.user_configs;
DROP POLICY IF EXISTS "moderators update configs" ON public.user_configs;
DROP POLICY IF EXISTS "moderators delete configs" ON public.user_configs;
