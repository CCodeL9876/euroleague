// Startseite der App (Einstellung unter «Mein Sport» → Ich, pro Gerät): nur beim ersten Öffnen einer Sitzung weiterleiten,
// damit der Tab «Basketball» danach hier bleibt. Direktlinks (?key=, ?game= …) und Anmeldung bleiben unberührt.
try {
  var target = { meinsport: 'meinsport/', fussball: 'fussball/' }[localStorage.getItem('el-start')];
  var first = !sessionStorage.getItem('el-started');
  sessionStorage.setItem('el-started', '1');
  if (target && first && !location.search && !location.hash && localStorage.getItem('el-gate-ok') === '1' && localStorage.getItem('el-profile-name')) location.replace(target);
} catch (e) { /* privates Fenster */ }
