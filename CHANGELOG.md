# Changelog

All notable changes to Proton Pulse (web) should be recorded here.

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
