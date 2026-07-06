-- Cloud-synced report drafts, so a half-finished report on one device can be
-- resumed on another (#199 follow-up). Row per (user, appId). Cleared after a
-- successful submit. Distinct from user_configs so drafts don't have to satisfy
-- the schema's not-null / check constraints while the user is still filling
-- them in.

create table if not exists public.user_report_drafts (
  user_id    uuid not null references auth.users(id) on delete cascade,
  app_id     text not null,
  form_data  jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, app_id)
);

create index if not exists user_report_drafts_updated_idx
  on public.user_report_drafts (user_id, updated_at desc);

alter table public.user_report_drafts enable row level security;

drop policy if exists "user_report_drafts_select_own" on public.user_report_drafts;
create policy "user_report_drafts_select_own"
  on public.user_report_drafts for select
  using (auth.uid() = user_id);

drop policy if exists "user_report_drafts_insert_own" on public.user_report_drafts;
create policy "user_report_drafts_insert_own"
  on public.user_report_drafts for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_report_drafts_update_own" on public.user_report_drafts;
create policy "user_report_drafts_update_own"
  on public.user_report_drafts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_report_drafts_delete_own" on public.user_report_drafts;
create policy "user_report_drafts_delete_own"
  on public.user_report_drafts for delete
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.user_report_drafts to authenticated;
