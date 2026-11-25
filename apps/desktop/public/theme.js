// Sets data-theme on <html> before the first paint: the stored choice (`octo.theme`, written by the UI) when it
// is a known theme, otherwise the system theme, which it then follows. The UI takes over afterwards.
(function () {
  var root = document.documentElement;
  function stored() {
    try {
      var v = window.localStorage.getItem("octo.theme");
      return v === "light" || v === "dark" || v === "cursor" || v === "claude" || v === "codex" || v === "opencode" ? v : null;
    } catch (e) {
      return null;
    }
  }
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  function apply() {
    root.setAttribute("data-theme", stored() || (mq && mq.matches ? "light" : "dark"));
  }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener("change", apply);
})();
