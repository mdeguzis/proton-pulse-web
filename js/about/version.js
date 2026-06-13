const el = document.getElementById('site-version');
if (el) {
  fetch('version.json?_=' + Date.now())
    .then(r => r.ok ? r.json() : null)
    .catch(() => null)
    .then(data => {
      if (!data) { el.textContent = 'version unknown'; return; }
      const sha = data.sha || '';
      const ver = data.version || '?';
      const repo = data.repo || 'mdeguzis/proton-pulse-web';
      const date = data.deployed_at ? new Date(data.deployed_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      const shaUrl = `https://github.com/${repo}/commit/${sha}`;
      el.innerHTML = `v${ver} &middot; <a href="${shaUrl}" target="_blank" rel="noopener" style="font-family:var(--mono);color:var(--muted)">${sha}</a>${date ? ' &middot; deployed ' + date : ''}`;
    });
}
