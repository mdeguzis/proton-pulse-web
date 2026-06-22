-- Fix claimed_client_ids RLS policies that referenced user_metadata (user-editable).
-- Replace with a lookup through author_avatars (keyed by auth.uid(), not user-controlled).

drop policy if exists "users can read own links" on claimed_client_ids;
drop policy if exists "users can insert own links" on claimed_client_ids;
drop policy if exists "users can delete own links" on claimed_client_ids;

create policy "users can read own links"
  on claimed_client_ids
  for select
  to authenticated
  using (
    steam_id = (
      select steam_id from author_avatars
      where proton_pulse_user_id = auth.uid()
    )
  );

create policy "users can insert own links"
  on claimed_client_ids
  for insert
  to authenticated
  with check (
    steam_id = (
      select steam_id from author_avatars
      where proton_pulse_user_id = auth.uid()
    )
  );

create policy "users can delete own links"
  on claimed_client_ids
  for delete
  to authenticated
  using (
    steam_id = (
      select steam_id from author_avatars
      where proton_pulse_user_id = auth.uid()
    )
  );
