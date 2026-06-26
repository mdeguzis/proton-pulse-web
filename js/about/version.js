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
      // Render in viewer's local timezone with ISO-style precision
      // (YYYY-MM-DD HH:mm:ss) plus the local zone abbreviation, so the value
      // is unambiguous when comparing against pipeline run timestamps.
      let deployed = '';
      if (data.deployed_at) {
        const d = new Date(data.deployed_at);
        if (!isNaN(d.getTime())) {
          const pad = n => String(n).padStart(2, '0');
          const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
          const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          const tzParts = d.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ');
          const tz = tzParts.length > 1 ? tzParts.pop() : '';
          deployed = `${ymd} ${hms}${tz ? ' ' + tz : ''}`;
        }
      }
      const shaUrl = `https://github.com/${repo}/commit/${sha}`;
      el.innerHTML = `v${ver} &middot; <a href="${shaUrl}" target="_blank" rel="noopener" style="font-family:var(--mono);color:var(--muted)">${sha}</a>${deployed ? ' &middot; deployed ' + deployed : ''}`;
    });
}
