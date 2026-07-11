// User-context tags shown under the artwork on the game details page
// (#266 refinement). Small tiles like "On wishlist" / "In library" that
// signal to a signed-in user how the current game relates to their
// Steam account. There is no site-pref toggle: tags render when the
// user is signed in AND the appid is in the corresponding cached Set.
// Signed-out users see none; the row simply stays empty.
//
// Add a new tag by:
//  1. Extending KNOWN_BADGES with { key, label, color }
//  2. Adding a match branch to computeBadgesForAppId
//  3. Wiring whatever data source it needs in game-page.js's tag-row
//     filler (currently: library + wishlist Sets)

// Ordered so the tags render consistently across the site.
export const KNOWN_BADGES = [
  { key: 'wishlist', label: 'On wishlist', color: '#66c0f4' },
  { key: 'library',  label: 'In library',  color: '#66c0f4' },
];

/**
 * Given an appId and a context bag ({libraryAppIds, wishlistAppIds,
 * signedIn}), return the tags that should appear on the details page.
 * Returns a subset of KNOWN_BADGES so callers can style with the `color`
 * field. Signed-out users get an empty array -- these tags are auth-gated
 * because they carry account-specific meaning.
 */
export function computeBadgesForAppId(appId, ctx = {}) {
  if (ctx.signedIn === false) return [];
  const numericId = Number(appId);
  const results = [];
  for (const b of KNOWN_BADGES) {
    let show = false;
    if (b.key === 'wishlist') {
      show = !!(ctx.wishlistAppIds && ctx.wishlistAppIds.has && ctx.wishlistAppIds.has(numericId));
    } else if (b.key === 'library') {
      show = !!(ctx.libraryAppIds && ctx.libraryAppIds.has && ctx.libraryAppIds.has(numericId));
    }
    if (show) results.push(b);
  }
  return results;
}
