// Page config for profile.html.
// Bridges classic-script globals (set by supabase-client.js) into module scope,
// plus the environment flag, localStorage key names, and localhost mock data.
export const SUPABASE_URL      = window.SUPABASE_URL;
export const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
export const SupaAuth          = window.SupaAuth;

// localhost dev mode: show mock profile data so the page is previewable
export const IS_LOCAL_DEV = /^localhost(:\d+)?$/.test(window.location.host);
export const SHOW_USERNAME_KEY = 'proton-pulse:show-username-on-reports';

// Filter preferences (used by the View Reports pages)
export const HW_GPU_KEY = 'proton-pulse:hw-gpu-vendor';
export const HW_OS_KEY  = 'proton-pulse:hw-os';
export const CONFIG_TYPE_KEY = 'proton-pulse:config-type';

// Actual hardware spec (auto-fills the web submit-a-report form).
// Keep these prefixed separately so they don't clobber the filter prefs above.
export const MYHW_KEYS = {
  cpu:        'proton-pulse:myhw:cpu',
  gpu:        'proton-pulse:myhw:gpu',
  gpuVendor:  'proton-pulse:myhw:gpu-vendor',
  gpuDriver:  'proton-pulse:myhw:gpu-driver',
  ram:        'proton-pulse:myhw:ram',
  vramMb:     'proton-pulse:myhw:vram-mb',
  os:         'proton-pulse:myhw:os',
  osVersion:  'proton-pulse:myhw:os-version',
  kernel:     'proton-pulse:myhw:kernel',
};
export const MYHW_SOURCE_META_KEY = 'proton-pulse:myhw:source-meta';

// Per-field origin tracking. This is separate from the single source-meta
// blob so the UI can label each input individually, e.g. "CPU from default
// system" vs "GPU manually edited". Values: 'default-system' | 'steam-paste'
// | 'manual'. Missing entry = never set, show nothing.
export const MYHW_FIELD_ORIGINS_KEY = 'proton-pulse:myhw:field-origins';

// Short, human-readable caption per origin. Keep these terse because they
// render inline next to every field label
export const MYHW_ORIGIN_LABELS = {
  'default-system': 'from default system',
  'steam-paste':    'from pasted sysinfo',
  'manual':         'edited',
};
// Same key app.js uses. Duplicated here because app.js isn't loaded on the
// profile page and I didn't want a third file just for one function
export const WEB_CLIENT_ID_KEY = 'proton-pulse:web-client-id';
export const FIELD_LABELS = {
  notes: 'your notes',
  title: 'the game title',
  launch_options: 'the launch options',
  'form_responses.onlineMultiplayerNotes': 'the online multiplayer notes',
  'form_responses.localMultiplayerNotes': 'the local multiplayer notes',
  'form_responses.framegenNotes': 'the frame generation notes',
  'form_responses.offlineNotes': 'the offline notes',
  'form_responses.generalNotes': 'the general notes',
};
// Mock data for localhost preview so the full profile page is testable offline
export const MOCK_USER = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  email: 'deckpilot@protonmail.com',
  last_sign_in_at: new Date(Date.now() - 3600_000).toISOString(),
  user_metadata: {
    full_name: 'DeckPilot42',
    avatar_url: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg',
    steam_id: '76561198012345678',
  },
};
export const MOCK_SYSTEMS = [
  {
    device_id: 'deck-lcd-001',
    label: 'Steam Deck LCD',
    is_default: true,
    updated_at: new Date(Date.now() - 86400_000 * 2).toISOString(),
    sysinfo_text: 'CPU Brand: AMD Custom APU 0405\nVideo Card: AMD Custom GPU 0405 (VanGogh)\nRAM: 16384 Mb\nOS Version: SteamOS 3.5.17 (Jupiter)\nDriver Version: Mesa 24.1.0\nKernel Version: 6.5.0-valve22',
  },
  {
    device_id: 'desktop-001',
    label: 'Desktop',
    is_default: false,
    updated_at: new Date(Date.now() - 86400_000 * 10).toISOString(),
    sysinfo_text: 'CPU Brand: AMD Ryzen 7 5800X3D 8-Core Processor\nVideo Card: NVIDIA GeForce RTX 4070\nRAM: 32768 Mb\nOS Version: Arch Linux\nDriver Version: 555.42.02\nKernel Version: 6.8.12-arch1-1',
  },
];
export const MOCK_LINKED_PLUGINS = [
  { installation_id: 'inst-deck-lcd-001', device_label: 'Steam Deck LCD', linked_at: new Date(Date.now() - 86400_000 * 30).toISOString() },
];
export const MOCK_REPORTS = [
  { app_id: 1091500, title: 'Cyberpunk 2077', rating: 'Gold', updated_at: new Date(Date.now() - 86400_000 * 3).toISOString(), cloud: true, unpublished: false },
  { app_id: 1245620, title: 'Elden Ring',     rating: 'Gold', updated_at: new Date(Date.now() - 86400_000 * 7).toISOString(), cloud: true, unpublished: false },
  { app_id: 292030,  title: 'The Witcher 3: Wild Hunt', rating: 'Platinum', updated_at: new Date(Date.now() - 86400_000 * 14).toISOString(), cloud: false, unpublished: false },
  { app_id: 413150,  title: 'Stardew Valley', rating: 'Platinum', updated_at: new Date(Date.now() - 86400_000 * 21).toISOString(), cloud: true, unpublished: true },
];
