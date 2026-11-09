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

// Leiste unten (alle Bereiche: .mtabs, .fb-tabs, .ms-tabs) erst zeigen, wenn ihre Position ruht. In der Home-App des iPhones
// kommt der Abstand zum Home-Balken nach einem Seitenwechsel manchmal erst später; ohne Warten stünde die Leiste je nach Seite
// kurz oder dauerhaft anders hoch. Gleiche Regel auf jeder Seite: 3 gleiche Messungen, harte Grenze 1,5 s.
try {
  var root = document.documentElement;
  root.classList.add('bar-wait');
  var shown = false;
  // Home-App (iPhone): nach dem Laden einmal 1 px scrollen und zurück – wie ein kurzes Ziehen. iOS berechnet dabei die Lage der
  // fixierten Leiste neu; ohne das blieb sie nach einem Neuladen manchmal zu hoch stehen, bis man die Seite zog.
  var nudge = function () {
    try {
      if (!(navigator.standalone === true || matchMedia('(display-mode: standalone)').matches)) return;
      var y = window.scrollY;
      window.scrollTo(0, y + 1);
      requestAnimationFrame(function () { window.scrollTo(0, y); });
    } catch (e) { /* ohne Nachhilfe */ }
  };
  var reveal = function () { if (!shown) { shown = true; root.classList.remove('bar-wait'); nudge(); setTimeout(nudge, 400); } };
  setTimeout(reveal, 1600);
  document.addEventListener('DOMContentLoaded', function () {
    var start = Date.now(), last = -1, same = 0;
    var standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    var probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom, 0px)';
    document.body.appendChild(probe);
    var fontsReady = false;
    try { Promise.race([document.fonts.ready, new Promise(function (r) { setTimeout(r, 250); })]).then(function () { fontsReady = true; }); } catch (e) { fontsReady = true; }
    (function wait() {
      var el = Date.now() - start;
      var nav = document.querySelector('.mtabs, .fb-tabs, .ms-tabs');
      var y = nav ? nav.getBoundingClientRect().top : -1;
      var visible = nav && nav.offsetHeight > 0;
      same = y === last ? same + 1 : 0;
      last = y;
      var inset = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
      // Ohne sichtbare Leiste (Desktop, Zugangsseite) ebenfalls weiter warten, bis 1,5 s um sind
      if (el < 1500 && (!fontsReady || !visible || same < 3 || (standalone && inset === 0 && el < 1200))) { setTimeout(wait, 60); return; }
      probe.remove();
      reveal();
    })();
  });
} catch (e) { /* ohne Warten */ }
