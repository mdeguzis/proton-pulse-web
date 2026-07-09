# Changelog

All notable changes to Proton Pulse (web) should be recorded here.

## v1.6.0

- My Library view: deep-linking from the profile "View my games" now lands on a clearly labeled My Library page. Every owned Steam appid appears, not just games that intersect with recent reports (was capped at ~12 to ~65 on real libraries)
- Numbered pagination on the browse grid with Prev/Next arrows, a "Page X of Y" label, and a bottom-of-grid mirror so long lists do not require scrolling back up to turn a page
- Sort dropdown gains A-Z and Z-A options with locale-aware base-sensitivity comparison
- Search input gets a clear (X) button and a placeholder that matches actual behavior (searches all titles, not only visible ones)
- Card tier strip anchors to the card bottom edge so entries with no reports subtitle line up with rated neighbors
- About page report-approval copy corrected: a daily pipeline auto-approves clean reports and admins can approve on demand, edits re-enter the same flow
- Admin analytics "most viewed games" links now work on staging (were hardcoded to the domain root)
- Fix: click handlers on numbered pagination were stacking on every filter change so a click could fire ten times after enough re-renders

## v1.5.0

- Card layout: a new bottom-bar tier strip is the site default, with the store badge sitting next to the rating as a brand-colored pill or round logo (Steam, GOG, Epic). Five placement options for the store badge (right, artwork, card corner, on bar next to rating, on bar split) and a separate text-or-icon display toggle
- Site Options page: defaults are now labeled, a Reset button clears all browser-local preferences, and the signed-in/avatar header now renders correctly on options, privacy, scoring, stats, and terms (the supabase library wasn't being loaded on those pages)
- GOG and Epic store glyphs redrawn so they keep their brand shape (white GOG disc, dark Epic shield) instead of being squashed into a generic circle
- Admin Reports tab adds a "Pending approval" filter and approval-aware status badges: rows in user_configs without a matching `report_approvals` row now show as pending instead of being silently mixed in with "Clean"
- Admin Reports App link goes to the specific report's permalink for approved-and-visible rows; pending, flagged, and hidden rows keep the game-level link since the permalink would 404 there
- Report permalink anchor moved to wrap the whole report block so navigating to `#report-r<id>` lands on the top of the visible report instead of the footer area, with a topbar offset so the report header isn't tucked behind the fixed toolbar
- Framegen signal icon now reads green when not required and red when required, matching how readers interpret "did this game need framegen help?"
- My Reports page no longer shows the same report twice when one row stored `app_id` as a number and another as a string

## v1.4.1

- GOG and Epic game pages now load their data from the correct directory (the pipeline writes `gog_123/` but five frontend call sites were requesting `gog:123/`)
- Favicon shows blue rings on a black square so Google search results no longer render it on a white background
- `make pre-push` is idempotent again: cache-bust hashes the file's stripped content so import cycles in `js/app/` no longer keep `?v=` strings oscillating between runs

## v1.4.0

- Service worker image cache: game cover art is served from the browser cache so the browse grid paints instantly on repeat visits, instead of waiting on dozens of CDN round trips
- Cache-first with stale-while-revalidate gated by a 7-day max-age: covers serve instantly and refresh quietly in the background only when older than a week
- Admin Analytics tab shows an Image cache card with the cache hit rate, images served from cache, misses, and sessions reporting

## v1.3.0

- Browse filter panel widens on desktop and lays the pills out in an aligned grid instead of wrapping unevenly
- Text filter box moved out of the dropdown to sit beside the Filters button; it filters the loaded list (placeholder reads "Filter loaded list")
- Save filters button remembers your full filter set and restores it on your next visit; Clear filters wipes it
- Filter footer: Save and Clear are matching pills, right aligned, with Clear styled as a dark red pill
- Home page filter button now matches the browse page (funnel icon); its store and rating pills are multi-select with an All pill that clears the others
- Home page Rated / Not Rated counts reflect the selected stores (Steam, GOG, Epic), not just Steam
- Unrated game cards show "No Rating" instead of "Pending"
- Reports per page preference (50 / 100 / 150 / 200) added to the site options page; each browse section shows a loaded count like "50 of 132 loaded"
- About page wording cleanup
