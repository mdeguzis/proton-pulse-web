// #428: Jump-to-section dropdown on about.html. Mirrors profile.html's
// jumpSelect pattern -- change fires a smooth scrollIntoView on the picked
// anchor, then resets the select back to the placeholder so the label
// reads as an action ("Jump to: Section...") instead of a stale state.
(() => {
  const jumpSelect = document.getElementById('about-jump-select');
  if (!jumpSelect) return;
  const jumpTo = (id) => {
    if (!id) return;
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  jumpSelect.addEventListener('change', () => {
    const id = jumpSelect.value;
    jumpTo(id);
    jumpSelect.value = '';
  });
  // Honor a direct #section hash on load so links from elsewhere land on
  // the right section past the fixed topbar (scroll-margin-top handles
  // the offset).
  if (window.location.hash) {
    const id = window.location.hash.slice(1);
    if (document.getElementById(id)) {
      // One-shot after render so the topbar height is measured correctly.
      setTimeout(() => jumpTo(id), 50);
    }
  }
})();
