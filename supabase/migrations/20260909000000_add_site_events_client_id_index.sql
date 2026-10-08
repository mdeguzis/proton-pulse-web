-- #34: fetchUserActivity now queries site_events by client_id for anonymous
-- users (previously only proton_pulse_user_id was ever requested), and the
-- table has an index on (proton_pulse_user_id, created_at desc) but nothing
-- on client_id -- that lookup would otherwise be a sequential scan.

create index if not exists site_events_client_created_at_idx
  on public.site_events (client_id, created_at desc);
