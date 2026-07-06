-- Anonymous client-side box-art error reports so the admin Box Art Manager can
-- surface games whose header image 404s at runtime, across any storefront
-- (Steam, GOG, Epic) (#199 follow-up). Complements the pipeline's Steam-only
-- game-images-cache.json which never catches non-Steam 404s.
--
-- Rows are upserted by the anon key from the frontend after the fallback
-- chain in steam-img.js gives up. Only app_id + last_seen churn frequently;
-- first_seen and count let admins spot new-vs-persistent issues.

create table if not exists public.image_load_errors (
  app_id     text primary key,
  store_type text not null default 'steam',
  attempted_url text,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  hit_count  integer not null default 1
);

create index if not exists image_load_errors_last_seen_idx
  on public.image_load_errors (last_seen desc);
create index if not exists image_load_errors_store_type_idx
  on public.image_load_errors (store_type);

alter table public.image_load_errors enable row level security;

drop policy if exists "image_load_errors_public_read" on public.image_load_errors;
create policy "image_load_errors_public_read"
  on public.image_load_errors for select
  using (true);

drop policy if exists "image_load_errors_anon_insert" on public.image_load_errors;
create policy "image_load_errors_anon_insert"
  on public.image_load_errors for insert
  with check (true);

drop policy if exists "image_load_errors_anon_update" on public.image_load_errors;
create policy "image_load_errors_anon_update"
  on public.image_load_errors for update
  using (true)
  with check (true);

grant select, insert, update on public.image_load_errors to anon, authenticated;

-- Bump hit_count + last_seen when the same app_id is reported again by a
-- separate visitor; keep first_seen frozen so admins can see how long the
-- 404 has been in the wild.
create or replace function public.image_load_errors_bump_on_conflict()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.hit_count := coalesce(old.hit_count, 0) + 1;
  new.first_seen := coalesce(old.first_seen, now());
  new.last_seen := now();
  return new;
end;
$$;
