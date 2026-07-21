# Changelog

All notable changes to Proton Pulse (web) should be recorded here.

## v1.10.0

- Metadata modal on the game page has a new PCGamingWiki section under Anti-cheat. It shows native OS support (Windows, macOS, Linux, DOS) as chips and the game engine on its own line. Data comes from the PCGamingWiki Cargo API and is refreshed weekly by the pipeline. Games with no PGWiki entry just skip the section. Attribution links back to a PCGamingWiki search for the title (content is CC BY-NC-SA 3.0). Sets up follow-up filter chips and a PGWiki-only store tag under #377.
- Admin API Explorer picked up a PCGamingWiki tab so admins can inspect the raw Cargo response before it lands in the pipeline. Three endpoints: by Steam App ID, by title substring, and cargofields schema introspection for any Cargo table. The tab fetches directly from pcgamingwiki.com (they run CORS open on the API) and skips the edge function.

## v1.9.0

- Submit form drafts got a full UX rework. Autosave now writes only to browser localStorage every 2.5 seconds of pause, so no network chatter while you're typing. The Save button is the explicit trigger for a cloud upload plus commit-and-close: the form saves your work to your account and navigates back to where you came from, matching every other commit-and-close web flow. If cloud is unreachable the manual save falls back to local so the draft survives a network blip. On next visit the load path picks whichever of local or cloud is newer and applies it silently. Runtime Type dropdown now stays inline with its label on mobile.
- Submit form field capture audit. Every named input, radio, select, textarea, and progressive-question state (canInstall / canStart / canPlay / verdict / faults / tinkering methods) round-trips through the draft snapshot. The alsoTestedLinux Yes/No toggle now syncs its pressed-state and notes-visibility when a draft restore sets the hidden input programmatically, fixing a corner where those buttons rendered wrong after a restore.
- Reporter platform detection: Android and iOS added to the platform bucket (getWebSource) via user-agent + touch signals, and iPadOS Safari (which masquerades as Macintosh) is distinguished by navigator.maxTouchPoints. The Submitted-from picker is hidden from the reporter now -- the detected value is stamped on the submission automatically.
- MangoHud CSV upload button spans the row on mobile as a clean single-line action. Autosave posts a first-load toast so the reporter learns their work is being saved to the browser; errors always toast. Hero CTAs settled on a single calm Steam blue.
- Profile page gained a sticky Jump-to-section dropdown right under the topbar (mirrors the Admin panel's tab select but is a scroll-to-anchor since profile sections are all on one page). Every section carries an anchor id, and the Save-report flow now returns to profile.html#section-my-reports so publishing an edit lands on your reports list instead of the top of the page. My Reports action buttons (View / Publish / Edit / Delete) balance equally on mobile, and each row now shows rating and updated-date on the same line.
- Light-mode contrast pass across the topbar, mobile drawer, dropdown panels, search results, and hero CTAs. The header 'PROTON PULSE' logo, hamburger toggle, and menu labels all read cleanly on light backgrounds now.
- Your Data & Privacy rewrite. About page gained a prominent 'Your Data & Privacy' card grid. Privacy policy rewritten end-to-end with a plain-English Steam OpenID 2.0 walkthrough (not OAuth), the exact three profile fields Steam returns, itemized collection, honest deletion behaviour (report anonymization on erasure via admin_erase_user_anonymize), and short hyperlinks to the actual source code. Library and wishlist sync are called out as opt-in-only server calls that only work when the Steam profile visibility is Public.
- Admin: reporter identity rows (client ID + Steam username) show directly under Report ID on the report detail (#285). Status page admin announcements via a new GitHub 'announcement' label with auto-post to Discord (#286).

## v1.8.0

- Site status page (#278): a Cloudflare Worker cron now drives the 15-minute health check instead of the flaky GitHub Actions schedule, and the intro prose says so. The page gained an "Upstream infrastructure" section above the Supabase edge-fn list with two rows: GitHub and Cloudflare. Each row reads only the components Proton Pulse actually depends on (GitHub Pages + Actions; Cloudflare Workers, Workers KV, CDN/Cache, Authoritative DNS), so a Cloudflare Dashboard degradation no longer flips the tile yellow. Clicking a row opens a modal that lists the tracked services with per-component pill state, plus a muted "Other services with issues" tail so a wider vendor incident stays visible without competing for attention.
- Site status polish: jump-to-announcements pill under the overall banner, floating back-to-top button that appears after roughly one viewport of scroll, and Y-axis min/max plus start/mid/now time ticks on the per-service latency sparkline so the graph reads without hovering.
- Admin API Explorer (#280): new ProtonDB tab next to Steam / GOG / Epic. Endpoints are protondb_summary (per-app tier / confidence / total / trending / best and worst reported) and protondb_counts (global sanity). Name lookup reuses the Steam appid index. Field descriptions popup documents both response shapes.
- Fix (#279): the admin "Missing box art (no working source)" filter no longer flags popular Steam games (Team Fortress 2, DayZ, Hearts of Iron IV, and similar) based on a single stray client onerror. Steam entries now require at least three persistent hit reports before the client-side signal overrides the pipeline's CDN probe. GOG and Epic entries still surface on any client error because there is no pipeline probe for those catalogs yet.
- Fix: the vendor tile modal now opens for Cloudflare, not just GitHub. The tile embeds its payload in a single-quoted data-vendor attribute, and Cloudflare ships a component named "Developer's Site" whose apostrophe terminated the attribute early and made JSON.parse fail silently. The HTML escape now handles apostrophes too, and the parse-fail log is a console warning with a payload preview so a future silent break is loud.

## v1.7.1

- Fix: game confidence scoring now punishes very old reports properly. Two 8-year-old reports of the same rating used to display as 48% confidence because tier consistency stayed high while freshness only nudged the score. The new freshness curve drops sharply past 1 year, and a staleness cap based on median report age hard-caps the overall confidence when the community data is stale. The confidence breakdown adds a "Staleness cap" row that names the median age in years.
- Per-report score breakdown now includes negative point tiers at 1yr / 2yr / 3-5yr / 5-8yr / 8yr+ instead of the flat -5 for "old", and each recency detail shows the human-readable age (e.g. "2877 days old (7.9 years, ~5-8yr old)").
- Box art manager: replaced the three top buttons with an Actions dropdown, added a "Set first SGDB result (filtered)" batch action, added a per-detail "Take first SGDB result" quick action, kept filter state in the URL so back-from-detail and refresh preserve the search, and stacked the SteamGridDB artwork panel above the details on mobile so it is no longer hidden below empty space.
- Hide-game finally works end-to-end: game_hides now blocks the game detail page (bail early with a "Game hidden" state) and filters hidden appids out of the home Recent and Popular sections.
- At-a-glance chart: Steam Machine and SteamOS views show an explanatory empty state instead of an all-unsupported bar until the pipeline populates the new Machine/SteamOS keys.

## v1.7.0

- New icon set across the site: accurate Steam Deck / Controller / Machine / Frame marks, SteamOS and Verified signage, and Steam / GOG / Epic store app-icons. Saved as SVG and PNG assets at multiple sizes under assets/icons with regenerate scripts.
- At-a-glance chart: the Steam Deck chip uses the real Deck mark, the colored labels stay on one line at a uniform width (no more clipped "Unsupported"), the view chips are larger, and the panel padding is tighter.
- Browse card ownership badges: library is now a clean 2x2 collection grid and wishlist is a wrapped present, both without the old white halo. A "Store tag icon size" setting in Site Options lets you nudge the corner icon size (10 to 28px).
- Filter popover: on desktop it stretches to the content width and flows the groups into balanced masonry columns with squircle chips, so it fills evenly and the Save / Clear footer stays above the fold.
- About page: a new Icons and Signage section (icon left, meaning right) documents every badge and mark, reachable from a quicklinks row that also jumps to Compare and Mission.
- App type (mod / DLC / software) no longer overlays the browse tile. It now shows as a tag under the artwork on the game detail page.
- Steam Machine and SteamOS compatibility (#273): the same Steam endpoint that gives Deck verdicts also returns Machine and SteamOS. The pipeline now stores all three. The at-a-glance chart gains Steam Machine and SteamOS chips, and the browse filters gain Machine and SteamOS groups. The game detail page's compatibility button now opens a three-tab modal (Deck / Machine / SteamOS) like Valve's own. The report device fingerprint recognizes Steam Machine (provisional until real hardware strings land). Populating the new Machine/SteamOS data needs a full pipeline run.

## v1.6.2

- Fix: game page box art fills the full left column width at its native aspect ratio and top-aligns with the rating panel. Rolls back the 240px cap and `object-fit: contain` from v1.6.1, which shrank Steam-standard headers and left extra whitespace next to the panel.

## v1.6.1

- Fix: game page box art no longer upscales past its native resolution or fills the full rating-panel height. `object-fit: contain` with a 240px cap preserves the aspect ratio without cropping. Follow-up to v1.6.0's aspect fix; the earlier change had left admin-uploaded overrides rendering blurry on wide viewports.

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
