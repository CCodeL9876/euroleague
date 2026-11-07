// Basketball: seitlich wischen wechselt den Wettbewerb (EuroLeague ↔ SB League ↔ 2. Liga), zusätzlich zum Umschalter oben.
// Nach links wischen = nächster Wettbewerb, nach rechts = vorheriger. Nicht in Bereichen, die selbst seitlich scrollen
// (Live-Tafeln, Tageslisten, breite Tabellen), nicht in offenen Dialogen und nicht vom Bildschirmrand aus.
(() => {
  const ORDER = [['euroleague', 'EuroLeague'], ['sbl', 'SB League'], ['2liga', '2. Liga']];
  const here = (/\/basketball\/(euroleague|sbl|2liga)\/?(index\.html)?$/.exec(location.pathname) || [])[1];
  const idx = ORDER.findIndex((x) => x[0] === here);
  if (idx < 0 || !('ontouchstart' in window)) return;

  const EDGE = 24, LOCK = 12, GO = 80;
  let sx = 0, sy = 0, dx = 0, axis = '', target = null, page = null, hint = null;

  // Liegt der Startpunkt in etwas, das selbst seitlich scrollt (oder bewusst nicht wischen soll)?
  const ownScroll = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.matches?.('input, textarea, select, dialog, .mtabs, .bb-switch, .ms-tabs')) return true;
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 2) return true;
    }
    return false;
  };
  const showHint = (t, dir) => {
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'bb-swipe-hint';
      document.body.appendChild(hint);
    }
    hint.textContent = dir > 0 ? `${t[1]} ›` : `‹ ${t[1]}`;
    hint.dataset.side = dir > 0 ? 'right' : 'left';
  };
  const reset = (animate = true) => {
    if (page) { page.style.transition = animate ? 'transform .2s ease' : ''; page.style.transform = ''; }
    hint?.remove(); hint = null;
    axis = ''; target = null; dx = 0;
  };

  document.addEventListener('touchstart', (e) => {
    reset(false);
    if (e.touches.length !== 1 || document.querySelector('dialog[open]')) { axis = 'none'; return; }
    const t = e.touches[0];
    if (t.clientX < EDGE || t.clientX > innerWidth - EDGE || ownScroll(e.target)) { axis = 'none'; return; }
    sx = t.clientX; sy = t.clientY;
    page = document.querySelector('.app, .rg');
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (axis === 'none' || e.touches.length !== 1) return;
    const t = e.touches[0];
    dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (!axis) {
      if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
      axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'x' : 'none';
      if (axis === 'x') {
        const dir = dx < 0 ? 1 : -1;
        target = ORDER[idx + dir] || null;
        if (target) showHint(target, dir);
      }
    }
    if (axis !== 'x') return;
    // Ohne Nachbar (am Anfang/Ende): nur leicht nachgeben
    const k = target ? 0.35 : 0.12;
    if (page) { page.style.transition = ''; page.style.transform = `translateX(${dx * k}px)`; }
    hint?.classList.toggle('ready', Math.abs(dx) > GO);
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (axis === 'x' && target && Math.abs(dx) > GO) {
      const url = `../${target[0]}/`;
      if (page) { page.style.transition = 'transform .15s ease, opacity .15s ease'; page.style.transform = `translateX(${dx < 0 ? -40 : 40}px)`; page.style.opacity = '0.4'; }
      location.href = url;
      return;
    }
    reset();
  }, { passive: true });
  document.addEventListener('touchcancel', () => reset(), { passive: true });
  // Zurück aus dem Verlauf (Seite aus dem Zwischenspeicher): Verschiebung zurücksetzen
  addEventListener('pageshow', () => { if (page) { page.style.opacity = ''; } reset(false); });
})();
