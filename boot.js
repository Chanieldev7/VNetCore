/* Runs in <head>, before the first paint, so the page does not visibly change
   when app.js starts: the saved theme is applied immediately, and on small
   screens the side panels app.js will collapse are hidden from the start. */
(function boot() {
  "use strict";
  const root = document.documentElement;
  try {
    if (localStorage.getItem("vnetcore.theme.v1") === "light") {
      root.dataset.theme = "light";
    }
    const saved =
      localStorage.getItem("vnetcore.workspace.v1") ||
      localStorage.getItem("vnetcore.project.v9") ||
      "";
    if (
      window.matchMedia?.("(max-width: 980px)").matches &&
      saved.includes('"devices":[{')
    ) {
      root.classList.add("collapse-panels");
    }
  } catch {
    // Storage can be unavailable; app.js handles that case on its own.
  }
})();
