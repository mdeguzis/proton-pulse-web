-- Allow authenticated users to delete their own author_avatars row.
-- Required so the show_username toggle can remove the row when disabled.

grant delete on table public.author_avatars to authenticated;

create policy "users delete own avatar"
  on public.author_avatars for delete
  to authenticated
  using (proton_pulse_user_id = auth.uid());
