// Shared localStorage helpers for the anonymous Steam profile lookup.
// Written by /lookup and by the inline "Library" panels that appear under
// the Login-with-Steam button on sign-in surfaces (issue #323 followup).
//
// Every page that reads or writes the lookup identifier goes through this
// module so a single keyname change lands everywhere. Never inline the key
// strings elsewhere.

export const LS_INPUT_KEY = 'pp:lookup-profile-input';
export const LS_STEAMID_KEY = 'pp:lookup-profile-steamid';

export function readSavedLookup() {
  try {
    return {
      input: localStorage.getItem(LS_INPUT_KEY) || '',
      steamId: localStorage.getItem(LS_STEAMID_KEY) || '',
    };
  } catch {
    return { input: '', steamId: '' };
  }
}

export function writeSavedLookup(input, steamId) {
  try {
    localStorage.setItem(LS_INPUT_KEY, input);
    if (steamId) localStorage.setItem(LS_STEAMID_KEY, steamId);
  } catch {
    // storage disabled (private tab, quota) -- fall back to session-only
  }
}

export function clearSavedLookup() {
  try {
    localStorage.removeItem(LS_INPUT_KEY);
    localStorage.removeItem(LS_STEAMID_KEY);
  } catch { /* ignore */ }
}
