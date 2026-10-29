// Hell/Dunkel vor dem ersten Zeichnen setzen (gespeicherte Wahl; ohne Wahl gilt das dunkle Glas-Design) – kein Aufflackern
try {
  var t = localStorage.getItem('el-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) { /* privates Fenster */ }
