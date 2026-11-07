// Hell/Dunkel vor dem ersten Zeichnen setzen (gespeicherte Wahl; ohne Wahl folgt die Seite dem iPhone) – kein Aufflackern
try {
  var t = localStorage.getItem('el-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) { /* privates Fenster */ }

// Abstand zum Home-Balken: In der Home-App des iPhones kennt die Seite ihn nach einem Seitenwechsel erst einen Moment später,
// die Leiste unten würde dann nach oben springen. Darum der zuletzt gemessene Wert (Hochformat) als Startwert (--sab).
try {
  var sab = localStorage.getItem('el-sab');
  if (sab) document.documentElement.style.setProperty('--sab', sab + 'px');
  addEventListener('load', function () {
    setTimeout(function () {
      if (innerHeight <= innerWidth) return;
      var p = document.createElement('div');
      p.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom, 0px)';
      document.body.appendChild(p);
      var v = parseFloat(getComputedStyle(p).paddingBottom) || 0;
      p.remove();
      if (v > 0) localStorage.setItem('el-sab', String(v));
    }, 1000);
  });
} catch (e) { /* privates Fenster */ }
