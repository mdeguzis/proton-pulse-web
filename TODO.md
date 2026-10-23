# TODO

Short list of what is in flight or queued, so it survives between sessions.
GitHub issues stay the source of truth; this file just keeps the order.
Remove an item when it ships to prod.

## Shipping in the next staging to main PR

- #556 anti-cheat on the game page and cards, and #242 the home anti-cheat filter. The plugin side is decky-proton-pulse#129, on the plugin's dev branch.
- #258 slow finalize: probe caches persist, box art probes concurrently, Steam type and SGDB caches carried forward, the adult check has a circuit breaker and keeps the last confirmed adult flag on failure, and staging finalize starts from main's warm cache. Needs a few nightly runs on main to confirm before closing.
- #543 RLS test fixture race and #555 test cache isolation.

## Waiting on something

- #497 PCGamingWiki ingest: the code fix shipped, but it's blocked on PCGW granting the bot Cargo access.
- The anti-cheat Steam store vendor scan is off (`ANTI_CHEAT_APPDETAILS_PROBE_CAP=0`) until #258 shows finalize has headroom. Turning it on is what makes the "Uses anti-cheat, no verdict yet" wording appear.
