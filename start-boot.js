// Start der App. Alte Direktlinks zu Spielen und Teams gehören jetzt zur EuroLeague. Wer unter Ich eine andere Startseite gewählt
// hat (pro Gerät), landet beim ersten Öffnen einer Sitzung dort; danach bleibt «Heute» hier erreichbar.
try {
  var q = new URLSearchParams(location.search);
  if (['game', 'team', 'fav', 'data', 'install'].some(function (k) { return q.has(k); })) location.replace('basketball/euroleague/' + location.search + location.hash);
  else {
    var target = { basketball: 'basketball/euroleague/', fussball: 'fussball/' }[localStorage.getItem('el-start')];
    var first = !sessionStorage.getItem('el-started');
    sessionStorage.setItem('el-started', '1');
    if (target && first && !location.search && !location.hash && localStorage.getItem('el-gate-ok') === '1' && localStorage.getItem('el-profile-name')) location.replace(target);
  }
} catch (e) { /* privates Fenster */ }
