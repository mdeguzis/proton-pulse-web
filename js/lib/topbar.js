// Shared topbar component for every page on the site.
// Injects the icon sprite, two-tier banner+nav, and mobile drawer at body start,
// then wires the universal behaviors (active link, mobile toggle, search dropdown,
// auth state indicator).
//
// Page-specific logic (Supabase stats on index, profile editing, etc.) stays in
// each page's own JS. This file is the single source of truth for chrome.

(function () {
  var _reflowOverflow = null; // set by wireNavOverflow, called after auth resolves

  // ---- 1. Markup -------------------------------------------------------

  const SPRITE = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <defs>
    <symbol id="icon-home" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
    </symbol>
    <symbol id="icon-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
    </symbol>
    <symbol id="icon-database" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>
    </symbol>
    <symbol id="icon-chart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12c0 5-4 9-9 9s-9-4-9-9 4-9 9-9"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>
    </symbol>
    <symbol id="icon-stats" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/>
    </symbol>
    <symbol id="icon-contact" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </symbol>
    <symbol id="icon-scoring" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2v20"/><path d="m17 5-5-3-5 3"/><path d="M5 14h14"/><path d="M5 14a4 4 0 0 0 4-4V5"/><path d="M19 14a4 4 0 0 1-4-4V5"/><path d="M19 14a4 4 0 0 1-4 4h-1a4 4 0 0 0-4 0H9a4 4 0 0 1-4-4"/>
    </symbol>
    <symbol id="icon-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
    </symbol>
    <symbol id="icon-github" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
      <path d="M9 18c-4.51 2-5-2-7-2"/>
    </symbol>
    <symbol id="icon-gamepad" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/>
      <line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/>
      <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258a4 4 0 0 0-3.995-3.743Z"/>
    </symbol>
    <symbol id="icon-menu" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/>
    </symbol>
    <symbol id="icon-user" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
    </symbol>
    <symbol id="icon-discord" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 7a14.9 14.9 0 0 0-4-1 10 10 0 0 0-.4 1 14 14 0 0 0-4.2 0A10 10 0 0 0 9 6a14.9 14.9 0 0 0-4 1C3 10.5 2.5 14 3 17a15 15 0 0 0 4.7 2.4l.6-1a9.5 9.5 0 0 1-1.3-.6l.3-.2a10.5 10.5 0 0 0 9.4 0l.3.2a9.4 9.4 0 0 1-1.3.6l.6 1A15 15 0 0 0 21 17c.5-3-.1-6.5-3-10z"/>
      <circle cx="9.5" cy="11.5" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="14.5" cy="11.5" r="1.2" fill="currentColor" stroke="none"/>
    </symbol>
    <!-- Store glyphs for the "store badge: icon" preference. Each retains
         the brand's actual outline rather than being forced into a circle:
         Steam is its own round mark on a blue circle; GOG is a white disc
         with the purple "gog" wordmark; Epic is the shield-with-tab badge
         in dark grey with the white "EPIC" wordmark. -->
    <symbol id="icon-store-steam" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="12" fill="#1689d0"/>
      <g transform="translate(4 4) scale(0.667)" fill="#fff">
        <path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658a3.37 3.37 0 011.912-.59c.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61a2.563 2.563 0 001.314 1.25 2.557 2.557 0 003.337-1.375 2.534 2.534 0 00-1.373-3.331 2.567 2.567 0 00-1.878-.03l1.523.63a1.885 1.885 0 011.013 2.455 1.892 1.892 0 01-2.463 1.011zm11.415-9.301a3.014 3.014 0 00-3.015-3.014 3.013 3.013 0 100 6.027 3.013 3.013 0 003.015-3.013zm-5.273-.004a2.26 2.26 0 014.521 0 2.26 2.26 0 01-4.521 0z"/>
      </g>
    </symbol>
    <symbol id="icon-store-gog" viewBox="0 0 24 24">
      <!-- GOG's brand mark is a white disc with the purple 'gog' wordmark
           inside a thin purple ring. Stylized as a clean text mark since
           the real type face isn't web-available. -->
      <circle cx="12" cy="12" r="11.5" fill="#fff" stroke="#7a3fcf" stroke-width="1.2"/>
      <text x="12" y="16" text-anchor="middle" font-family="Inter, -apple-system, system-ui, sans-serif" font-weight="900" font-size="10" fill="#7a3fcf" letter-spacing="-0.5">gog</text>
    </symbol>
    <symbol id="icon-store-epic" viewBox="0 0 24 24">
      <!-- Epic's brand mark is a shield-shaped badge (rounded rectangle
           with a downward V-tab at the bottom) in dark slate, with the
           white 'EPIC' wordmark above the tab. -->
      <path d="M4 2 L20 2 Q22 2 22 4 L22 16 L12 22 L2 16 L2 4 Q2 2 4 2 Z" fill="#2a2a2a"/>
      <text x="12" y="14" text-anchor="middle" font-family="Inter, -apple-system, system-ui, sans-serif" font-weight="900" font-size="6.5" fill="#fff" letter-spacing="0.3">EPIC</text>
      <path d="M9 16 L15 16 L12 19 Z" fill="#fff"/>
    </symbol>
  </defs>
</svg>`;

  const BANNER_AND_NAV = `
<header class="topbar">
  <div class="topbar-banner">
    <svg class="topbar-banner-bg" viewBox="0 0 1600 46" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="bannerPulseGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stop-color="#beee11" stop-opacity="0"/>
          <stop offset="50%"  stop-color="#beee11" stop-opacity="0.9"/>
          <stop offset="100%" stop-color="#beee11" stop-opacity="0"/>
        </linearGradient>
        <radialGradient id="electronGlow">
          <stop offset="0%"   stop-color="#aedcff" stop-opacity="1"/>
          <stop offset="60%"  stop-color="#66c0f4" stop-opacity="0.7"/>
          <stop offset="100%" stop-color="#66c0f4" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="electronGlowGreen">
          <stop offset="0%"   stop-color="#dffb56" stop-opacity="1"/>
          <stop offset="60%"  stop-color="#beee11" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="#beee11" stop-opacity="0"/>
        </radialGradient>
        <symbol id="atomBeacon" viewBox="-30 -16 60 32">
          <ellipse cx="0" cy="0" rx="26" ry="9" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.45"/>
          <ellipse cx="0" cy="0" rx="26" ry="9" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.45" transform="rotate(60)"/>
          <ellipse cx="0" cy="0" rx="26" ry="9" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.45" transform="rotate(-60)"/>
          <circle cx="0" cy="0" r="1.6" fill="currentColor"/>
        </symbol>
      </defs>
      <path class="banner-pulse"
            d="M 0 23 L 280 23 L 296 12 L 312 34 L 328 16 L 344 30 L 360 23 L 720 23 L 736 18 L 752 30 L 768 23 L 1160 23 L 1176 14 L 1192 32 L 1208 18 L 1224 23 L 1600 23"
            fill="none" stroke="url(#bannerPulseGrad)" stroke-width="1.4" stroke-linejoin="round"/>
      <g class="banner-atoms">
        <g transform="translate(560 23)" color="#66c0f4" opacity="0.75">
          <use href="#atomBeacon"/>
          <circle r="1.8" fill="url(#electronGlow)">
            <animateMotion dur="4.2s" repeatCount="indefinite" rotate="0"
                           path="M 26 0 A 26 9 0 1 1 -26 0 A 26 9 0 1 1 26 0"/>
          </circle>
        </g>
        <g transform="translate(880 23)" color="#beee11" opacity="0.7">
          <use href="#atomBeacon"/>
          <circle r="1.6" fill="url(#electronGlowGreen)">
            <animateMotion dur="3.4s" repeatCount="indefinite" rotate="0"
                           path="M 22 0 A 22 8 30 1 1 -22 0 A 22 8 30 1 1 22 0"/>
          </circle>
          <circle r="1.2" fill="url(#electronGlowGreen)" opacity="0.7">
            <animateMotion dur="5.1s" begin="-1.7s" repeatCount="indefinite" rotate="0"
                           path="M 22 0 A 22 8 -30 1 0 -22 0 A 22 8 -30 1 0 22 0"/>
          </circle>
        </g>
        <g transform="translate(1180 23)" color="#66c0f4" opacity="0.75">
          <use href="#atomBeacon"/>
          <circle r="1.8" fill="url(#electronGlow)">
            <animateMotion dur="3.8s" begin="-0.9s" repeatCount="indefinite" rotate="0"
                           path="M 24 0 A 24 8.5 0 1 1 -24 0 A 24 8.5 0 1 1 24 0"/>
          </circle>
          <circle r="1.4" fill="url(#electronGlow)" opacity="0.8">
            <animateMotion dur="2.6s" begin="-0.3s" repeatCount="indefinite" rotate="0"
                           path="M 24 0 A 24 8.5 60 1 0 -24 0 A 24 8.5 60 1 0 24 0"/>
          </circle>
        </g>
        <g transform="translate(1440 23)" color="#ff3aa5" opacity="0.6">
          <use href="#atomBeacon"/>
          <circle r="1.6" fill="#ff3aa5">
            <animateMotion dur="4.6s" begin="-2.1s" repeatCount="indefinite" rotate="0"
                           path="M 22 0 A 22 7.5 0 1 1 -22 0 A 22 7.5 0 1 1 22 0"/>
          </circle>
        </g>
      </g>
    </svg>

    <a class="topbar-brand" href="index.html">
      <span class="topbar-brand-mark" aria-hidden="true">
        <svg viewBox="0 0 36 36" fill="none">
          <ellipse class="brand-ring-a" cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.1"/>
          <ellipse class="brand-ring-b" cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.1" transform="rotate(60 18 18)"/>
          <ellipse class="brand-ring-c" cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.1" transform="rotate(-60 18 18)"/>
          <circle cx="18" cy="18" r="2.6" fill="currentColor"/>
        </svg>
      </span>
      <span class="topbar-brand-text">
        Proton <span class="brand-accent">Pulse</span>
      </span>
      <span class="topbar-brand-tag">Open Compatibility Platform</span>
    </a>

    <div class="topbar-banner-actions">
      <!-- Site options (gear): page for non-profile settings, starting with
           an animations on/off toggle. -->
      <a class="banner-icon-link" href="options.html" data-page="options" title="Site options" aria-label="Site options">
        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </a>
      <!-- Theme toggle - sun/moon icon flips between dark (default) and light.
           Persists to localStorage so it survives page reloads. Respects
           prefers-color-scheme on first visit when no preference is saved -->
      <button class="banner-icon-link theme-toggle" id="theme-toggle" title="Toggle light/dark theme" aria-label="Toggle theme">
        <svg class="nav-icon theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        <svg class="nav-icon theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
      </button>
      <div class="gh-auth-chip" id="gh-auth-chip">
        <a class="auth-link" id="auth-signedout" href="profile.html" title="Sign in or manage account">
          <svg class="nav-icon" aria-hidden="true"><use href="#icon-user"/></svg>
          <span>Login</span>
        </a>
        <a class="auth-link auth-link--signedin" id="auth-signedin" href="profile.html" title="Manage account" hidden>
          <img class="auth-avatar" id="google-avatar" src="" alt="" width="22" height="22">
          <span class="auth-username" id="google-username"></span>
        </a>
      </div>
      <button class="topbar-mobile-toggle" id="mobile-nav-toggle" aria-label="Toggle navigation" aria-expanded="false">
        <svg aria-hidden="true"><use href="#icon-menu"/></svg>
      </button>
    </div>
  </div>

  <div class="topbar-nav">
    <nav class="topnav-links" id="primary-nav">
      <a href="index.html" data-page="index">
        <svg class="nav-icon" aria-hidden="true"><use href="#icon-home"/></svg>
        <span>Home</span>
      </a>
      <!-- Browse dropdown: opens on hover (and focus-within for keyboard).
           Reports/Data/Coverage/Stats all live behind here so the top row
           stays compact. Parent button highlights if you're on any child -->
      <div class="nav-dropdown" data-group="browse">
        <button class="nav-dropdown-toggle" type="button" aria-haspopup="true" aria-expanded="false">
          <svg class="nav-icon" aria-hidden="true"><use href="#icon-search"/></svg>
          <span>Browse</span>
          <svg class="nav-caret" aria-hidden="true" viewBox="0 0 10 6" width="10" height="6"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
        </button>
        <div class="nav-dropdown-panel">
          <a href="app.html" data-page="app">
            <svg class="nav-icon" aria-hidden="true"><use href="#icon-search"/></svg>
            <span>Reports</span>
          </a>
          <a href="data-index.html" data-page="data-index">
            <svg class="nav-icon" aria-hidden="true"><use href="#icon-database"/></svg>
            <span>Data</span>
          </a>
          <a href="coverage.html" data-page="coverage">
            <svg class="nav-icon" aria-hidden="true"><use href="#icon-chart"/></svg>
            <span>Coverage</span>
          </a>
          <a href="stats.html" data-page="stats">
            <svg class="nav-icon" aria-hidden="true"><use href="#icon-stats"/></svg>
            <span>Stats</span>
          </a>
        </div>
      </div>
      <!-- Resources dropdown: scoring docs and the decky plugin live here -->
      <div class="nav-dropdown" data-group="resources">
        <button class="nav-dropdown-toggle" type="button" aria-haspopup="true" aria-expanded="false">
          <svg class="nav-icon" aria-hidden="true"><use href="#icon-scoring"/></svg>
          <span>Resources</span>
          <svg class="nav-caret" aria-hidden="true" viewBox="0 0 10 6" width="10" height="6"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
        </button>
        <div class="nav-dropdown-panel">
          <a href="scoring.html" data-page="scoring" title="How compatibility scores are calculated">
            <svg class="nav-icon" aria-hidden="true"><use href="#icon-scoring"/></svg>
            <span>Scoring</span>
          </a>
          <a href="https://github.com/mdeguzis/decky-proton-pulse" target="_blank" rel="noopener" title="Decky Loader plugin for Steam Deck">
            <svg class="nav-icon" aria-hidden="true"><use href="#icon-gamepad"/></svg>
            <span>Decky Plugin</span>
          </a>
          <a href="https://github.com/mdeguzis/proton-pulse-web/issues/new/choose" target="_blank" rel="noopener" title="Report a bug, file a Game Report, or contact the maintainer">
            <svg class="nav-icon" aria-hidden="true"><use href="#icon-contact"/></svg>
            <span>Contact</span>
          </a>
          <a href="https://discord.gg/4p6e4X7xW" target="_blank" rel="noopener" title="Join the Proton Pulse Discord">
            <svg class="nav-icon" aria-hidden="true"><use href="#icon-discord"/></svg>
            <span>Discord</span>
          </a>
        </div>
      </div>
      <!-- Admin link: hidden until checkIsAdmin confirms the signed-in user is an admin -->
      <a href="admin.html" id="topbar-admin-link" class="auth-admin-navlink" hidden>
        <span>Admin</span>
      </a>
      <!-- About: kept last in nav order so it sits at the trailing edge
           regardless of whether the admin link is visible. -->
      <a href="about.html" data-page="about" title="What Proton Pulse is and how it compares to ProtonDB">
        <svg class="nav-icon" aria-hidden="true"><use href="#icon-info"/></svg>
        <span>About</span>
      </a>
      <!-- Overflow "More" button. Hidden by default; topbar resize observer
           reveals it and migrates trailing items into the panel when the nav
           gets squeezed (typical between 760 and ~1280px) -->
      <div class="nav-overflow" id="nav-overflow" hidden>
        <button class="nav-overflow-toggle" id="nav-overflow-toggle" aria-haspopup="true" aria-expanded="false" type="button">
          <svg class="nav-icon" aria-hidden="true"><use href="#icon-menu"/></svg>
          <span>More</span>
        </button>
        <div class="nav-overflow-panel" id="nav-overflow-panel"></div>
      </div>
    </nav>

    <div class="topbar-search-wrap">
      <svg class="topbar-search-icon" aria-hidden="true"><use href="#icon-search"/></svg>
      <input id="search" type="search" placeholder="Search games or app ID..." autocomplete="off" aria-label="Search games" aria-autocomplete="list" aria-controls="search-dropdown" aria-expanded="false">
      <div id="search-dropdown" class="search-dropdown" role="listbox" hidden></div>
    </div>
  </div>
</header>

<div class="mobile-nav-drawer" id="mobile-nav-drawer" hidden>
  <a href="index.html" data-page="index"><svg class="nav-icon" aria-hidden="true"><use href="#icon-home"/></svg> Home</a>
  <a href="app.html" data-page="app"><svg class="nav-icon" aria-hidden="true"><use href="#icon-search"/></svg> Reports</a>
  <a href="data-index.html" data-page="data-index"><svg class="nav-icon" aria-hidden="true"><use href="#icon-database"/></svg> Data</a>
  <a href="coverage.html" data-page="coverage"><svg class="nav-icon" aria-hidden="true"><use href="#icon-chart"/></svg> Coverage</a>
  <a href="stats.html" data-page="stats"><svg class="nav-icon" aria-hidden="true"><use href="#icon-stats"/></svg> Stats</a>
  <a href="scoring.html" data-page="scoring"><svg class="nav-icon" aria-hidden="true"><use href="#icon-scoring"/></svg> Scoring</a>
  <a href="https://github.com/mdeguzis/proton-pulse-web/issues/new/choose" target="_blank" rel="noopener"><svg class="nav-icon" aria-hidden="true"><use href="#icon-contact"/></svg> Contact</a>
  <a href="https://github.com/mdeguzis/decky-proton-pulse" target="_blank" rel="noopener"><svg class="nav-icon" aria-hidden="true"><use href="#icon-gamepad"/></svg> Decky Plugin</a>
  <a href="https://github.com/mdeguzis/proton-pulse-web" target="_blank" rel="noopener"><svg class="nav-icon" aria-hidden="true"><use href="#icon-github"/></svg> GitHub</a>
  <a href="https://discord.gg/4p6e4X7xW" target="_blank" rel="noopener"><svg class="nav-icon" aria-hidden="true"><use href="#icon-discord"/></svg> Discord</a>
  <a href="admin.html" id="mobile-admin-link" data-page="admin" hidden><svg class="nav-icon" aria-hidden="true"><use href="#icon-stats"/></svg> Admin</a>
  <!-- About kept last so it remains the trailing item whether the
       admin link is visible or not. -->
  <a href="about.html" data-page="about"><svg class="nav-icon" aria-hidden="true"><use href="#icon-info"/></svg> About</a>
</div>`;

  // ---- 2. Insert markup at body start (skip if already present) --------

  // ---- Theme toggle (light/dark) -----------------------------------
  //
  // Dark is the default. The toggle persists the user's choice in
  // localStorage so it survives page reloads. On first visit with no
  // stored preference, we respect prefers-color-scheme if the OS is
  // set to light mode. The CSS flips via [data-theme="light"] on <html>.

  function initTheme() {
    const THEME_KEY = 'proton-pulse:theme';
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else if (!stored && window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }

  function wireThemeToggle() {
    const THEME_KEY = 'proton-pulse:theme';
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;

    function update() {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      btn.querySelector('.theme-icon-sun').style.display = isLight ? 'none' : 'block';
      btn.querySelector('.theme-icon-moon').style.display = isLight ? 'block' : 'none';
      btn.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
    }

    btn.addEventListener('click', function () {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      if (isLight) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem(THEME_KEY, 'dark');
      } else {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem(THEME_KEY, 'light');
      }
      update();
    });

    update();
  }

  // Site option: animations on/off. When off (explicit choice, or the OS
  // prefers-reduced-motion with no saved choice), set data-motion=off so CSS
  // disables animations/transitions, and pause SMIL (<animateMotion>), which CSS
  // cannot stop. Saved by the options page under proton-pulse:motion.
  function motionDisabled() {
    const stored = localStorage.getItem('proton-pulse:motion'); // 'on' | 'off' | null
    if (stored === 'off') return true;
    if (stored === 'on') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function pauseSmilAnimations() {
    const svgs = document.querySelectorAll('svg');
    let paused = 0;
    svgs.forEach(function (svg) {
      if (typeof svg.pauseAnimations === 'function') {
        try { svg.pauseAnimations(); paused++; } catch (e) { /* ignore */ }
      }
    });
    console.log('[topbar] pauseSmilAnimations: paused', paused, 'of', svgs.length, 'SVGs');
  }
  function initMotion() {
    const stored = localStorage.getItem('proton-pulse:motion');
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const disabled = motionDisabled();
    console.log('[topbar] initMotion: stored=' + stored + ' prefersReduced=' + prefersReduced + ' => disabled=' + disabled);
    if (disabled) {
      document.documentElement.setAttribute('data-motion', 'off');
      pauseSmilAnimations();
      console.log('[topbar] initMotion: set data-motion=off, html attr now:', document.documentElement.getAttribute('data-motion'));
    }
  }

  // Apply theme + motion prefs BEFORE inject so the first paint is correct
  // (avoids a flash of the wrong mode / running animations).
  initTheme();
  initMotion();
  // Defaults: store badge sits in the bar (bar-inline) on mobile, in the
  // card corner (art-corner) on desktop. Both viewports default to the
  // text label until the round brand glyphs read consistently across
  // stores. Mobile picks bar-inline because the card-corner tag steals
  // useful width from the title row at narrow screens.
  const _isDesktop = window.matchMedia('(min-width: 760px)').matches;

  // Store badge placement. Other values: 'right' (legacy column), 'art'
  // (thumbnail overlay), 'art-corner' (card top-right), 'bar-inline'
  // (next to tier in the strip), 'bar-segment' (split strip).
  // Migrations: dropped 'bar-right' -> 'bar-segment'; renamed 'bar-icon'
  // -> 'bar-inline' once it started honoring the store-display pref.
  let storePillPos = localStorage.getItem('pp:store-pill-pos');
  if (storePillPos === 'bar-right') {
    storePillPos = 'bar-segment';
    localStorage.setItem('pp:store-pill-pos', 'bar-segment');
  } else if (storePillPos === 'bar-icon') {
    storePillPos = 'bar-inline';
    localStorage.setItem('pp:store-pill-pos', 'bar-inline');
  }
  if (!storePillPos) storePillPos = _isDesktop ? 'art-corner' : 'bar-inline';
  if (storePillPos !== 'right') {
    document.documentElement.setAttribute('data-store-pill-pos', storePillPos);
  }
  // Card layout preference. Default is 'strip' on both viewports (tier in
  // a colored bar across the full bottom of the card). 'right' falls back
  // to the column pill; 'combo' shows the tier + store as a two-tone
  // corner chip and hides the strip / right column entirely.
  const cardLayoutPref = localStorage.getItem('pp:card-layout') || 'strip';
  if (cardLayoutPref === 'strip' || cardLayoutPref === 'combo') {
    document.documentElement.setAttribute('data-card-layout', cardLayoutPref);
  }
  // Store badge display. Default is 'text' on both viewports until the
  // round brand glyphs read consistently at small sizes; 'icon' is still
  // available as an opt-in for users who want the compact look.
  const storeDisplayPref = localStorage.getItem('pp:store-display') || 'text';
  if (storeDisplayPref === 'icon') {
    document.documentElement.setAttribute('data-store-display', 'icon');
  }

  // inject favicon if the page doesn't already have one
  if (!document.querySelector('link[rel="icon"]')) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = 'favicon.svg';
    document.head.appendChild(link);
  }

  // Make the steam-img.js 3-tier fallback (akamai -> cloudflare -> game-images.json
  // -> hide) available on every page that loads the topbar. Pages that already
  // import steam-img.js through their bundle short-circuit via the __steamImgLoad
  // existence check. Without this, the topbar search dropdown's <img onerror>
  // would no-op on pages outside the app bundle.
  if (typeof window.__steamImgLoad !== 'function' &&
      !document.querySelector('script[data-topbar-steam-img]')) {
    const s = document.createElement('script');
    s.type = 'module';
    s.src = 'js/app/lib/steam-img.js';
    s.dataset.topbarSteamImg = '';
    document.head.appendChild(s);
  }

  // Same-name disambiguation for search results. When two or more visible
  // results normalize to the same title (Prey 2006 vs Prey 2017, etc.), append
  // " (YEAR)" to any result that has a releaseYear -- the storefront badge
  // alone is not enough to tell them apart. Returns Map<index, displayTitle>
  // with only the overridden indices; callers fall back to r.title when absent.
  //
  // Exposed as window.__buildTitleOverrides so the app.html grouped-results
  // page (an ES module) can reuse the same logic without duplicating it.
  function buildTitleOverrides(results) {
    const groups = {};
    for (let i = 0; i < results.length; i++) {
      const key = String(results[i].title || '').trim().toLowerCase();
      if (!key) continue;
      (groups[key] = groups[key] || []).push(i);
    }
    const out = new Map();
    Object.keys(groups).forEach(function (key) {
      const idxs = groups[key];
      if (idxs.length <= 1) return;
      idxs.forEach(function (i) {
        const r = results[i];
        if (r.releaseYear) {
          out.set(i, r.title + ' (' + r.releaseYear + ')');
        }
      });
    });
    return out;
  }
  window.__buildTitleOverrides = buildTitleOverrides;

  function inject() {
    if (document.querySelector('.topbar')) return; // page already has it (e.g. inlined for SSR)
    // sprite first so the <use href="#..."> refs in the banner resolve immediately
    document.body.insertAdjacentHTML('afterbegin', SPRITE + BANNER_AND_NAV);
    const disabled = motionDisabled();
    const htmlMotion = document.documentElement.getAttribute('data-motion');
    const atoms = document.querySelector('.banner-atoms');
    console.log('[topbar] inject: motionDisabled=' + disabled + ' data-motion=' + htmlMotion + ' .banner-atoms found=' + !!atoms);
    if (atoms) {
      const computed = getComputedStyle(atoms).display;
      console.log('[topbar] inject: .banner-atoms computed display=' + computed);
    }
    // pauseSmilAnimations() in initMotion() runs before the SVG exists; re-apply now
    if (disabled) pauseSmilAnimations();
    markActive();
    wireMobileDrawer();
    wireSearchDropdown();
    wireAuthIndicator();
    wireNavOverflow();
    wireThemeToggle();
    wireDropdowns();
  }

  // ---- 3. Active link based on current page ----------------------------

  function markActive() {
    // derive page key from filename, default to "index" for / and /index.html
    let page = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
    if (!page) page = 'index';
    document.querySelectorAll('[data-page]').forEach(function (a) {
      if (a.getAttribute('data-page') === page) a.classList.add('active');
    });
    // Lift active state up to the parent dropdown toggle so the user can
    // tell at a glance which group the current page lives in
    document.querySelectorAll('.nav-dropdown').forEach(function (dd) {
      if (dd.querySelector('a.active')) dd.classList.add('has-active');
    });
  }

  // ---- 3b. Dropdown click toggle (hover already handled in CSS) -------
  //
  // CSS gives us hover-to-open and focus-within-to-stay-open. Add click as
  // a third path for touch + keyboard users who reach the toggle via tab
  // and press Enter. Clicking outside any open dropdown closes it.

  function wireDropdowns() {
    const dropdowns = document.querySelectorAll('.nav-dropdown');
    dropdowns.forEach(function (dd) {
      const toggle = dd.querySelector('.nav-dropdown-toggle');
      if (!toggle) return;
      toggle.addEventListener('click', function (e) {
        e.preventDefault();
        const wasOpen = dd.classList.contains('is-open');
        // close any other open dropdown first
        dropdowns.forEach(function (other) {
          if (other !== dd) other.classList.remove('is-open');
        });
        dd.classList.toggle('is-open', !wasOpen);
        toggle.setAttribute('aria-expanded', String(!wasOpen));
      });
    });
    document.addEventListener('click', function (e) {
      // close all when clicking anywhere outside a dropdown
      if (!e.target.closest('.nav-dropdown')) {
        dropdowns.forEach(function (dd) {
          dd.classList.remove('is-open');
          const t = dd.querySelector('.nav-dropdown-toggle');
          if (t) t.setAttribute('aria-expanded', 'false');
        });
      }
    });
  }

  // ---- 4a. Overflow "More" menu (priority+ pattern) -------------------
  //
  // When the nav row runs out of room (typically between 760 and ~1280px),
  // trailing items collapse into a "More" dropdown. ResizeObserver re-checks
  // the fit whenever the nav width changes. The "More" button itself takes
  // ~80px so leave a buffer when measuring.

  function wireNavOverflow() {
    const nav = document.getElementById('primary-nav');
    const wrap = document.getElementById('nav-overflow');
    const toggle = document.getElementById('nav-overflow-toggle');
    const panel = document.getElementById('nav-overflow-panel');
    if (!nav || !wrap || !toggle || !panel) return;

    // Snapshot every nav <a> in its original order so we can move things
    // freely without losing the layout. The More button (`wrap`) stays at
    // the end of the nav always
    const originalItems = Array.from(nav.querySelectorAll(':scope > a'));
    if (!originalItems.length) return;

    let openOverflow = false;

    function setOpen(open) {
      openOverflow = open;
      wrap.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!openOverflow);
    });

    // Click outside the panel closes it. Use capture phase so dropdown
    // internal clicks (handled below) still go through first
    document.addEventListener('click', function (e) {
      if (!openOverflow) return;
      if (!wrap.contains(e.target)) setOpen(false);
    });

    // Selecting an item in the panel closes the dropdown and navigates
    panel.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });

    // Returns the count of items that fit before the More button starts to
    // overflow. Uses the nav's natural scroll width as the metric: if
    // scrollWidth > clientWidth then the More button itself is being
    // pushed off-screen, so we need to move items into the panel.
    function fitItems() {
      // First put every item back in the nav (in original order) and let
      // layout settle, so we can re-measure naturally on every resize
      originalItems.forEach(function (a) {
        if (a.parentElement !== nav) nav.insertBefore(a, wrap);
      });
      panel.innerHTML = '';
      wrap.hidden = true;

      // Only run overflow logic when the nav is actually visible (above
      // the mobile breakpoint where the hamburger takes over)
      const navStyle = getComputedStyle(nav.parentElement || nav);
      if (navStyle.display === 'none') return;

      // If everything fits, we're done
      if (nav.scrollWidth <= nav.clientWidth + 1) return;

      // Reveal the More button, then move items from the end into the panel
      // one by one until things fit. Cap iterations as a safety guard
      wrap.hidden = false;
      let guard = originalItems.length;
      while (nav.scrollWidth > nav.clientWidth + 1 && guard-- > 0) {
        // Find the LAST original-order item still in the nav and move it
        for (let i = originalItems.length - 1; i >= 0; i--) {
          const a = originalItems[i];
          if (a.parentElement === nav) {
            // Clone for the overflow panel (so the original keeps any data-page
            // wiring and active state). Re-mark active on the clone too.
            const cloned = a.cloneNode(true);
            // Insert in reverse so panel order matches original left-to-right
            panel.insertBefore(cloned, panel.firstChild);
            // Hide original instead of removing - this keeps the layout
            // measurement stable when we re-run the fit calculation
            a.remove();
            break;
          }
        }
      }
      // Re-apply active class to overflow clones
      const activeKey = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '') || 'index';
      panel.querySelectorAll('[data-page="' + activeKey + '"]').forEach(function (a) { a.classList.add('active'); });
    }

    _reflowOverflow = fitItems;

    // Run once on insertion, then debounce on resize
    fitItems();
    let raf = null;
    const ro = new ResizeObserver(function () {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fitItems);
    });
    ro.observe(nav.parentElement || nav);
  }

  // ---- 4. Mobile drawer toggle ----------------------------------------

  function wireMobileDrawer() {
    const toggle = document.getElementById('mobile-nav-toggle');
    const drawer = document.getElementById('mobile-nav-drawer');
    if (!toggle || !drawer) return;

    toggle.addEventListener('click', function () {
      const open = drawer.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) drawer.removeAttribute('hidden');
    });
    drawer.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        drawer.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // ---- 5. Search dropdown (live results from search-index.json) -------

  function wireSearchDropdown() {
    const input = document.getElementById('search');
    const dropdown = document.getElementById('search-dropdown');
    if (!input || !dropdown) return;

    let index = null;
    let indexLoading = null;
    let focusIdx = -1;
    let visible = [];

    function loadIndex() {
      if (index) return Promise.resolve(index);
      if (indexLoading) return indexLoading;
      indexLoading = fetch('search-index.json')
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; })
        .then(function (data) { index = Array.isArray(data) ? data : []; return index; });
      return indexLoading;
    }

    function match(q, limit) {
      if (!q) return [];
      const ql = q.toLowerCase();
      const asAppId = /^\d+$/.test(q);
      const out = [];
      for (let i = 0; i < index.length && out.length < limit; i++) {
        const row = index[i];
        const id = String(row[0]);
        const title = String(row[1] || '');
        if (asAppId ? id.startsWith(q) : title.toLowerCase().indexOf(ql) !== -1) {
          // extra columns may not exist on older deployments - fall back gracefully.
          // Column 7 (releaseYear) is set only when the pipeline could resolve a
          // year and powers same-name disambiguation (Prey 2006 vs Prey 2017).
          out.push({
            appId: id,
            title: title,
            tier: row[2] || '',
            protondbCount: row[3] || 0,
            pulseCount: row[4] || 0,
            appType: row[5] || '',
            releaseYear: row[6] || null,
          });
        }
      }
      return out;
    }

    function steamHeader(appId) {
      // akamai is the primary tier; steam-img.js (window.__steamImgLoad)
      // walks cloudflare -> game-images.json -> hide on error.
      return 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/' + appId + '/header.jpg';
    }

    function render(results, query) {
      focusIdx = -1;
      visible = results;
      if (!query) {
        dropdown.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        return;
      }
      if (!results.length) {
        const devHint = index && index.length === 0
          ? '<br><code>search-index.json</code> not built yet (prod only)'
          : '';
        dropdown.innerHTML =
          '<div class="sd-empty">No matches' + devHint + '<br>' +
          '<span style="font-size:0.72rem">press Enter to open Reports</span></div>';
        dropdown.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        return;
      }
      const titleOverrides = window.__buildTitleOverrides(results);
      const html = results.map(function (r, idx) {
        const display = titleOverrides.get(idx) || r.title;
        const safe = display.replace(/[<>&]/g, function (c) {
          return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
        });
        const idStr = String(r.appId);
        const inferredStore = r.appType
          ? r.appType
          : (idStr.startsWith('gog:') ? 'gog'
            : idStr.startsWith('epic:') ? 'epic'
            : 'steam');
        const storeLabel = inferredStore === 'gog' ? 'GOG'
                         : inferredStore === 'epic' ? 'Epic'
                         : 'Steam';
        // Split chip on the trailing edge that mirrors the .game-card combo
        // corner chip (tier color on the left, store color on the right).
        // The app id is the row-two subline (replacing the old report-count
        // line) so the thumbnail flows straight into the title.
        const tierAttr = r.tier ? r.tier.toLowerCase() : '';
        const tierLabel = r.tier ? r.tier.toUpperCase() : 'NO RATING';
        const comboHtml = '<span class="sd-combo" data-tier="' + tierAttr + '" data-store="' + inferredStore + '">' +
                          '<span class="sd-combo-tier">' + tierLabel + '</span>' +
                          '<span class="sd-combo-store">' + storeLabel + '</span>' +
                          '</span>';
        return '<a href="app.html#/app/' + r.appId + '" role="option" data-idx="' + idx + '">' +
               '<img loading="lazy" data-appid="' + r.appId + '" src="' + steamHeader(r.appId) + '" alt="" ' +
                 'onerror="window.__steamImgLoad && window.__steamImgLoad(this)">' +
               '<span class="sd-meta">' +
                 '<span class="sd-title">' + safe + '</span>' +
                 '<span class="sd-appid" title="' + idStr + '">' + idStr + '</span>' +
               '</span>' +
               comboHtml +
               '</a>';
      }).join('');
      dropdown.innerHTML = html;
      dropdown.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    function setFocus(idx) {
      const items = dropdown.querySelectorAll('a');
      if (!items.length) return;
      focusIdx = (idx + items.length) % items.length;
      items.forEach(function (el, i) { el.classList.toggle('is-focused', i === focusIdx); });
      items[focusIdx].scrollIntoView({ block: 'nearest' });
    }

    let timer = null;
    input.addEventListener('input', function () {
      const q = input.value.trim();
      clearTimeout(timer);
      timer = setTimeout(function () {
        loadIndex().then(function () { render(match(q, 8), q); });
      }, 120);
    });
    input.addEventListener('focus', function () {
      const q = input.value.trim();
      if (q) loadIndex().then(function () { render(match(q, 8), q); });
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(focusIdx + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(focusIdx - 1); }
      else if (e.key === 'Escape') {
        dropdown.hidden = true; input.setAttribute('aria-expanded', 'false');
      } else if (e.key === 'Enter') {
        if (focusIdx >= 0 && visible[focusIdx]) {
          window.location.href = 'app.html#/app/' + visible[focusIdx].appId;
          return;
        }
        const q = input.value.trim();
        if (!q) return;
        if (/^\d+$/.test(q)) {
          window.location.href = 'app.html#/app/' + q;
        } else {
          window.location.href = 'app.html?q=' + encodeURIComponent(q);
        }
      }
    });
    document.addEventListener('click', function (e) {
      const wrap = input.closest('.topbar-search-wrap');
      if (wrap && !wrap.contains(e.target)) {
        dropdown.hidden = true;
        input.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // ---- 6. Auth indicator: swap signed-out link <-> signed-in chip -----

  async function checkIsAdmin(session) {
    if (!session || !session.access_token) return false;
    // SUPABASE_URL and SUPABASE_ANON_KEY are declared in supabase-client.js
    // which loads before topbar.js on every page.
    var sbUrl = (typeof SUPABASE_URL !== 'undefined') ? SUPABASE_URL : '';
    var sbKey = (typeof SUPABASE_ANON_KEY !== 'undefined') ? SUPABASE_ANON_KEY : '';
    if (!sbUrl) return false;
    try {
      const res = await fetch(
        sbUrl + '/rest/v1/admins?select=proton_pulse_user_id&limit=1',
        {
          headers: {
            apikey: sbKey,
            Authorization: 'Bearer ' + session.access_token,
            'Content-Type': 'application/json',
          },
        }
      );
      if (!res.ok) return false;
      const rows = await res.json();
      return Array.isArray(rows) && rows.length > 0;
    } catch (_) {
      return false;
    }
  }

  function wireAuthIndicator() {
    const signedOut = document.getElementById('auth-signedout');
    const signedIn  = document.getElementById('auth-signedin');
    const avatarEl  = document.getElementById('google-avatar');
    const nameEl    = document.getElementById('google-username');
    if (typeof SupaAuth === 'undefined') return; // not all pages load supabase

    SupaAuth.onStateChange(function (state) {
      const user = state && state.user;
      if (user) {
        if (signedOut) signedOut.hidden = true;
        if (signedIn)  signedIn.hidden  = false;

        // Fire-and-forget: record that this user visited the site right now.
        // Uses PATCH so it only updates existing rows (users who have opted in
        // to showing their username). No-op if no row exists yet.
        var sbUrl2 = (typeof SUPABASE_URL !== 'undefined') ? SUPABASE_URL : '';
        var sbKey2 = (typeof SUPABASE_ANON_KEY !== 'undefined') ? SUPABASE_ANON_KEY : '';
        var token2 = state.session && state.session.access_token;
        if (sbUrl2 && token2) {
          fetch(sbUrl2 + '/rest/v1/author_avatars?proton_pulse_user_id=eq.' + user.id, {
            method: 'PATCH',
            headers: { apikey: sbKey2, Authorization: 'Bearer ' + token2, 'Content-Type': 'application/json' },
            body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
          }).catch(function () {});
        }
        if (avatarEl)  avatarEl.src = (user.user_metadata && user.user_metadata.avatar_url) || '';
        if (avatarEl)  avatarEl.alt = (user.user_metadata && user.user_metadata.name) || user.email || '';
        const rawName = (user.user_metadata && user.user_metadata.name) || user.email || '';
        // Set the full name; CSS (.auth-username) handles truncation, capping it
        // on narrow viewports but showing it in full on desktop (>=1024px).
        if (nameEl) { nameEl.textContent = rawName; nameEl.title = rawName; }

        // Show/hide the pre-rendered admin nav link based on admin status.
        checkIsAdmin(state.session).then(function (admin) {
          var link = document.getElementById('topbar-admin-link');
          var mobileLink = document.getElementById('mobile-admin-link');
          if (link) link.hidden = !admin;
          if (mobileLink) mobileLink.hidden = !admin;
          if (admin && _reflowOverflow) _reflowOverflow();
        });
      } else {
        if (signedOut) signedOut.hidden = false;
        if (signedIn)  signedIn.hidden  = true;
        var adminLink = document.getElementById('topbar-admin-link');
        if (adminLink) adminLink.hidden = true;
        var mobileAdminLink = document.getElementById('mobile-admin-link');
        if (mobileAdminLink) mobileAdminLink.hidden = true;
      }
    });
  }

  // ---- 7. Boot ---------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }

  // ---- 8. Service worker (cache-first image cache) --------------------
  // Registered from a plain script tag (no build step). sw.js resolves relative
  // to the page, so it works at the prod root and under the /proton-pulse-web*
  // staging subpath alike. Only caches cover images; see sw.js.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        console.debug('[sw] registered', { scope: reg.scope, source: 'topbar' });
      }).catch(function (err) {
        console.debug('[sw] registration failed', { error: String(err), source: 'topbar' });
      });
    });

    // Cache analytics: ask the worker for its hit/miss counters when the page is
    // hidden and report one aggregate event (via ppTrack -> site_events) so the
    // admin tab can chart the image cache hit rate. The worker resets counters on
    // read, so each report is a delta and totals never double-count.
    var reportSwStats = function () {
      var sw = navigator.serviceWorker.controller;
      if (!sw) return; // no active worker controlling this page yet
      try {
        var ch = new MessageChannel();
        ch.port1.onmessage = function (e) {
          var d = e.data || {};
          var total = (d.hits || 0) + (d.misses || 0);
          if (!total) return; // nothing happened since the last report
          if (window.ppTrack) {
            window.ppTrack('sw_cache', {
              hits: d.hits || 0,
              misses: d.misses || 0,
              hit_rate: Math.round((d.hits || 0) / total * 100),
            });
          }
        };
        sw.postMessage({ type: 'pp-sw-stats' }, [ch.port2]);
      } catch (err) {
        console.debug('[sw] stats report failed', { error: String(err), source: 'topbar' });
      }
    };
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') reportSwStats();
    });
  }
})();
