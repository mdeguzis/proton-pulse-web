# TODO

Short list of what is in flight or queued, so it survives between sessions.
GitHub issues stay the source of truth; this file just keeps the order.
Remove an item when it ships to prod.

## Waiting on something

- #258 slow finalize: the fixes are on main as of #560. Close it once a few nightly runs confirm finalize is faster.
- #561 certifi cooldown exception: delete the `exclude-newer-package` line in pyproject.toml after 2026-10-27 and relock.
- #497 PCGamingWiki ingest: the code fix shipped, but it's blocked on PCGW granting the bot Cargo access.
- The anti-cheat Steam store vendor scan is off (`ANTI_CHEAT_APPDETAILS_PROBE_CAP=0`) until #258 shows finalize has headroom. Turning it on is what makes the "Uses anti-cheat, no verdict yet" wording appear.
