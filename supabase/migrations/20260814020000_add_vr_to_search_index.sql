-- #246: VR capability on the search index so users can filter for or against
-- VR titles.
--
-- Values: null (not VR / unknown), 'supported' (playable flat or in VR),
-- 'only' (VR required). Sourced in finalize.py from Steam appdetails
-- `categories` (VR Supported / VR Only), cross-checked against the VRDB
-- catalog (github.com/Respuit/VRDB) which tracks VR titles whose VR mode
-- ships as a separate branch or free DLC and so carries no Steam category.
--
-- Deliberately not a boolean: "VR only" is the case a flatscreen player most
-- wants to filter OUT, and collapsing it into "supported" loses that.

alter table public.search_index
  add column if not exists vr text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'search_index_vr_chk'
  ) then
    alter table public.search_index
      add constraint search_index_vr_chk check (
        vr is null or vr in ('supported', 'only')
      );
  end if;
end $$;

-- Partial index matching the other filter-chain indexes on this table: VR
-- titles are a small slice of the catalog and every query that cares about
-- them narrows to non-null first.
create index if not exists search_index_vr_idx
  on public.search_index (vr)
  where vr is not null;
