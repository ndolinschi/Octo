// Sets data-theme on <html> before the first paint (same rule as the desktop host's inline script, which the web app's
// Content-Security-Policy would block: scripts come only from files here). The stored choice (`octo.theme`) when it is
// "light" or "dark", otherwise the system theme, which it then follows. The UI takes over afterwards.
(function () {
  var root = document.documentElement;
  function stored() {
    try {
      var v = window.localStorage.getItem("octo.theme");
      return v === "light" || v === "dark" ? v : null;
    } catch (e) {
      return null;
    }
  }
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  function apply() {
    var theme = stored() || (mq && mq.matches ? "light" : "dark");
    root.setAttribute("data-theme", theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#ececec" : "#0a0a0a");
  }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener("change", apply);
})();
